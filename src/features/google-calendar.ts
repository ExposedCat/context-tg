import { JWT, OAuth2Client } from "google-auth-library";
import { APP_ENV } from "./env.ts";

export type CalendarMetadata = {
  id: string;
  summary: string;
  timeZone: string;
  etag?: string;
  description?: string;
  location?: string;
  conferenceProperties?: { allowedConferenceSolutionTypes?: string[] };
};

export type CalendarTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};
export type CalendarAttendee = {
  email?: string;
  self?: boolean;
  responseStatus?: string;
  comment?: string;
  [key: string]: unknown;
};

export type CalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  created?: string;
  etag?: string;
  organizer?: { self?: boolean; email?: string };
  creator?: { email?: string };
  attendees?: CalendarAttendee[];
  recurrence?: string[];
  recurringEventId?: string;
  start?: CalendarTime;
  end?: CalendarTime;
  originalStartTime?: CalendarTime;
  updated?: string;
  iCalUID?: string;
  transparency?: string;
  visibility?: string;
  eventType?: string;
  reminders?: {
    useDefault?: boolean;
    overrides?: { method: string; minutes: number }[];
  };
  extendedProperties?: {
    private?: Record<string, string>;
    shared?: Record<string, string>;
  };
  conferenceData?: Record<string, unknown>;
  [key: string]: unknown;
  htmlLink?: string;
};

export type CalendarEventsPage = {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

// No impersonation or Cloud-wide scopes. The calendar owner must explicitly
// share the calendar with this identity. The full Calendar scope enables calendar administration, subject to Google ACLs.
export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"];

export type CalendarRequestOptions = {
  method?: "GET" | "POST" | "PATCH";
  query?: Record<string, string | string[]>;
  body?: Record<string, unknown>;
  etag?: string;
  signal?: AbortSignal;
};

export class CalendarApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

export class GoogleCalendarApi {
  private readonly auth: JWT | OAuth2Client;
  readonly authKind: "service_account" | "oauth";

  constructor(
    readonly email: string,
    credential: string | OAuth2Client,
  ) {
    this.authKind =
      typeof credential === "string" ? "service_account" : "oauth";
    this.auth =
      typeof credential === "string"
        ? new JWT({
            email,
            key: credential,
            scopes: CALENDAR_SCOPES,
            transporterOptions: {
              timeout: 15_000,
              retry: false,
              fetchImplementation: (...args) => fetch(...args),
            },
          })
        : credential;
  }

  async request<T>(
    calendarId: string,
    resource = "",
    options: CalendarRequestOptions = {},
  ): Promise<T> {
    if (
      [".", ".."].includes(calendarId) ||
      resource
        .split("/")
        .some((part) => [".", ".."].includes(decodeURIComponent(part)))
    )
      throw new Error("Unsupported Calendar resource.");
    if (resource && !/^\/(?:events|acl)(?:\/[^/?#]+){0,2}$/.test(resource))
      throw new Error("Unsupported Calendar resource.");
    return this.send<T>(
      `/calendars/${encodeURIComponent(calendarId)}${resource}`,
      options,
    );
  }

  async requestGlobal<T>(
    resource: "/freeBusy" | "/colors" | "/calendars",
    options: CalendarRequestOptions = {},
  ): Promise<T> {
    if (!["/freeBusy", "/colors", "/calendars"].includes(resource))
      throw new Error("Unsupported Calendar resource.");
    return this.send<T>(resource, options);
  }

  private async send<T>(
    resource: string,
    options: CalendarRequestOptions,
  ): Promise<T> {
    if (!["GET", "POST", "PATCH"].includes(options.method ?? "GET"))
      throw new Error("Deletion is not supported.");
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    const token = await this.accessToken(signal);
    const url = new URL(`https://www.googleapis.com/calendar/v3${resource}`);
    for (const [key, value] of Object.entries(options.query ?? {}))
      for (const item of Array.isArray(value) ? value : [value])
        url.searchParams.append(key, item);
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.etag ? { "If-Match": options.etag } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; errors?: { reason?: string }[] };
      };
      const reason = detail.error?.errors?.[0]?.reason;
      if (reason === "forbiddenForServiceAccounts")
        throw new CalendarApiError(
          "Google does not allow this attendee operation for a service account without domain-wide delegation.",
          response.status,
          reason,
        );
      if (reason === "forbiddenForNonOrganizer")
        throw new CalendarApiError(
          "Only the event organizer can change these fields.",
          response.status,
          reason,
        );
      if (
        [400, 403, 409, 422, 429].includes(response.status) &&
        reason &&
        detail.error?.message
      )
        throw new CalendarApiError(
          `Google Calendar could not complete this action (${reason}): ${detail.error.message.slice(0, 500)}`,
          response.status,
          reason,
        );
      if (response.status === 403 || response.status === 404)
        throw new CalendarApiError(
          `Calendar unavailable. Share it with ${this.email} with Make changes to events permission, and check the Calendar ID.`,
          response.status,
          reason,
        );
      if (response.status === 412)
        throw new CalendarApiError(
          "The event changed. Read it again before retrying the edit.",
          response.status,
          reason,
        );
      throw new CalendarApiError(
        `Google Calendar request failed (HTTP ${response.status}). Do not automatically retry event creation; check whether it succeeded first.`,
        response.status,
        reason,
      );
    }
    return (await response.json()) as T;
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    try {
      const { token } = await this.auth.getAccessToken();
      signal?.throwIfAborted();
      if (!token) throw new Error("Missing token");
      return token;
    } catch {
      signal?.throwIfAborted();
      throw new Error(
        "Google Calendar authentication failed. The bot administrator must check the credential or reconnect its Google account.",
      );
    }
  }

  async metadata(calendarId: string, signal?: AbortSignal) {
    return this.request<CalendarMetadata>(calendarId, "", { signal });
  }

  async assertWritable(
    calendarId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.authKind === "oauth") {
      // CalendarList.accessRole reports the effective role, including ownership
      // and inherited access. OAuth users need not have an explicit self ACL.
      const token = await this.accessToken(signal);
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.any([
            AbortSignal.timeout(30_000),
            ...(signal ? [signal] : []),
          ]),
          redirect: "error",
        },
      );
      if (response.ok) {
        const item = (await response.json()) as { accessRole?: string };
        if (item.accessRole === "writer" || item.accessRole === "owner") return;
      } else if (response.status !== 404)
        throw new Error(
          "Cannot confirm Google Calendar editing access. Check the bot account's sharing permissions.",
        );
      // A newly shared calendar may not yet be in CalendarList. Its explicit
      // direct share can still be checked through ACL, without subscribing it.
    }
    let pageToken: string | undefined;
    do {
      const page = await this.request<{
        items?: { scope?: { type?: string; value?: string }; role?: string }[];
        nextPageToken?: string;
      }>(calendarId, "/acl", {
        signal,
        query: { maxResults: "250", ...(pageToken ? { pageToken } : {}) },
      });
      if (
        page.items?.some(
          (rule) =>
            rule.scope?.type === "user" &&
            rule.scope.value?.toLowerCase() === this.email.toLowerCase() &&
            (rule.role === "writer" || rule.role === "owner"),
        )
      )
        return;
      pageToken = page.nextPageToken;
    } while (pageToken);
    throw new Error(
      `Share the calendar directly with ${this.email} with Make changes to events permission.`,
    );
  }
}

export function createGoogleCalendarApi(value: unknown): GoogleCalendarApi {
  if (!value || typeof value !== "object")
    throw new Error("Invalid Google Calendar credential JSON.");
  const credential = value as Record<string, unknown>;
  const has = (keys: string[]) =>
    keys.every(
      (key) => typeof credential[key] === "string" && Boolean(credential[key]),
    );
  if (
    credential.type === "service_account" &&
    has(["client_email", "private_key"])
  )
    return new GoogleCalendarApi(
      credential.client_email as string,
      credential.private_key as string,
    );
  if (
    credential.type === "authorized_user" &&
    has(["client_id", "client_secret", "refresh_token", "account_email"])
  ) {
    const auth = new OAuth2Client({
      clientId: credential.client_id as string,
      clientSecret: credential.client_secret as string,
      credentials: { refresh_token: credential.refresh_token as string },
      transporterOptions: {
        timeout: 15_000,
        retry: false,
        fetchImplementation: (...args) => fetch(...args),
      },
    });
    return new GoogleCalendarApi(credential.account_email as string, auth);
  }
  throw new Error(
    "Invalid Google Calendar credential JSON. Expected a service account or an authorized OAuth account.",
  );
}

let configuredApi: Promise<GoogleCalendarApi> | undefined;

export function getGoogleCalendarApi(): Promise<GoogleCalendarApi> {
  const credentialPath = APP_ENV.GOOGLE_CALENDAR_CREDENTIALS;
  if (!credentialPath)
    throw new Error(
      "Google Calendar is not configured. Ask the bot administrator to install its credential JSON.",
    );
  configuredApi ??= (async () => {
    let credentials: unknown;
    try {
      credentials = await Bun.file(credentialPath).json();
    } catch {
      throw new Error("Cannot read the Google Calendar credential JSON.");
    }
    return createGoogleCalendarApi(credentials);
  })().catch((error) => {
    configuredApi = undefined;
    throw error;
  });
  return configuredApi;
}

export function calendarDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) =>
    parts.find((value) => value.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
