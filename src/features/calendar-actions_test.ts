import { test } from "bun:test";
import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert";
import {
  type CalendarActionContext,
  executeCalendarOperation,
} from "./calendar-actions.ts";
import type { CalendarOperation } from "./calendar-schema.ts";
import {
  getCalendarMcpEnabled,
  getChatCalendar,
  getChatCalendars,
  linkChatCalendar,
  migrateCalendars,
  setCalendarMcpEnabled,
} from "./calendar-settings.ts";
import { getCalendarEventArchive } from "./calendar-storage.ts";
import {
  pollCalendarWatches,
  unwatchCalendar,
  watchCalendar,
} from "./calendar-watch.ts";
import { initDatabase } from "./database.ts";
import {
  CalendarApiError,
  type CalendarEvent,
  type CalendarRequestOptions,
} from "./google-calendar.ts";

const range = {
  timeMin: "2026-11-01T00:00:00Z",
  timeMax: "2026-12-01T00:00:00Z",
};
const times = {
  start: { dateTime: "2026-11-05T10:00:00+01:00" },
  end: { dateTime: "2026-11-05T11:00:00+01:00" },
};
async function fixture() {
  const database = await initDatabase()();
  const binding = {
    chat_id: -100,
    calendar_id: "one@group.calendar.google.com",
    name: "One",
    time_zone: "Europe/Prague",
    linked_by: 2,
    verified_at: 1,
    verification_id: "verified-one",
  };
  await linkChatCalendar(database, binding);
  await setCalendarMcpEnabled(database, -100, true);
  const events = new Map<string, CalendarEvent>([
    [
      "event1",
      {
        id: "event1",
        etag: '"v1"',
        summary: "Meeting",
        status: "confirmed",
        ...times,
      },
    ],
  ]);
  const calls: {
    id: string;
    resource: string;
    options: CalendarRequestOptions;
  }[] = [];
  const state = {
    failPatch: false,
    before: undefined as
      | ((resource: string, options: CalendarRequestOptions) => Promise<void>)
      | undefined,
    changes: [] as CalendarEvent[],
    syncToken: "baseline",
    expired: false,
    futureExceptions: [] as CalendarEvent[],
    priorInstances: 2,
    sharing: [] as {
      id: string;
      etag: string;
      scope: { type: string; value: string };
    }[],
  };
  const request = async <T>(
    id: string,
    resource = "",
    options: CalendarRequestOptions = {},
  ): Promise<T> => {
    calls.push({ id, resource, options });
    await state.before?.(resource, options);
    let result: unknown;
    if (resource === "/events" && !options.method) {
      if (options.query?.syncToken && state.expired)
        throw new CalendarApiError("Expired", 410);
      result =
        options.query?.singleEvents === "false"
          ? { items: state.futureExceptions }
          : { items: state.changes, nextSyncToken: state.syncToken };
    } else if (resource === "/acl")
      result =
        options.method === "POST" ? options.body : { items: state.sharing };
    else if (resource.startsWith("/acl/")) result = options.body;
    else if (!resource)
      result = {
        id,
        summary: "One",
        timeZone: "Europe/Prague",
        etag: '"metadata"',
        ...options.body,
      };
    else if (resource.endsWith("/instances"))
      result = {
        items: Array.from({ length: state.priorInstances }, (_, i) => ({
          id: `prior${i}`,
        })),
      };
    else if (resource.endsWith("/move")) result = { moved: true };
    else if (options.method === "POST") {
      const event = {
        ...options.body,
        id: String(options.body?.id ?? "imported"),
        etag: '"created"',
      } as CalendarEvent;
      events.set(event.id, structuredClone(event));
      result = event;
    } else {
      const eventId = decodeURIComponent(resource.split("/")[2]);
      const event = events.get(eventId);
      if (!event) throw new CalendarApiError("Not found", 404);
      if (options.method === "PATCH") {
        if (state.failPatch || options.etag !== event.etag)
          throw new CalendarApiError("The event changed", 412);
        Object.assign(event, options.body, { etag: '"v2"' });
      }
      result = event;
    }
    return structuredClone(result) as T;
  };
  const api: CalendarActionContext["api"] = {
    email: "agent@project.iam.gserviceaccount.com",
    request,
    requestGlobal: async <T>(
      resource: "/freeBusy" | "/colors" | "/calendars",
      options: CalendarRequestOptions = {},
    ) => {
      calls.push({ id: "global", resource, options });
      return (
        resource === "/calendars"
          ? {
              id: "created@group.calendar.google.com",
              summary: options.body?.summary,
              timeZone: options.body?.timeZone,
            }
          : { calendars: options.body?.items }
      ) as T;
    },
    metadata: (id) => request(id),
    assertWritable: async () => {},
  };
  const action: CalendarActionContext = {
    database,
    api,
    context: { chatId: -100, userId: 2, messageId: 1, threadId: 99 },
    authorize: async (id) => {
      if (!(await getCalendarMcpEnabled(database, -100)))
        throw new Error("disabled");
      const links = await getChatCalendars(database, -100);
      if (!id && links.length !== 1) throw new Error("Choose calendarId");
      const link = links.find(
        (item) => item.calendar_id === (id ?? links[0]?.calendar_id),
      );
      if (!link) throw new Error("not verified");
      return link;
    },
  };
  return {
    database,
    binding,
    api,
    action,
    events,
    calls,
    state,
    run: (name: CalendarOperation, args: Record<string, unknown>) =>
      executeCalendarOperation(name, args, action),
  };
}

test("Recurring event creation preserves rules, reminders and settings with named timezone and unique Meet requests", async () => {
  const f = await fixture();
  try {
    const args = {
      summary: "Weekly meeting",
      ...times,
      recurrence: [
        "RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=10",
        "EXDATE:20261112T090000Z",
      ],
      reminders: {
        useDefault: false,
        overrides: [{ method: "popup", minutes: 30 }],
      },
      visibility: "private",
      transparency: "transparent",
      colorId: "5",
      eventLabelId: "label-id",
      source: { url: "https://example.com/meeting", title: "Agenda" },
      attachments: [{ fileUrl: "https://drive.google.com/file/test" }],
      extendedProperties: { private: { chat: "test" } },
      addGoogleMeet: true,
    };
    const result = await f.run("create_event", args);
    deepStrictEqual(result.recurrence, args.recurrence);
    deepStrictEqual(result.reminders, args.reminders);
    strictEqual(
      (result.start as { timeZone: string }).timeZone,
      "Europe/Prague",
    );
    const first = f.calls.at(-1);
    ok(first);
    strictEqual(first.options.query?.conferenceDataVersion, "1");
    strictEqual(first.options.query?.supportsAttachments, "true");
    strictEqual(first.options.query?.eventLabelVersion, "1");
    deepStrictEqual(result.source, args.source);
    await f.run("create_event", args);
    ok(
      JSON.stringify(first.options.body?.conferenceData) !==
        JSON.stringify(f.calls.at(-1)?.options.body?.conferenceData),
    );
    for (const recurrence of [
      ["RRULE:FREQ=INVALID"],
      ["DTSTART:20261105T090000Z"],
      ["RRULE:FREQ=DAILY;COUNT=2;UNTIL=20261201T000000Z"],
      ["RRULE:FREQ=DAILY\nDTEND:20261105T090000Z"],
    ])
      await rejects(
        f.run("create_event", { ...args, recurrence }),
        /recurrence|RFC5545|COUNT/,
      );
    await rejects(
      f.run("create_event", {
        ...args,
        reminders: {
          useDefault: true,
          overrides: [{ method: "popup", minutes: 5 }],
        },
      }),
      /useDefault/,
    );
    await rejects(
      f.run("create_event", {
        ...args,
        start: { dateTime: "2026-02-30T10:00:00Z" },
      }),
      /Invalid calendar date/,
    );
  } finally {
    await f.database.destroy();
  }
});

test("Native cancellation snapshots content, uses PATCH only, and can restore the saved event", async () => {
  const f = await fixture();
  try {
    const result = await f.run("cancel_event", {
      eventId: "event1",
      scope: "occurrence",
    });
    strictEqual(result.restoreEventId, "event1");
    deepStrictEqual(f.calls.at(-1)?.options.body, { status: "cancelled" });
    strictEqual(f.calls.at(-1)?.options.etag, '"v1"');
    strictEqual(
      (
        await getCalendarEventArchive(
          f.database,
          -100,
          f.binding.calendar_id,
          "event1",
        )
      )?.summary,
      "Meeting",
    );
    await f.run("cancel_event", { eventId: "event1", scope: "occurrence" });
    const restored = await f.run("restore_event", { eventId: "event1" });
    strictEqual((restored.event as CalendarEvent).status, "confirmed");
    strictEqual((restored.event as CalendarEvent).summary, "Meeting");
    ok(
      f.calls.every(
        (call) =>
          call.options.method === undefined || call.options.method === "PATCH",
      ),
    );
    await rejects(
      f.run("restore_event", { eventId: "unknown" }),
      /No cancellation snapshot/,
    );
  } finally {
    await f.database.destroy();
  }
});

function series(f: Awaited<ReturnType<typeof fixture>>, allDay = false) {
  const parent: CalendarEvent = {
    id: "series",
    etag: '"v1"',
    summary: "Daily",
    ...times,
    recurrence: ["RRULE:FREQ=DAILY;COUNT=5"],
    conferenceData: { conferenceId: "private-meeting" },
  };
  if (allDay) {
    parent.start = { date: "2026-11-03" };
    parent.end = { date: "2026-11-04" };
  }
  const occurrence: CalendarEvent = {
    ...parent,
    id: "instance",
    recurrence: undefined,
    recurringEventId: "series",
    originalStartTime: allDay ? { date: "2026-11-05" } : times.start,
  };
  f.events.set(parent.id, parent);
  f.events.set(occurrence.id, occurrence);
  return { parent, occurrence };
}

test("Recurring updates distinguish occurrence and series; complex recurrence remains supported for whole-series edits", async () => {
  const f = await fixture();
  try {
    const { parent } = series(f);
    await rejects(
      f.run("update_event", { eventId: "series", summary: "Unsafe" }),
      /scope=series/,
    );
    await f.run("update_event", {
      eventId: "instance",
      scope: "occurrence",
      summary: "One",
    });
    strictEqual(f.calls.at(-1)?.resource, "/events/instance");
    await f.run("update_event", {
      eventId: "instance",
      scope: "series",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=5", "RDATE:20261106T090000Z"],
    });
    strictEqual(f.calls.at(-1)?.resource, "/events/series");
    deepStrictEqual(parent.recurrence, [
      "RRULE:FREQ=WEEKLY;COUNT=5",
      "RDATE:20261106T090000Z",
    ]);
    await rejects(
      f.run("update_event", { eventId: "instance", recurrence: [] }),
      /recurring master/,
    );
    await f.run("update_event", {
      eventId: "series",
      scope: "series",
      recurrence: [],
      reminders: { useDefault: true },
    });
    deepStrictEqual(parent.recurrence, []);
    await rejects(
      f.run("update_event", { eventId: "event1", eventType: "outOfOffice" }),
      /cannot be changed/,
    );
  } finally {
    await f.database.destroy();
  }
});

test("Splitting a series preserves COUNT, separates conference data and reports a partial trim failure", async () => {
  const f = await fixture();
  try {
    series(f);
    const result = await f.run("split_series", {
      instanceId: "instance",
      changes: { summary: "Future" },
    });
    const future = result.futureSeries as CalendarEvent;
    deepStrictEqual(future.recurrence, ["RRULE:FREQ=DAILY;COUNT=3"]);
    strictEqual(future.conferenceData, undefined);
    strictEqual(result.conferenceNotCopied, true);
    deepStrictEqual(f.events.get("series")?.recurrence, [
      "RRULE:FREQ=DAILY;UNTIL=20261105T085959Z",
    ]);
    series(f);
    f.state.failPatch = true;
    const partial = await f.run("split_series", {
      instanceId: "instance",
      changes: { summary: "Conflict" },
    });
    strictEqual(partial.partial, true);
    ok((partial.futureSeries as CalendarEvent).id);
    match(String(partial.instruction), /Do not create it again/);
    strictEqual(
      f.calls.filter((call) => call.options.method === "POST").length,
      2,
    );
  } finally {
    await f.database.destroy();
  }
});

test("Following cancellation handles all-day UNTIL and refuses complex sets or modified future exceptions", async () => {
  const f = await fixture();
  try {
    series(f, true);
    const result = await f.run("cancel_event", {
      eventId: "instance",
      scope: "following",
    });
    strictEqual(result.restoreEventId, "series");
    deepStrictEqual(f.events.get("series")?.recurrence, [
      "RRULE:FREQ=DAILY;UNTIL=20261104",
    ]);
    await f.run("restore_event", { eventId: "series" });
    deepStrictEqual(f.events.get("series")?.recurrence, [
      "RRULE:FREQ=DAILY;COUNT=5",
    ]);
    f.state.futureExceptions = [{ id: "future", recurringEventId: "series" }];
    await rejects(
      f.run("split_series", {
        instanceId: "instance",
        changes: { summary: "New" },
      }),
      /modified future/,
    );
    f.state.futureExceptions = [];
    f.events.get("series")?.recurrence?.push("EXDATE;VALUE=DATE:20261106");
    await rejects(
      f.run("cancel_event", { eventId: "instance", scope: "following" }),
      /complex recurrence/,
    );
  } finally {
    await f.database.destroy();
  }
});

test("Multiple calendars retain bindings, constrain availability and moves, and unlink without deleting Google data", async () => {
  const f = await fixture();
  try {
    await linkChatCalendar(f.database, {
      ...f.binding,
      calendar_id: "two@group.calendar.google.com",
      verification_id: "verified-two",
      name: "Two",
      verified_at: 2,
    });
    strictEqual((await getChatCalendars(f.database, -100)).length, 2);
    await rejects(f.run("get_calendar", {}), /Choose calendarId/);
    const before = f.calls.length;
    await rejects(
      f.run("free_busy", { ...range, calendarIds: ["victim@example.com"] }),
      /not verified/,
    );
    await rejects(
      f.run("move_event", {
        calendarId: f.binding.calendar_id,
        eventId: "event1",
        destinationCalendarId: "victim@example.com",
      }),
      /not verified/,
    );
    strictEqual(f.calls.length, before);
    await f.run("free_busy", range);
    deepStrictEqual(f.calls.at(-1)?.options.body?.items, [
      { id: "two@group.calendar.google.com" },
      { id: f.binding.calendar_id },
    ]);
    await f.run("move_event", {
      calendarId: f.binding.calendar_id,
      eventId: "event1",
      destinationCalendarId: "two@group.calendar.google.com",
    });
    strictEqual(
      f.calls.at(-1)?.options.query?.destination,
      "two@group.calendar.google.com",
    );
    const count = f.calls.length;
    await f.run("unlink_calendar", {
      calendarId: "two@group.calendar.google.com",
    });
    strictEqual(f.calls.length, count);
    strictEqual(
      (await getChatCalendar(f.database, -100))?.calendar_id,
      f.binding.calendar_id,
    );
    await migrateCalendars(f.database);
    strictEqual((await getChatCalendars(f.database, -100)).length, 1);
    await f.run("unlink_calendar", { calendarId: f.binding.calendar_id });
    await migrateCalendars(f.database);
    strictEqual((await getChatCalendars(f.database, -100)).length, 0);
  } finally {
    await f.database.destroy();
  }
});

test("Full event reads, repeated search filters, private import/export and versioned batch edits preserve data", async () => {
  const f = await fixture();
  try {
    const event = f.events.get("event1");
    ok(event);
    event.attendees = [
      { email: "guest@example.com", responseStatus: "accepted" },
    ];
    event.reminders = {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 10 }],
    };
    deepStrictEqual(
      (await f.run("get_event", { eventId: "event1" })).attendees,
      event.attendees,
    );
    await f.run("list_events", {
      ...range,
      eventTypes: ["default", "focusTime"],
      privateExtendedProperty: ["a=1", "b=2"],
    });
    deepStrictEqual(f.calls.at(-1)?.options.query?.eventTypes, [
      "default",
      "focusTime",
    ]);
    await f.run("export_events", range);
    strictEqual(f.calls.at(-1)?.options.query?.singleEvents, "false");
    await f.run("import_event", {
      summary: "Imported",
      ...times,
      iCalUID: "uid@example.com",
      recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
    });
    strictEqual(f.calls.at(-1)?.resource, "/events/import");
    strictEqual(f.calls.at(-1)?.options.body?.iCalUID, "uid@example.com");
    const batch = await f.run("batch_update_events", {
      updates: [
        { eventId: "event1", changes: { summary: "Updated" } },
        { eventId: "missing", changes: { summary: "Fail" } },
      ],
    });
    strictEqual(batch.partial, true);
    strictEqual((batch.results as { success: boolean }[])[0].success, true);
    deepStrictEqual(event.attendees, [
      { email: "guest@example.com", responseStatus: "accepted" },
    ]);
    f.state.before = async (resource, options) => {
      if (resource === "/events/event1" && !options.method)
        await setCalendarMcpEnabled(f.database, -100, false);
    };
    const before = f.calls.filter(
      (call) => call.options.method === "PATCH",
    ).length;
    await rejects(
      f.run("update_event", { eventId: "event1", summary: "Race" }),
      /disabled/,
    );
    strictEqual(
      f.calls.filter((call) => call.options.method === "PATCH").length,
      before,
    );
  } finally {
    await f.database.destroy();
  }
});

test("RSVP targets only this calendar's attendee, and sharing changes use versions without deleting rules", async () => {
  const f = await fixture();
  try {
    const event = f.events.get("event1");
    ok(event);
    event.attendees = [
      {
        email: f.binding.calendar_id,
        self: true,
        responseStatus: "needsAction",
      },
      { email: "other@example.com", responseStatus: "accepted" },
    ];
    await f.run("respond_to_event", {
      eventId: "event1",
      responseStatus: "declined",
    });
    strictEqual(event.attendees[0].responseStatus, "declined");
    strictEqual(event.attendees[1].responseStatus, "accepted");
    event.attendees = [{ email: "other@example.com" }];
    await rejects(
      f.run("respond_to_event", {
        eventId: "event1",
        responseStatus: "accepted",
      }),
      /no unambiguous/,
    );
    f.state.sharing = [
      {
        id: "user:other@example.com",
        etag: '"acl-v1"',
        scope: { type: "user", value: "other@example.com" },
      },
    ];
    await f.run("set_sharing", {
      scope: { type: "user", value: "other@example.com" },
      role: "none",
    });
    strictEqual(f.calls.at(-1)?.options.method, "PATCH");
    strictEqual(f.calls.at(-1)?.options.etag, '"acl-v1"');
    deepStrictEqual(f.calls.at(-1)?.options.body, { role: "none" });
    await rejects(
      f.run("set_sharing", {
        scope: { type: "user", value: f.api.email },
        role: "none",
      }),
      /own calendar access/,
    );
    const created = await f.run("create_calendar", {
      summary: "Bot owned",
      shareWithEmail: "owner@example.com",
    });
    strictEqual(created.dataOwner, "service_account");
    strictEqual(created.ownershipTransferable, false);
    strictEqual((await getChatCalendars(f.database, -100)).length, 2);
  } finally {
    await f.database.destroy();
  }
});

test("Calendar watches establish a baseline, preserve topics, retry delivery, and stop on disable or unwatch", async () => {
  const f = await fixture();
  const sent: unknown[][] = [];
  let fail = false;
  const telegram = {
    sendRichMessage: async (...args: unknown[]) => {
      if (fail) throw new Error("Telegram unavailable");
      sent.push(args);
      return {};
    },
  } as unknown as Parameters<typeof pollCalendarWatches>[1];
  try {
    f.state.changes = [{ id: "old", summary: "Historical" }];
    await watchCalendar(f.database, f.binding, 99, f.api);
    strictEqual(sent.length, 0);
    f.state.syncToken = "next";
    f.state.changes = [{ id: "new", summary: "<Safe>", status: "cancelled" }];
    fail = true;
    await pollCalendarWatches(f.database, telegram, f.api);
    strictEqual(
      (
        await f.database
          .selectFrom("calendar_watches")
          .selectAll()
          .executeTakeFirst()
      )?.sync_token,
      "baseline",
    );
    fail = false;
    await pollCalendarWatches(f.database, telegram, f.api);
    strictEqual(sent.length, 1);
    deepStrictEqual(sent[0][2], { message_thread_id: 99 });
    match(
      String((sent[0][1] as { html: string }).html),
      /Cancelled: &lt;Safe&gt;/,
    );
    await setCalendarMcpEnabled(f.database, -100, false);
    const count = f.calls.length;
    await pollCalendarWatches(f.database, telegram, f.api);
    strictEqual(f.calls.length, count);
    await setCalendarMcpEnabled(f.database, -100, true);
    f.state.before = async () => {
      await unwatchCalendar(f.database, -100, f.binding.calendar_id);
    };
    await pollCalendarWatches(f.database, telegram, f.api);
    strictEqual(sent.length, 1);
  } finally {
    await f.database.destroy();
  }
});

test("Expired Calendar watch cursors rebaseline without replaying history; unlink stops delivery", async () => {
  const f = await fixture();
  let sent = 0;
  const telegram = {
    sendRichMessage: async () => {
      sent++;
      return {};
    },
  } as unknown as Parameters<typeof pollCalendarWatches>[1];
  try {
    await watchCalendar(f.database, f.binding, undefined, f.api);
    f.state.expired = true;
    f.state.syncToken = "fresh";
    f.state.changes = [{ id: "old", summary: "Historical" }];
    await pollCalendarWatches(f.database, telegram, f.api);
    strictEqual(sent, 0);
    strictEqual(
      (
        await f.database
          .selectFrom("calendar_watches")
          .selectAll()
          .executeTakeFirst()
      )?.sync_token,
      "fresh",
    );
    await f.run("unlink_calendar", { calendarId: f.binding.calendar_id });
    const count = f.calls.length;
    await pollCalendarWatches(f.database, telegram, f.api);
    strictEqual(f.calls.length, count);
  } finally {
    await f.database.destroy();
  }
});

test("Series splitting counts past exceptions moved beyond the boundary and rejects future exceptions moved earlier", async () => {
  const f = await fixture();
  try {
    series(f);
    f.state.priorInstances = 1;
    f.state.futureExceptions = [
      {
        id: "moved-past",
        recurringEventId: "series",
        originalStartTime: { dateTime: "2026-11-04T10:00:00+01:00" },
        start: { dateTime: "2026-12-10T10:00:00+01:00" },
      },
    ];
    const result = await f.run("split_series", {
      instanceId: "instance",
      changes: { summary: "Future", addGoogleMeet: true },
    });
    deepStrictEqual((result.futureSeries as CalendarEvent).recurrence, [
      "RRULE:FREQ=DAILY;COUNT=3",
    ]);
    ok((result.futureSeries as CalendarEvent).conferenceData?.createRequest);
    series(f);
    f.state.futureExceptions = [
      {
        id: "moved-future",
        recurringEventId: "series",
        originalStartTime: { dateTime: "2026-11-06T10:00:00+01:00" },
        start: { dateTime: "2026-10-01T10:00:00+01:00" },
      },
    ];
    const count = f.calls.filter(
      (call) => call.options.method === "POST",
    ).length;
    await rejects(
      f.run("split_series", {
        instanceId: "instance",
        changes: { summary: "Unsafe" },
      }),
      /modified future/,
    );
    strictEqual(
      f.calls.filter((call) => call.options.method === "POST").length,
      count,
    );
    const scan = f.calls.find(
      (call) =>
        call.resource === "/events" &&
        call.options.query?.singleEvents === "false",
    );
    strictEqual(scan?.options.query?.timeMin, undefined);
  } finally {
    await f.database.destroy();
  }
});

test("A new watch registration supersedes an in-flight poll even when Google returns the same cursor", async () => {
  const f = await fixture();
  let sent = 0;
  const telegram = {
    sendRichMessage: async () => {
      sent++;
      return {};
    },
  } as unknown as Parameters<typeof pollCalendarWatches>[1];
  try {
    await watchCalendar(f.database, f.binding, 1, f.api);
    f.state.changes = [{ id: "new", summary: "Change" }];
    f.state.before = async (_resource, options) => {
      if (!options.query?.syncToken) return;
      f.state.before = undefined;
      await unwatchCalendar(f.database, -100, f.binding.calendar_id);
      await watchCalendar(f.database, f.binding, 2, f.api);
    };
    await pollCalendarWatches(f.database, telegram, f.api);
    strictEqual(sent, 0);
    strictEqual(
      (
        await f.database
          .selectFrom("calendar_watches")
          .selectAll()
          .executeTakeFirst()
      )?.thread_id,
      2,
    );
  } finally {
    await f.database.destroy();
  }
});

test("Watch setup rechecks authorization after fetching its baseline", async () => {
  const f = await fixture();
  try {
    f.state.before = async () => {
      await setCalendarMcpEnabled(f.database, -100, false);
    };
    await rejects(f.run("watch_calendar", {}), /disabled/);
    strictEqual(
      (await f.database.selectFrom("calendar_watches").selectAll().execute())
        .length,
      0,
    );
  } finally {
    await f.database.destroy();
  }
});

test("Calendar metadata edits validate working hours, preserve omitted values and use version checks", async () => {
  const f = await fixture();
  try {
    await rejects(
      f.run("update_calendar", {
        workingHours: { workingHoursEnabled: true, availableTimes: [] },
      }),
      /availability period/,
    );
    await rejects(
      f.run("update_calendar", {
        workingHours: {
          workingHoursEnabled: true,
          availableTimes: [
            { dayOfWeek: "monday", periodStart: 900, periodEnd: 500 },
          ],
        },
      }),
      /end after/,
    );
    const labels = {
      eventLabels: [{ backgroundColor: "#039be5", name: "Work" }],
    };
    const hours = {
      workingHoursEnabled: true,
      availableTimes: [
        { dayOfWeek: "monday", periodStart: 540, periodEnd: 1020 },
      ],
    };
    await f.run("update_calendar", {
      summary: "Renamed",
      labelProperties: labels,
      workingHours: hours,
    });
    strictEqual(f.calls.at(-1)?.options.etag, '"metadata"');
    deepStrictEqual(f.calls.at(-1)?.options.body, {
      summary: "Renamed",
      labelProperties: labels,
      workingHours: hours,
    });
    strictEqual((await getChatCalendars(f.database, -100))[0].name, "Renamed");
    strictEqual((await getChatCalendar(f.database, -100))?.name, "Renamed");
  } finally {
    await f.database.destroy();
  }
});
