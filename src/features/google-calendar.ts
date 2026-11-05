import { JWT } from "google-auth-library";
import { APP_ENV } from "./env.ts";

export type CalendarMetadata = {
  id: string;
  summary: string;
  timeZone: string;
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
  attendees?: unknown[];
  recurrence?: string[];
  recurringEventId?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  htmlLink?: string;
};

export type CalendarEventsPage = {
  items?: CalendarEvent[];
  nextPageToken?: string;
};

// No impersonation or Cloud-wide scopes. The calendar owner must explicitly
// share the calendar with this identity. ACL access is read-only for setup.
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendars.readonly",
  "https://www.googleapis.com/auth/calendar.acls.readonly",
];

export class GoogleCalendarApi {
  private readonly auth: JWT;

  constructor(
    readonly email: string,
    privateKey: string,
  ) {
    this.auth = new JWT({
      email,
      key: privateKey,
      scopes: CALENDAR_SCOPES,
      transporterOptions: {
        timeout: 15_000,
        retry: false,
        fetchImplementation: (...args) => fetch(...args),
      },
    });
  }

  async request<T>(
    calendarId: string,
    resource = "",
    options: {
      method?: "GET" | "POST" | "PATCH";
      query?: Record<string, string>;
      body?: Record<string, unknown>;
      etag?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    let token: string | null | undefined;
    try {
      ({ token } = await this.auth.getAccessToken());
    } catch {
      signal.throwIfAborted();
      // Google's auth errors may contain request bodies and signed assertions.
      throw new Error(
        "Google Calendar authentication failed. Check the service-account credential.",
      );
    }
    signal.throwIfAborted();
    if (!token)
      throw new Error("Google Calendar did not return an access token.");
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}${resource}`,
    );
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, value);
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
      await response.body?.cancel();
      if (response.status === 403 || response.status === 404)
        throw new Error(
          `Calendar unavailable. Share it with ${this.email} with Make changes to events permission, and check the Calendar ID.`,
        );
      if (response.status === 412)
        throw new Error(
          "The event changed. Read it again before retrying the edit.",
        );
      throw new Error(
        `Google Calendar request failed (HTTP ${response.status}). Do not automatically retry event creation; check whether it succeeded first.`,
      );
    }
    return (await response.json()) as T;
  }

  async metadata(calendarId: string, signal?: AbortSignal) {
    return this.request<CalendarMetadata>(calendarId, "", { signal });
  }

  async assertWritable(
    calendarId: string,
    signal?: AbortSignal,
  ): Promise<void> {
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

let configuredApi: Promise<GoogleCalendarApi> | undefined;

export function getGoogleCalendarApi(): Promise<GoogleCalendarApi> {
  const credentialPath = APP_ENV.GOOGLE_CALENDAR_CREDENTIALS;
  if (!credentialPath)
    throw new Error(
      "Google Calendar is not configured. Ask the bot administrator to install the service-account JSON credential.",
    );
  configuredApi ??= (async () => {
    let credentials: Record<string, unknown>;
    try {
      credentials = await Bun.file(credentialPath).json();
      if (
        credentials.type !== "service_account" ||
        typeof credentials.client_email !== "string" ||
        typeof credentials.private_key !== "string"
      )
        throw new Error("Invalid credential");
    } catch {
      throw new Error(
        "Cannot read the Google Calendar service-account JSON credential.",
      );
    }
    return new GoogleCalendarApi(
      credentials.client_email as string,
      credentials.private_key as string,
    );
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
