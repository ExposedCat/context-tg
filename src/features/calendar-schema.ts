import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const CALENDAR_TOOL_NAMES = [
  "get_calendar",
  "list_calendars",
  "list_events",
  "get_event",
  "list_instances",
  "create_event",
  "update_event",
  "cancel_event",
  "restore_event",
  "split_series",
  "respond_to_event",
  "free_busy",
  "get_colors",
  "import_event",
  "export_events",
  "move_event",
  "update_calendar",
  "create_calendar",
  "list_sharing",
  "set_sharing",
  "unlink_calendar",
  "watch_calendar",
  "unwatch_calendar",
  "batch_update_events",
] as const;
export type CalendarOperation = (typeof CALENDAR_TOOL_NAMES)[number];
export const ADMIN_CALENDAR_OPERATIONS = new Set<CalendarOperation>([
  "update_calendar",
  "create_calendar",
  "set_sharing",
  "unlink_calendar",
  "watch_calendar",
  "unwatch_calendar",
]);
const text = { type: "string", maxLength: 8000 };
const boolean = { type: "boolean" };
export const CALENDAR_ID = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  description:
    "An ID returned by list_calendars. Only this chat's verified calendars are accessible.",
};
export const EVENT_ID = { type: "string", pattern: "^[A-Za-z0-9_-]{1,1024}$" };
const eventTime = {
  type: "object",
  additionalProperties: false,
  properties: {
    date: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "All-day date; the end date is exclusive.",
    },
    dateTime: {
      type: "string",
      description: "RFC3339 timestamp with an explicit UTC offset.",
    },
    timeZone: {
      type: "string",
      description:
        "IANA time zone. Required for timed recurring events; defaults to the calendar time zone.",
    },
  },
  oneOf: [
    { required: ["date"], not: { required: ["dateTime"] } },
    { required: ["dateTime"], not: { required: ["date"] } },
  ],
};
const stringMap = {
  type: "object",
  maxProperties: 100,
  additionalProperties: { type: "string", maxLength: 1024 },
};
const reminder = {
  type: "object",
  additionalProperties: false,
  required: ["method", "minutes"],
  properties: {
    method: { enum: ["email", "popup"] },
    minutes: { type: "integer", minimum: 0, maximum: 40320 },
  },
};
export const EVENT_FIELDS: Record<string, object> = {
  summary: { type: "string", maxLength: 1000 },
  description: text,
  location: { type: "string", maxLength: 2000 },
  start: eventTime,
  end: eventTime,
  recurrence: {
    type: "array",
    maxItems: 32,
    items: { type: "string", maxLength: 2048 },
    description:
      'RFC5545 RRULE, RDATE, EXDATE or EXRULE lines, without DTSTART/DTEND. Example: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]. An empty array removes recurrence.',
  },
  reminders: {
    type: "object",
    additionalProperties: false,
    required: ["useDefault"],
    properties: {
      useDefault: boolean,
      overrides: { type: "array", maxItems: 5, items: reminder },
    },
  },
  colorId: { type: "string", pattern: "^[0-9]{1,3}$" },
  eventLabelId: {
    type: "string",
    maxLength: 1024,
    description:
      "A label ID from get_calendar.labelProperties.eventLabels; empty string removes the label. Overrides legacy colorId when supplied.",
  },
  sequence: {
    type: "integer",
    minimum: 0,
    maximum: 2147483647,
    description:
      "iCalendar sequence number. Set only for explicit import/synchronization requests.",
  },
  source: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", format: "uri", pattern: "^https?://" },
      title: text,
    },
    description:
      "Origin URL/title; only the event creator can see or modify it.",
  },
  visibility: { enum: ["default", "public", "private", "confidential"] },
  transparency: {
    enum: ["opaque", "transparent"],
    description: "opaque blocks time; transparent shows as free.",
  },
  status: {
    enum: ["confirmed", "tentative"],
    description: "Use cancel_event to cancel. Deletion is unavailable.",
  },
  attendees: {
    type: "array",
    maxItems: 200,
    description:
      "Replaces the attendee array. Google restricts service-account attendee operations without domain-wide delegation; do not promise invitations will work.",
    items: {
      type: "object",
      required: ["email"],
      additionalProperties: false,
      properties: {
        email: { type: "string", format: "email" },
        displayName: text,
        optional: boolean,
        resource: boolean,
        responseStatus: {
          enum: ["needsAction", "declined", "tentative", "accepted"],
        },
        comment: text,
        additionalGuests: { type: "integer", minimum: 0, maximum: 100 },
      },
    },
  },
  guestsCanInviteOthers: boolean,
  guestsCanModify: boolean,
  guestsCanSeeOtherGuests: boolean,
  attachments: {
    type: "array",
    maxItems: 25,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["fileUrl"],
      properties: {
        fileUrl: { type: "string", format: "uri", pattern: "^https://" },
        title: text,
      },
    },
  },
  extendedProperties: {
    type: "object",
    additionalProperties: false,
    properties: { private: stringMap, shared: stringMap },
  },
  conferenceData: {
    type: ["object", "null"],
    description:
      "Existing conference data, or null to remove it. Use addGoogleMeet to request a new, unique Meet conference.",
    additionalProperties: true,
  },
  eventType: {
    enum: [
      "default",
      "focusTime",
      "outOfOffice",
      "workingLocation",
      "birthday",
    ],
    description:
      "Immutable after creation. Google limits special types to supported accounts/calendars.",
  },
  focusTimeProperties: {
    type: "object",
    additionalProperties: false,
    properties: {
      autoDeclineMode: {
        enum: [
          "declineNone",
          "declineAllConflictingInvitations",
          "declineOnlyNewConflictingInvitations",
        ],
      },
      declineMessage: text,
      chatStatus: { enum: ["available", "doNotDisturb"] },
    },
  },
  outOfOfficeProperties: {
    type: "object",
    additionalProperties: false,
    properties: {
      autoDeclineMode: {
        enum: [
          "declineNone",
          "declineAllConflictingInvitations",
          "declineOnlyNewConflictingInvitations",
        ],
      },
      declineMessage: text,
    },
  },
  workingLocationProperties: {
    type: "object",
    additionalProperties: true,
    properties: {
      type: { enum: ["homeOffice", "officeLocation", "customLocation"] },
      homeOffice: { type: "object" },
      customLocation: {
        type: "object",
        required: ["label"],
        properties: { label: text },
        additionalProperties: false,
      },
      officeLocation: {
        type: "object",
        properties: {
          buildingId: text,
          floorId: text,
          floorSectionId: text,
          deskId: text,
          label: text,
        },
        additionalProperties: false,
      },
    },
  },
  birthdayProperties: {
    type: "object",
    required: ["type"],
    additionalProperties: false,
    properties: { type: { const: "birthday" } },
  },
};
const writeOptions = {
  addGoogleMeet: {
    type: "boolean",
    description:
      "Request a unique Google Meet conference, if the calendar permits it.",
  },
  sendUpdates: {
    enum: ["all", "externalOnly", "none"],
    description:
      "Guest notifications. Defaults to all for user-requested edits.",
  },
};
const selector = { calendarId: CALENDAR_ID };
const range = { timeMin: { type: "string" }, timeMax: { type: "string" } };
const page = {
  pageToken: { type: "string", maxLength: 4096 },
  maxResults: { type: "integer", minimum: 1, maximum: 250 },
};
const listProperties = {
  ...selector,
  ...range,
  ...page,
  q: text,
  expandRecurring: boolean,
  showCancelled: boolean,
  updatedMin: { type: "string" },
  iCalUID: text,
  eventTypes: {
    type: "array",
    items: {
      enum: [
        "default",
        "focusTime",
        "outOfOffice",
        "workingLocation",
        "birthday",
        "fromGmail",
      ],
    },
  },
  privateExtendedProperty: { type: "array", maxItems: 20, items: text },
  sharedExtendedProperty: { type: "array", maxItems: 20, items: text },
};
function schema(
  properties: Record<string, object>,
  required: string[] = [],
): Tool["inputSchema"] {
  return { type: "object", properties, required, additionalProperties: false };
}
export const CALENDAR_FIELDS: Record<string, object> = {
  summary: { type: "string", minLength: 1, maxLength: 1000 },
  description: text,
  location: text,
  timeZone: { type: "string" },
  labelProperties: {
    type: "object",
    additionalProperties: false,
    properties: {
      eventLabels: {
        type: "array",
        maxItems: 200,
        description:
          "Replaces all event labels. Read first and preserve labels not explicitly being removed.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["backgroundColor"],
          properties: {
            id: { type: "string", format: "uuid" },
            backgroundColor: { type: "string", pattern: "^#[A-Fa-f0-9]{6}$" },
            name: { type: "string", maxLength: 50 },
          },
        },
      },
    },
  },
  workingHours: {
    type: "object",
    additionalProperties: false,
    required: ["workingHoursEnabled"],
    description:
      "Google Workspace primary calendars only. Replaces the complete working-hours schedule.",
    properties: {
      workingHoursEnabled: boolean,
      availableTimes: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["dayOfWeek", "periodStart", "periodEnd"],
          properties: {
            dayOfWeek: {
              enum: [
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday",
              ],
            },
            periodStart: { type: "integer", minimum: 0, maximum: 1439 },
            periodEnd: { type: "integer", minimum: 1, maximum: 1440 },
          },
        },
      },
    },
  },
};
const specifications: Record<
  CalendarOperation,
  { description: string; inputSchema: Tool["inputSchema"] }
> = {
  list_calendars: {
    description:
      "List only calendars verified for this chat. If multiple are linked, choose calendarId explicitly for other tools.",
    inputSchema: schema({}),
  },
  get_calendar: {
    description:
      "Read calendar metadata and the service-account capability limitations.",
    inputSchema: schema(selector),
  },
  list_events: {
    description:
      "Read/search events in a bounded RFC3339 range. Defaults to expanded recurring instances; set expandRecurring=false for recurring masters. All event fields are returned. Follow nextPageToken.",
    inputSchema: schema(listProperties, ["timeMin", "timeMax"]),
  },
  export_events: {
    description:
      "Export Google Calendar event resources as JSON, preserving recurrence and event settings. Set expandRecurring=false to export series masters. Follow nextPageToken to export more pages.",
    inputSchema: schema(listProperties, ["timeMin", "timeMax"]),
  },
  get_event: {
    description:
      "Read the full event, including reminders, guests, organizer, conference data, recurrence and version before changing it.",
    inputSchema: schema({ ...selector, eventId: EVENT_ID }, ["eventId"]),
  },
  list_instances: {
    description:
      "List occurrences/exceptions of a recurring series within a time range, including originalStartTime and instance IDs.",
    inputSchema: schema(
      {
        ...selector,
        ...range,
        ...page,
        eventId: EVENT_ID,
        showCancelled: boolean,
      },
      ["eventId", "timeMin", "timeMax"],
    ),
  },
  create_event: {
    description:
      "Create a timed, all-day or recurring event with reminders, attachments, visibility, availability, conference and supported special-type settings. Google may reject guest operations for service accounts. Never retry ambiguous creation failures without checking the returned recovery event ID.",
    inputSchema: schema({ ...selector, ...EVENT_FIELDS, ...writeOptions }, [
      "summary",
      "start",
      "end",
    ]),
  },
  update_event: {
    description:
      "Patch event fields with a version check, preserving omitted values. scope=occurrence edits one instance; scope=series targets its recurring master. To change this and following occurrences, use split_series. Arrays replace their existing values, so read first. Changing recurrence to [] makes it non-recurring.",
    inputSchema: schema(
      {
        ...selector,
        ...EVENT_FIELDS,
        ...writeOptions,
        eventId: EVENT_ID,
        scope: { enum: ["occurrence", "series"] },
      },
      ["eventId"],
    ),
  },
  cancel_event: {
    description:
      "Native Google cancellation. It sets status=cancelled or trims following recurrences; Google may hide the event as a deleted/cancelled entry. No HTTP DELETE is used. State explicitly whether cancelling one occurrence, a series, or this and following. A snapshot is saved for restoration when Google permits it.",
    inputSchema: schema(
      {
        ...selector,
        ...writeOptions,
        eventId: EVENT_ID,
        scope: { enum: ["occurrence", "series", "following"] },
      },
      ["eventId", "scope"],
    ),
  },
  restore_event: {
    description:
      "Restore a natively cancelled event or a truncated series using the snapshot saved by cancel_event. Google may refuse restoration after purging cancelled data. If restoring a following cancellation, use restoreEventId from its result.",
    inputSchema: schema(
      { ...selector, eventId: EVENT_ID, sendUpdates: writeOptions.sendUpdates },
      ["eventId"],
    ),
  },
  split_series: {
    description:
      "Change this and following occurrences by splitting an ordinary RRULE series at the supplied instance ID. Preserves occurrence count or original UNTIL. Complex RDATE/EXDATE sets and modified future exceptions require whole-series or individual-instance edits instead. Existing conference data is not copied automatically; use changes.addGoogleMeet=true to request a new meeting, or explicitly supply conferenceData. Returns partial success explicitly if the final trim conflicts; do not repeat creation blindly.",
    inputSchema: schema(
      {
        ...selector,
        instanceId: EVENT_ID,
        changes: schema({
          ...EVENT_FIELDS,
          addGoogleMeet: writeOptions.addGoogleMeet,
        }),
        sendUpdates: writeOptions.sendUpdates,
      },
      ["instanceId", "changes"],
    ),
  },
  respond_to_event: {
    description:
      "Attempt to respond to an invitation on behalf of the linked calendar's attendee entry, preserving other guests. Google may prohibit this for a shared-calendar service account; it cannot impersonate an unrelated attendee.",
    inputSchema: schema(
      {
        ...selector,
        eventId: EVENT_ID,
        responseStatus: {
          enum: ["accepted", "declined", "tentative", "needsAction"],
        },
        comment: text,
        sendUpdates: writeOptions.sendUpdates,
      },
      ["eventId", "responseStatus"],
    ),
  },
  free_busy: {
    description:
      "Query actual free/busy intervals for this chat's verified calendars only. Omit calendarIds to query all linked calendars.",
    inputSchema: schema(
      {
        ...range,
        timeZone: { type: "string" },
        calendarIds: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: CALENDAR_ID,
        },
      },
      ["timeMin", "timeMax"],
    ),
  },
  get_colors: {
    description: "Read Google's current event and calendar color palette.",
    inputSchema: schema({}),
  },
  import_event: {
    description:
      "Import a private copy of a default event using its iCalUID, with event settings and recurrence. Does not import organizer/creator identities or change ownership.",
    inputSchema: schema(
      {
        ...selector,
        ...EVENT_FIELDS,
        iCalUID: { type: "string", minLength: 1, maxLength: 1024 },
      },
      ["iCalUID", "summary", "start", "end"],
    ),
  },
  move_event: {
    description:
      "Move a default event between two calendars already verified for this chat, changing its organizer. Google requires suitable access to both. No destination outside this chat's allowlist is permitted.",
    inputSchema: schema(
      {
        ...selector,
        eventId: EVENT_ID,
        destinationCalendarId: CALENDAR_ID,
        sendUpdates: writeOptions.sendUpdates,
      },
      ["eventId", "destinationCalendarId"],
    ),
  },
  update_calendar: {
    description:
      "Chat administrators only: edit the linked calendar's title, description, location, time zone, event labels or supported working hours. Google usually requires calendar-manager permission, beyond Make changes to events.",
    inputSchema: schema({ ...selector, ...CALENDAR_FIELDS }),
  },
  create_calendar: {
    description:
      "Chat administrators only: explicitly create a new service-account-owned secondary calendar and link it to this chat. Google warns that service-account data ownership cannot be transferred. Only use when the user explicitly wants a bot-owned calendar. Optional shareWithEmail grants a human manager access, not data ownership.",
    inputSchema: schema(
      {
        ...CALENDAR_FIELDS,
        shareWithEmail: { type: "string", format: "email" },
      },
      ["summary"],
    ),
  },
  list_sharing: {
    description: "Read the linked calendar's sharing rules, with pagination.",
    inputSchema: schema({ ...selector, ...page }),
  },
  set_sharing: {
    description:
      "Chat administrators only: grant/change/revoke a sharing rule. Google requires manager access. role=none revokes access without an HTTP DELETE request. Never remove or downgrade the bot's own access, or broaden sharing unless the user explicitly requests it.",
    inputSchema: schema(
      {
        ...selector,
        scope: {
          type: "object",
          required: ["type"],
          additionalProperties: false,
          properties: {
            type: { enum: ["user", "group", "domain", "default"] },
            value: { type: "string", maxLength: 1024 },
          },
        },
        role: { enum: ["none", "freeBusyReader", "reader", "writer", "owner"] },
        sendNotifications: boolean,
      },
      ["scope", "role"],
    ),
  },
  unlink_calendar: {
    description:
      "Chat administrators only: disconnect a calendar from this chat and stop its watcher. Does not delete the Google calendar, its events, or its sharing rules.",
    inputSchema: schema({ calendarId: CALENDAR_ID }, ["calendarId"]),
  },
  watch_calendar: {
    description:
      "Chat administrators only, on explicit request: watch this calendar for changes and post summaries to this chat/topic. Polls approximately once per minute. Existing events establish a baseline and are not replayed.",
    inputSchema: schema(selector),
  },
  unwatch_calendar: {
    description:
      "Chat administrators only: stop automatic change summaries for this calendar.",
    inputSchema: schema(selector),
  },
  batch_update_events: {
    description:
      "Patch up to 20 events sequentially, with individual version checks and explicit partial-failure results. No deletion or status=cancelled; use cancel_event for cancellation. Arrays replace previous values.",
    inputSchema: schema(
      {
        ...selector,
        updates: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: schema({ eventId: EVENT_ID, changes: schema(EVENT_FIELDS) }, [
            "eventId",
            "changes",
          ]),
        },
        sendUpdates: writeOptions.sendUpdates,
      },
      ["updates"],
    ),
  },
};
export const CALENDAR_TOOLS: Tool[] = CALENDAR_TOOL_NAMES.map((name) => ({
  name,
  ...specifications[name],
}));
