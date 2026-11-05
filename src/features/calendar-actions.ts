import { rrulestr } from "rrule";
import {
  CALENDAR_FIELDS,
  type CalendarOperation,
  EVENT_FIELDS,
} from "./calendar-schema.ts";
import {
  type CalendarApi,
  type ChatCalendarTable,
  getChatCalendars,
  linkChatCalendar,
  unlinkChatCalendar,
} from "./calendar-settings.ts";
import {
  archiveCalendarEvent,
  getCalendarEventArchive,
} from "./calendar-storage.ts";
import { unwatchCalendar, watchCalendar } from "./calendar-watch.ts";
import type { Database } from "./database.ts";
import type {
  CalendarEvent,
  CalendarEventsPage,
  CalendarTime,
} from "./google-calendar.ts";
import type { LlmToolContext } from "./llm-tools/types.ts";

export type CalendarActionContext = {
  database: Database;
  context: LlmToolContext;
  api: CalendarApi;
  signal?: AbortSignal;
  authorize: (calendarId?: string) => Promise<ChatCalendarTable>;
};

export function calendarTimestamp(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error(
      "Use an RFC3339 date and time with an explicit UTC offset.",
    );
  if (
    new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
    value.slice(0, 10)
  )
    throw new Error("Invalid calendar date.");
  return Date.parse(value);
}

function validateZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    throw new Error("Invalid calendar time zone.");
  }
}

function validateTimes(
  start: CalendarTime | undefined,
  end: CalendarTime | undefined,
  zone: string,
) {
  if (
    !start ||
    !end ||
    Boolean(start.date) !== Boolean(end.date) ||
    (!start.date && !start.dateTime) ||
    (!end.date && !end.dateTime)
  )
    throw new Error(
      "Start and end must both be all-day dates or both timed values.",
    );
  for (const time of [start, end]) {
    if (
      time.date &&
      (!Number.isFinite(Date.parse(time.date)) ||
        new Date(time.date).toISOString().slice(0, 10) !== time.date)
    )
      throw new Error("Invalid all-day date.");
    if (time.dateTime) calendarTimestamp(time.dateTime);
    validateZone(time.timeZone ?? zone);
  }
  if (
    Date.parse(end.date ?? end.dateTime ?? "") <=
    Date.parse(start.date ?? start.dateTime ?? "")
  )
    throw new Error(
      "The event must end after it starts. All-day end dates are exclusive.",
    );
}

function eventBody(
  args: Record<string, unknown>,
  binding: ChatCalendarTable,
  current?: CalendarEvent,
) {
  const body: Record<string, unknown> = {};
  for (const field of Object.keys(EVENT_FIELDS))
    if (args[field] !== undefined) body[field] = structuredClone(args[field]);
  if (
    typeof body.summary === "string" &&
    body.summary.startsWith("Telegram Integration #")
  )
    throw new Error(
      "Verification events must be created manually by the person linking the calendar.",
    );
  if (body.eventType !== undefined && current) {
    if (body.eventType !== (current.eventType ?? "default"))
      throw new Error("An event's type cannot be changed after creation.");
    delete body.eventType;
  }
  if (body.recurrence !== undefined) {
    if (current?.recurringEventId)
      throw new Error(
        "Change recurrence on the recurring master with scope=series, not an individual occurrence.",
      );
    const rules = body.recurrence as string[];
    if (
      rules.some(
        (rule) =>
          /[\r\n]/.test(rule) ||
          !/^(?:RRULE:|EXRULE:|RDATE(?:;[^:\r\n]+)?:|EXDATE(?:;[^:\r\n]+)?:)/.test(
            rule,
          ),
      )
    )
      throw new Error(
        "Use RFC5545 recurrence lines without DTSTART, DTEND or embedded line breaks.",
      );
    if (
      rules.some(
        (rule) =>
          /(?:^|;)COUNT=/.test(rule.replace(/^RRULE:/, "")) &&
          /(?:^|;)UNTIL=/.test(rule.replace(/^RRULE:/, "")),
      )
    )
      throw new Error("A recurrence rule cannot contain both COUNT and UNTIL.");
    try {
      if (rules.length) rrulestr(rules.join("\n"), { forceset: true });
    } catch {
      throw new Error("Invalid RFC5545 recurrence rule.");
    }
    // Google needs an explicit named time zone to expand timed recurrences over DST.
    if (rules.length)
      for (const field of ["start", "end"] as const) {
        const time = (body[field] ?? current?.[field]) as
          | CalendarTime
          | undefined;
        if (time?.dateTime)
          body[field] = {
            ...time,
            timeZone: time.timeZone ?? binding.time_zone,
          };
      }
  }
  for (const field of ["start", "end"] as const) {
    const time = body[field] as CalendarTime | undefined;
    if (time?.dateTime)
      body[field] = {
        ...time,
        timeZone:
          time.timeZone ?? current?.[field]?.timeZone ?? binding.time_zone,
      };
  }
  if (!current || body.start || body.end || body.recurrence !== undefined)
    validateTimes(
      (body.start ?? current?.start) as CalendarTime,
      (body.end ?? current?.end) as CalendarTime,
      binding.time_zone,
    );
  const reminders = body.reminders as CalendarEvent["reminders"];
  if (reminders?.useDefault && reminders.overrides?.length)
    throw new Error("Custom reminders require useDefault=false.");
  if (args.addGoogleMeet)
    body.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  return body;
}

const eventResource = (id: string) => `/events/${encodeURIComponent(id)}`;
const writeQuery = (
  args: Record<string, unknown>,
  body: Record<string, unknown> = args,
) => ({
  supportsAttachments: "true",
  conferenceDataVersion: "1",
  ...(body.eventLabelId !== undefined ? { eventLabelVersion: "1" } : {}),
  sendUpdates: String(args.sendUpdates ?? "all"),
});
function version(event: CalendarEvent) {
  if (!event.etag)
    throw new Error(
      "Cannot safely edit an event without its version. Read it again.",
    );
  return event.etag;
}

async function readEvent(
  action: CalendarActionContext,
  binding: ChatCalendarTable,
  id: string,
) {
  return action.api.request<CalendarEvent>(
    binding.calendar_id,
    eventResource(id),
    { signal: action.signal },
  );
}

async function targetEvent(
  action: CalendarActionContext,
  binding: ChatCalendarTable,
  id: string,
  scope?: string,
) {
  const event = await readEvent(action, binding, id);
  if (scope === "series" && event.recurringEventId)
    return readEvent(action, binding, event.recurringEventId);
  if (event.recurrence?.length && scope !== "series")
    throw new Error(
      "This ID is a recurring master. Specify scope=series or use an occurrence ID from list_instances.",
    );
  return event;
}

async function createEvent(
  action: CalendarActionContext,
  binding: ChatCalendarTable,
  args: Record<string, unknown>,
  importing = false,
) {
  const body = eventBody(args, binding);
  const id = crypto.randomUUID().replaceAll("-", "");
  if (importing) {
    body.iCalUID = args.iCalUID;
    if (body.eventType && body.eventType !== "default")
      throw new Error("Only default events can be imported.");
  } else body.id = id;
  await action.authorize(binding.calendar_id);
  try {
    return await action.api.request<CalendarEvent>(
      binding.calendar_id,
      importing ? "/events/import" : "/events",
      {
        method: "POST",
        body,
        signal: action.signal,
        query: importing
          ? {
              supportsAttachments: "true",
              conferenceDataVersion: "1",
              ...(body.eventLabelId !== undefined
                ? { eventLabelVersion: "1" }
                : {}),
            }
          : writeQuery(args),
      },
    );
  } catch (error) {
    action.signal?.throwIfAborted();
    throw new Error(
      `${error instanceof Error ? error.message : "Event creation failed."} ${importing ? `Before retrying, search for iCalUID ${String(args.iCalUID)}.` : `Before retrying, get_event with recovery event ID ${id} to check whether creation succeeded.`}`,
    );
  }
}

async function patchEvent(
  action: CalendarActionContext,
  binding: ChatCalendarTable,
  event: CalendarEvent,
  body: Record<string, unknown>,
  args: Record<string, unknown>,
) {
  await action.authorize(binding.calendar_id);
  return action.api.request<CalendarEvent>(
    binding.calendar_id,
    eventResource(event.id),
    {
      method: "PATCH",
      body,
      etag: version(event),
      signal: action.signal,
      query: writeQuery(args, body),
    },
  );
}

async function followingBoundary(
  action: CalendarActionContext,
  binding: ChatCalendarTable,
  instanceId: string,
) {
  const instance = await readEvent(action, binding, instanceId);
  if (!instance.recurringEventId || !instance.originalStartTime)
    throw new Error(
      "Choose an instance ID from list_instances to change this and following occurrences.",
    );
  const parent = await readEvent(action, binding, instance.recurringEventId);
  if (
    parent.recurrence?.length !== 1 ||
    !parent.recurrence[0].startsWith("RRULE:")
  )
    throw new Error(
      "This series has a complex recurrence set. Use whole-series edits or individual occurrences to preserve its exceptions.",
    );
  const boundary =
    instance.originalStartTime.dateTime ??
    `${instance.originalStartTime.date}T00:00:00Z`;
  const boundaryMs = Date.parse(boundary);
  if (!Number.isFinite(boundaryMs))
    throw new Error("Google did not return a valid original occurrence time.");
  // Reject modified future exceptions rather than silently losing their changes.
  let token: string | undefined;
  let scannedPages = 0;
  const priorIds = new Set<string>();
  do {
    if (++scannedPages > 20)
      throw new Error(
        "This calendar has too many events to split safely. Use a whole-series edit.",
      );
    const page: CalendarEventsPage =
      await action.api.request<CalendarEventsPage>(
        binding.calendar_id,
        "/events",
        {
          signal: action.signal,
          query: {
            singleEvents: "false",
            showDeleted: "true",
            maxResults: "2500",
            ...(token ? { pageToken: token } : {}),
          },
        },
      );
    for (const event of page.items ?? []) {
      if (event.recurringEventId !== parent.id || event.id === instance.id)
        continue;
      const original =
        event.originalStartTime?.dateTime ?? event.originalStartTime?.date;
      if (
        !original ||
        !Number.isFinite(Date.parse(original)) ||
        Date.parse(original) >= boundaryMs
      )
        throw new Error(
          "This series has modified future occurrences. Edit the whole series or individual instances so those changes are not lost.",
        );
      // Past exceptions may have been moved beyond the boundary and therefore
      // be omitted by instances(timeMax). They still consume the original COUNT.
      priorIds.add(event.id);
    }
    token = page.nextPageToken;
  } while (token);
  token = undefined;
  do {
    const page: CalendarEventsPage =
      await action.api.request<CalendarEventsPage>(
        binding.calendar_id,
        `${eventResource(parent.id)}/instances`,
        {
          signal: action.signal,
          query: {
            timeMax: new Date(boundaryMs).toISOString(),
            showDeleted: "true",
            maxResults: "2500",
            ...(token ? { pageToken: token } : {}),
          },
        },
      );
    for (const event of page.items ?? []) {
      const original =
        event.originalStartTime?.dateTime ?? event.originalStartTime?.date;
      if (!original || Date.parse(original) < boundaryMs)
        priorIds.add(event.id);
    }
    if (priorIds.size > 10000)
      throw new Error(
        "This series is too large to split safely in one request. Use a whole-series edit.",
      );
    token = page.nextPageToken;
  } while (token);
  const before = priorIds.size;
  const originalRule = parent.recurrence[0];
  const count = originalRule.match(/(?:^|;)COUNT=(\d+)/)?.[1];
  const futureRule = count
    ? originalRule.replace(
        /COUNT=\d+/,
        `COUNT=${Math.max(1, Number(count) - before)}`,
      )
    : originalRule;
  const untilDate = new Date(boundaryMs - 1000).toISOString();
  const until = instance.originalStartTime.date
    ? untilDate.slice(0, 10).replaceAll("-", "")
    : untilDate.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const pastRule = `${originalRule.replace(/;(?:COUNT|UNTIL)=[^;]+/g, "")};UNTIL=${until}`;
  return { instance, parent, before, futureRule, pastRule };
}

function validateCalendarFields(args: Record<string, unknown>) {
  const hours = args.workingHours as
    | {
        workingHoursEnabled: boolean;
        availableTimes?: { periodStart: number; periodEnd: number }[];
      }
    | undefined;
  if (hours?.workingHoursEnabled && !hours.availableTimes?.length)
    throw new Error(
      "Enabled working hours need at least one availability period.",
    );
  if (
    hours?.availableTimes?.some(
      (period) => period.periodEnd <= period.periodStart,
    )
  )
    throw new Error("Working hours must end after they start.");
}

export async function executeCalendarOperation(
  name: CalendarOperation,
  args: Record<string, unknown>,
  action: CalendarActionContext,
): Promise<Record<string, unknown>> {
  const { database, context, api, signal } = action;
  const bindings = await getChatCalendars(database, context.chatId);
  if (name === "list_calendars")
    return {
      calendars: bindings.map((item) => ({
        id: item.calendar_id,
        name: item.name,
        timeZone: item.time_zone,
      })),
    };
  if (name === "get_colors")
    return api.requestGlobal<Record<string, unknown>>("/colors", { signal });
  if (name === "free_busy") {
    if (calendarTimestamp(args.timeMax) <= calendarTimestamp(args.timeMin))
      throw new Error("timeMax must be after timeMin.");
    const ids =
      (args.calendarIds as string[] | undefined) ??
      bindings.map((item) => item.calendar_id);
    for (const id of ids) await action.authorize(id);
    if (args.timeZone) validateZone(String(args.timeZone));
    return api.requestGlobal<Record<string, unknown>>("/freeBusy", {
      method: "POST",
      body: {
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        timeZone: args.timeZone,
        items: ids.map((id) => ({ id })),
      },
      signal,
    });
  }
  if (name === "create_calendar") {
    validateCalendarFields(args);
    if (args.timeZone) validateZone(String(args.timeZone));
    const calendar = await api.requestGlobal<{
      id: string;
      summary: string;
      timeZone?: string;
    }>("/calendars", {
      method: "POST",
      body: {
        ...Object.fromEntries(
          Object.keys(CALENDAR_FIELDS)
            .filter((key) => args[key] !== undefined)
            .map((key) => [key, args[key]]),
        ),
        timeZone: args.timeZone ?? "UTC",
      },
      signal,
    });
    const binding: ChatCalendarTable = {
      chat_id: context.chatId,
      calendar_id: calendar.id,
      name: calendar.summary,
      time_zone: calendar.timeZone ?? String(args.timeZone ?? "UTC"),
      linked_by: context.userId ?? 0,
      verified_at: Date.now(),
      verification_id: crypto.randomUUID(),
    };
    try {
      await linkChatCalendar(database, binding);
    } catch {
      return {
        calendar,
        linked: false,
        partial: true,
        error:
          "Calendar was created, but linking failed. Do not create it again; use /calendar with this ID to link it.",
        dataOwner: "service_account",
      };
    }
    if (args.shareWithEmail) {
      try {
        await api.request(calendar.id, "/acl", {
          method: "POST",
          body: {
            scope: { type: "user", value: args.shareWithEmail },
            role: "owner",
          },
          signal,
        });
      } catch (error) {
        return {
          calendar,
          linked: true,
          dataOwner: "service_account",
          sharingError:
            error instanceof Error ? error.message : "Sharing failed",
        };
      }
    }
    return {
      calendar,
      linked: true,
      dataOwner: "service_account",
      ownershipTransferable: false,
    };
  }
  const binding = await action.authorize(args.calendarId as string | undefined);
  const calendarId = binding.calendar_id;
  if (name === "get_calendar")
    return {
      ...(await api.metadata(calendarId, signal)),
      capabilities: {
        cancellation: "native_google_status_cancelled",
        deletion: false,
        guestOperationsRequireDomainDelegation: true,
        calendarAdministrationRequiresManagerAccess: true,
      },
    };
  if (name === "watch_calendar")
    return watchCalendar(database, binding, context.threadId, api, {
      signal,
      authorize: () => action.authorize(calendarId),
    });
  if (name === "unwatch_calendar")
    return unwatchCalendar(database, context.chatId, calendarId);
  if (name === "unlink_calendar") {
    await unwatchCalendar(database, context.chatId, calendarId);
    await unlinkChatCalendar(database, context.chatId, calendarId);
    return { unlinked: true, googleCalendarDeleted: false };
  }
  if (name === "update_calendar") {
    validateCalendarFields(args);
    if (args.timeZone) validateZone(String(args.timeZone));
    const current = await api.metadata(calendarId, signal);
    const body: Record<string, unknown> = {};
    for (const key of Object.keys(CALENDAR_FIELDS))
      if (args[key] !== undefined) body[key] = args[key];
    if (!Object.keys(body).length)
      throw new Error("Provide at least one calendar field to update.");
    if (!current.etag)
      throw new Error("Google did not return the calendar version.");
    await action.authorize(calendarId);
    const result = await api.request<Record<string, unknown>>(calendarId, "", {
      method: "PATCH",
      body,
      etag: current.etag,
      signal,
    });
    const values = {
      ...(typeof result.summary === "string" ? { name: result.summary } : {}),
      ...(typeof result.timeZone === "string"
        ? { time_zone: result.timeZone }
        : {}),
    };
    if (Object.keys(values).length) {
      await database
        .updateTable("chat_calendar_links")
        .set(values)
        .where("chat_id", "=", context.chatId)
        .where("calendar_id", "=", calendarId)
        .execute();
      await database
        .updateTable("chat_calendars")
        .set(values)
        .where("chat_id", "=", context.chatId)
        .where("calendar_id", "=", calendarId)
        .execute();
    }
    return result;
  }
  if (name === "list_sharing")
    return api.request<Record<string, unknown>>(calendarId, "/acl", {
      signal,
      query: {
        maxResults: String(args.maxResults ?? 100),
        ...(args.pageToken ? { pageToken: String(args.pageToken) } : {}),
      },
    });
  if (name === "set_sharing") {
    const scope = args.scope as { type: string; value?: string };
    if (scope.type !== "default" && !scope.value)
      throw new Error("Provide the sharing recipient or domain.");
    if (scope.type === "default" && scope.value)
      throw new Error("Public sharing does not take a recipient.");
    if (
      scope.type === "user" &&
      scope.value?.toLowerCase() === api.email.toLowerCase()
    )
      throw new Error(
        "The bot's own calendar access cannot be changed by this tool.",
      );
    let pageToken: string | undefined;
    let existing: { id: string; etag?: string } | undefined;
    do {
      const page = await api.request<{
        items?: { id: string; etag?: string; scope?: typeof scope }[];
        nextPageToken?: string;
      }>(calendarId, "/acl", {
        signal,
        query: { maxResults: "250", ...(pageToken ? { pageToken } : {}) },
      });
      existing = page.items?.find(
        (rule) =>
          rule.scope?.type === scope.type &&
          (rule.scope.value ?? "").toLowerCase() ===
            (scope.value ?? "").toLowerCase(),
      );
      pageToken = page.nextPageToken;
    } while (!existing && pageToken);
    if (!existing && args.role === "none")
      return { revoked: true, alreadyAbsent: true };
    if (existing && !existing.etag)
      throw new Error(
        "Google did not return the sharing rule version. Read sharing again.",
      );
    await action.authorize(calendarId);
    return api.request<Record<string, unknown>>(
      calendarId,
      existing ? `/acl/${encodeURIComponent(existing.id)}` : "/acl",
      {
        method: existing ? "PATCH" : "POST",
        etag: existing?.etag,
        signal,
        query: { sendNotifications: String(args.sendNotifications ?? true) },
        body: existing ? { role: args.role } : { scope, role: args.role },
      },
    );
  }
  if (
    name === "list_events" ||
    name === "export_events" ||
    name === "list_instances"
  ) {
    if (calendarTimestamp(args.timeMax) <= calendarTimestamp(args.timeMin))
      throw new Error("timeMax must be after timeMin.");
    const query: Record<string, string | string[]> = {
      timeMin: String(args.timeMin),
      timeMax: String(args.timeMax),
      maxResults: String(args.maxResults ?? 50),
      showDeleted: String(args.showCancelled ?? false),
    };
    if (args.pageToken) query.pageToken = String(args.pageToken);
    if (name !== "list_instances") {
      const expanded = args.expandRecurring ?? name !== "export_events";
      query.singleEvents = String(expanded);
      if (expanded) query.orderBy = "startTime";
      for (const key of ["q", "updatedMin", "iCalUID"])
        if (args[key] !== undefined) query[key] = String(args[key]);
      if (args.updatedMin) calendarTimestamp(args.updatedMin);
      // Google accepts these filters as repeated query parameters.
      for (const key of [
        "eventTypes",
        "privateExtendedProperty",
        "sharedExtendedProperty",
      ])
        if (Array.isArray(args[key]) && args[key].length)
          query[key] = args[key] as string[];
    }
    const page = await api.request<CalendarEventsPage>(
      calendarId,
      name === "list_instances"
        ? `${eventResource(String(args.eventId))}/instances`
        : "/events",
      { signal, query },
    );
    return {
      ...(name === "export_events"
        ? {
            format: "google-calendar-json",
            calendar: {
              id: calendarId,
              name: binding.name,
              timeZone: binding.time_zone,
            },
          }
        : {}),
      events: page.items ?? [],
      nextPageToken: page.nextPageToken,
    };
  }
  if (name === "get_event")
    return { ...(await readEvent(action, binding, String(args.eventId))) };
  if (name === "create_event" || name === "import_event")
    return {
      ...(await createEvent(action, binding, args, name === "import_event")),
    };
  if (name === "move_event") {
    const destination = await action.authorize(
      String(args.destinationCalendarId),
    );
    if (destination.calendar_id === calendarId)
      throw new Error("Choose a different destination calendar.");
    const current = await readEvent(action, binding, String(args.eventId));
    if (current.eventType && current.eventType !== "default")
      throw new Error("Only default events can be moved.");
    await action.authorize(calendarId);
    await action.authorize(destination.calendar_id);
    return api.request<Record<string, unknown>>(
      calendarId,
      `${eventResource(current.id)}/move`,
      {
        method: "POST",
        etag: version(current),
        signal,
        query: {
          destination: destination.calendar_id,
          sendUpdates: String(args.sendUpdates ?? "all"),
        },
      },
    );
  }
  if (name === "split_series") {
    const changes = args.changes as Record<string, unknown>;
    if (!Object.keys(changes).length)
      throw new Error("Provide fields to change before splitting a series.");
    const split = await followingBoundary(
      action,
      binding,
      String(args.instanceId),
    );
    if (!split.before)
      return {
        ...(await patchEvent(
          action,
          binding,
          split.parent,
          eventBody(changes, binding, split.parent),
          args,
        )),
        split: false,
      };
    const source: Record<string, unknown> = {};
    for (const key of Object.keys(EVENT_FIELDS))
      if (split.parent[key] !== undefined && key !== "conferenceData")
        source[key] = split.parent[key];
    source.start = split.instance.start;
    source.end = split.instance.end;
    source.recurrence = [split.futureRule];
    const future = await createEvent(action, binding, {
      ...source,
      ...changes,
      sendUpdates: args.sendUpdates,
    });
    try {
      await patchEvent(
        action,
        binding,
        split.parent,
        { recurrence: [split.pastRule] },
        args,
      );
      return {
        split: true,
        originalSeriesId: split.parent.id,
        futureSeries: future,
        conferenceNotCopied: Boolean(
          split.parent.conferenceData &&
            !changes.conferenceData &&
            !changes.addGoogleMeet,
        ),
      };
    } catch (error) {
      return {
        partial: true,
        futureSeries: future,
        originalSeriesId: split.parent.id,
        originalSeriesTrimmed: false,
        error: error instanceof Error ? error.message : "Series trim failed",
        instruction:
          "The future series exists. Do not create it again. Resolve the original series conflict explicitly.",
      };
    }
  }
  if (name === "cancel_event") {
    if (args.scope === "following") {
      const split = await followingBoundary(
        action,
        binding,
        String(args.eventId),
      );
      await archiveCalendarEvent(
        database,
        context.chatId,
        calendarId,
        split.parent,
      );
      const result = await patchEvent(
        action,
        binding,
        split.parent,
        split.before
          ? { recurrence: [split.pastRule] }
          : { status: "cancelled" },
        args,
      );
      return {
        cancelled: true,
        scope: "following",
        event: result,
        restoreEventId: split.parent.id,
      };
    }
    const current = await targetEvent(
      action,
      binding,
      String(args.eventId),
      String(args.scope),
    );
    if (current.status === "cancelled")
      return {
        cancelled: true,
        alreadyCancelled: true,
        restoreEventId: current.id,
      };
    await archiveCalendarEvent(database, context.chatId, calendarId, current);
    return {
      cancelled: true,
      event: await patchEvent(
        action,
        binding,
        current,
        { status: "cancelled" },
        args,
      ),
      restoreEventId: current.id,
    };
  }
  if (name === "restore_event") {
    const saved = await getCalendarEventArchive(
      database,
      context.chatId,
      calendarId,
      String(args.eventId),
    );
    if (!saved)
      throw new Error(
        "No cancellation snapshot exists for this event in this chat.",
      );
    const current = await readEvent(action, binding, saved.id);
    const body: Record<string, unknown> = { status: "confirmed" };
    for (const key of Object.keys(EVENT_FIELDS))
      if (
        saved[key] !== undefined &&
        !["attendees", "eventType", "status"].includes(key)
      )
        body[key] = saved[key];
    return {
      restored: true,
      event: await patchEvent(action, binding, current, body, args),
    };
  }
  if (name === "respond_to_event") {
    const current = await readEvent(action, binding, String(args.eventId));
    const own = current.attendees?.filter(
      (attendee) =>
        attendee.self ||
        attendee.email?.toLowerCase() === calendarId.toLowerCase(),
    );
    if (own?.length !== 1)
      throw new Error(
        "This calendar has no unambiguous attendee entry for this invitation.",
      );
    const attendees = current.attendees?.map((attendee) =>
      attendee === own[0]
        ? {
            ...attendee,
            responseStatus: args.responseStatus,
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
          }
        : attendee,
    );
    return {
      ...(await patchEvent(action, binding, current, { attendees }, args)),
    };
  }
  if (name === "batch_update_events") {
    const results: Record<string, unknown>[] = [];
    for (const update of args.updates as {
      eventId: string;
      changes: Record<string, unknown>;
    }[]) {
      signal?.throwIfAborted();
      try {
        await action.authorize(calendarId);
        const current = await targetEvent(
          action,
          binding,
          update.eventId,
          undefined,
        );
        const body = eventBody(update.changes, binding, current);
        if (!Object.keys(body).length) throw new Error("No fields to update.");
        results.push({
          eventId: update.eventId,
          success: true,
          event: await patchEvent(action, binding, current, body, args),
        });
      } catch (error) {
        signal?.throwIfAborted();
        results.push({
          eventId: update.eventId,
          success: false,
          error: error instanceof Error ? error.message : "Update failed",
        });
      }
    }
    return {
      results,
      partial: results.some((result) => result.success === false),
    };
  }
  if (name === "update_event") {
    const current = await targetEvent(
      action,
      binding,
      String(args.eventId),
      args.scope as string | undefined,
    );
    const body = eventBody(args, binding, current);
    if (!Object.keys(body).length)
      throw new Error("Provide at least one field to update.");
    return { ...(await patchEvent(action, binding, current, body, args)) };
  }
  throw new Error("Unsupported Calendar operation.");
}
