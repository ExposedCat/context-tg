import { createDebug } from "@grammyjs/debug";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type OpenAI from "openai";
import {
  type CalendarApi,
  type ChatCalendarTable,
  getChatCalendar,
} from "./calendar-settings.ts";
import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";
import {
  type CalendarEvent,
  type CalendarEventsPage,
  getGoogleCalendarApi,
} from "./google-calendar.ts";
import type { FunctionToolRunner, LlmToolContext } from "./llm-tools/types.ts";
import { getCalendarMcpEnabled } from "./user-settings.ts";

const logError = createDebug("app:calendar-mcp:error");
const TOOL_NAMES = [
  "get_calendar",
  "list_events",
  "get_event",
  "create_event",
  "update_event",
] as const;
export type CalendarToolName = `calendar_${(typeof TOOL_NAMES)[number]}`;
export type CalendarMcpTools = {
  definitions: OpenAI.Responses.FunctionTool[];
  runners: Map<CalendarToolName, FunctionToolRunner>;
  close: () => Promise<void>;
};

export function isCalendarToolName(name: string): name is CalendarToolName {
  return TOOL_NAMES.some((tool) => name === `calendar_${tool}`);
}

const eventTime = {
  type: "object",
  properties: {
    date: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "All-day date. End date is exclusive.",
    },
    dateTime: {
      type: "string",
      description: "RFC3339 date and time with explicit UTC offset.",
    },
    timeZone: {
      type: "string",
      description: "IANA time zone; defaults to the calendar's zone.",
    },
  },
  oneOf: [
    { required: ["date"], not: { required: ["dateTime"] } },
    { required: ["dateTime"], not: { required: ["date"] } },
  ],
  additionalProperties: false,
};
const eventFields = {
  summary: { type: "string", minLength: 1, maxLength: 1000 },
  description: { type: "string", maxLength: 8000 },
  location: { type: "string", maxLength: 2000 },
  start: eventTime,
  end: eventTime,
};
const eventId = { type: "string", pattern: "^[A-Za-z0-9_-]{1,1024}$" };
const schema = (
  properties: Record<string, object>,
  required: string[] = [],
): Tool["inputSchema"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const tools: Tool[] = [
  {
    name: "get_calendar",
    description:
      "Read the verified calendar's name and time zone for the current chat.",
    inputSchema: schema({}),
  },
  {
    name: "list_events",
    description:
      "List or search this chat's verified calendar in a bounded RFC3339 time range. Follow nextPageToken for more results.",
    inputSchema: schema(
      {
        timeMin: { type: "string" },
        timeMax: { type: "string" },
        q: { type: "string", maxLength: 1000 },
        pageToken: { type: "string", maxLength: 4096 },
        maxResults: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["timeMin", "timeMax"],
    ),
  },
  {
    name: "get_event",
    description:
      "Read a specific event in this chat's verified calendar before editing it.",
    inputSchema: schema({ eventId }, ["eventId"]),
  },
  {
    name: "create_event",
    description:
      "Create an event in this chat's verified calendar when requested. Supports timed and all-day events, without guests. Do not retry ambiguous failures without checking the calendar first.",
    inputSchema: schema(eventFields, ["summary", "start", "end"]),
  },
  {
    name: "update_event",
    description:
      "Edit selected fields of an existing event in this chat's verified calendar. Unspecified fields are preserved. Use the exact event ID; clarify instance versus whole series when needed.",
    inputSchema: schema({ eventId, ...eventFields }, ["eventId"]),
  },
];
const validator = new AjvJsonSchemaValidator();
const validators = new Map(
  tools.map((tool) => [
    tool.name,
    validator.getValidator<Record<string, unknown>>(tool.inputSchema),
  ]),
);

function dateTimeValue(value: unknown): number {
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
  return Date.parse(value);
}

function validateEventTimes(
  start: CalendarEvent["start"],
  end: CalendarEvent["end"],
  timeZone: string,
) {
  if (!start || !end || Boolean(start.date) !== Boolean(end.date))
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
    if (time.dateTime) dateTimeValue(time.dateTime);
    try {
      new Intl.DateTimeFormat("en", { timeZone: time.timeZone ?? timeZone });
    } catch {
      throw new Error("Invalid calendar time zone.");
    }
  }
  if (
    Date.parse(end.date ?? end.dateTime ?? "") <=
    Date.parse(start.date ?? start.dateTime ?? "")
  )
    throw new Error(
      "The event must end after it starts. All-day end dates are exclusive.",
    );
}

function eventOutput(event: CalendarEvent) {
  const {
    id,
    summary,
    description,
    location,
    status,
    start,
    end,
    htmlLink,
    recurrence,
    recurringEventId,
  } = event;
  return {
    id,
    summary,
    description,
    location,
    status,
    start,
    end,
    htmlLink,
    recurrence,
    recurringEventId,
  };
}

async function execute(
  name: string,
  args: Record<string, unknown>,
  binding: ChatCalendarTable,
  api: CalendarApi,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const calendarId = binding.calendar_id;
  if (name === "get_calendar") {
    const metadata = await api.metadata(calendarId, signal);
    return { name: metadata.summary, timeZone: metadata.timeZone };
  }
  if (name === "list_events") {
    if (dateTimeValue(args.timeMax) <= dateTimeValue(args.timeMin))
      throw new Error("timeMax must be after timeMin.");
    const page = await api.request<CalendarEventsPage>(calendarId, "/events", {
      signal,
      query: {
        timeMin: String(args.timeMin),
        timeMax: String(args.timeMax),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(args.maxResults ?? 50),
        ...(args.q ? { q: String(args.q) } : {}),
        ...(args.pageToken ? { pageToken: String(args.pageToken) } : {}),
      },
    });
    return {
      events: page.items?.map(eventOutput) ?? [],
      nextPageToken: page.nextPageToken,
    };
  }
  const resource = `/events/${encodeURIComponent(String(args.eventId))}`;
  if (name === "get_event")
    return eventOutput(
      await api.request<CalendarEvent>(calendarId, resource, { signal }),
    );
  const body: Record<string, unknown> = {};
  for (const field of Object.keys(eventFields)) {
    if (args[field] !== undefined) body[field] = args[field];
  }
  if (
    typeof body.summary === "string" &&
    body.summary.startsWith("Telegram Integration #")
  )
    throw new Error(
      "Verification events must be created manually by the person linking the calendar.",
    );
  for (const field of ["start", "end"] as const) {
    const value = body[field] as CalendarEvent["start"];
    if (value?.dateTime)
      body[field] = { ...value, timeZone: value.timeZone ?? binding.time_zone };
  }
  if (name === "create_event") {
    validateEventTimes(
      body.start as CalendarEvent["start"],
      body.end as CalendarEvent["end"],
      binding.time_zone,
    );
    // Caller-supplied event IDs allow recovery after a lost HTTP response.
    body.id = crypto.randomUUID().replaceAll("-", "");
    return eventOutput(
      await api.request<CalendarEvent>(calendarId, "/events", {
        method: "POST",
        body,
        signal,
      }),
    );
  }
  if (name !== "update_event" || !Object.keys(body).length)
    throw new Error("Provide at least one field to update.");
  const current = await api.request<CalendarEvent>(calendarId, resource, {
    signal,
  });
  if (!current.etag)
    throw new Error(
      "Cannot safely edit an event without its version. Read it again.",
    );
  if (body.start || body.end)
    validateEventTimes(
      (body.start ?? current.start) as CalendarEvent["start"],
      (body.end ?? current.end) as CalendarEvent["end"],
      binding.time_zone,
    );
  return eventOutput(
    await api.request<CalendarEvent>(calendarId, resource, {
      method: "PATCH",
      body,
      etag: current.etag,
      signal,
    }),
  );
}

export async function connectCalendarMcp(
  database: Database | undefined,
  context: LlmToolContext | undefined,
  signal?: AbortSignal,
): Promise<CalendarMcpTools | undefined> {
  if (
    !database ||
    !context?.userId ||
    !Number.isSafeInteger(context.userId) ||
    context.userId <= 0 ||
    !APP_ENV.GOOGLE_CALENDAR_CREDENTIALS ||
    !(await getCalendarMcpEnabled(database, context.userId))
  )
    return;
  const binding = await getChatCalendar(database, context.chatId);
  if (!binding) return;
  const userId = context.userId;
  const client = new Client({ name: "context-tg-calendar", version: "1.0.0" });
  const server = new Server(
    { name: "Calendar MCP", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const close = async () => {
    await client.close();
    await server.close();
  };
  try {
    const api = await getGoogleCalendarApi();
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      // Bind authorization to this request, never to model-selected IDs. Recheck
      // so a setting change or relink takes effect even during a tool loop.
      if (
        !(await getCalendarMcpEnabled(database, userId)) ||
        (await getChatCalendar(database, context.chatId))?.verification_id !==
          binding.verification_id
      )
        throw new Error(
          "Calendar MCP was disabled or the chat calendar changed.",
        );
      const validated = validators.get(request.params.name)?.(
        request.params.arguments ?? {},
      );
      if (!validated?.valid)
        throw new Error(
          "Invalid Calendar MCP arguments. Account and calendar IDs cannot be supplied.",
        );
      const result = await execute(
        request.params.name,
        validated.data,
        binding,
        api,
        AbortSignal.any([extra.signal, ...(signal ? [signal] : [])]),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const discovered = await client.listTools(undefined, { signal });
    const definitions: OpenAI.Responses.FunctionTool[] = [];
    const runners = new Map<CalendarToolName, FunctionToolRunner>();
    for (const tool of discovered.tools) {
      const name = `calendar_${tool.name}`;
      if (!isCalendarToolName(name))
        throw new Error("Unknown Calendar MCP tool.");
      definitions.push({
        type: "function",
        name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: false,
      });
      runners.set(name, async (args, _ctx, options) => {
        const result = await client.callTool(
          { name: tool.name, arguments: args ?? {} },
          undefined,
          {
            signal: options?.signal,
            timeout: 60_000,
          },
        );
        if (result.isError) throw new Error("Calendar MCP tool failed.");
        return JSON.stringify(result.structuredContent ?? result.content);
      });
    }
    return { definitions, runners, close };
  } catch (error) {
    await close().catch(() => {});
    signal?.throwIfAborted();
    logError("Calendar MCP unavailable", { error });
    return;
  }
}
