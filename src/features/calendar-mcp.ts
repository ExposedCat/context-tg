import { createDebug } from "@grammyjs/debug";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Api } from "grammy";
import type OpenAI from "openai";
import { isBotAdminId } from "./authorization.ts";
import { executeCalendarOperation } from "./calendar-actions.ts";
import {
  ADMIN_CALENDAR_OPERATIONS,
  CALENDAR_TOOL_NAMES,
  CALENDAR_TOOLS,
  type CalendarOperation,
} from "./calendar-schema.ts";
import {
  type ChatCalendarTable,
  getCalendarMcpEnabled,
  getChatCalendars,
} from "./calendar-settings.ts";
import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";
import { getGoogleCalendarApi } from "./google-calendar.ts";
import type { FunctionToolRunner, LlmToolContext } from "./llm-tools/types.ts";

const logError = createDebug("app:calendar-mcp:error");
export type CalendarToolName = `calendar_${CalendarOperation}`;
export type CalendarMcpTools = {
  definitions: OpenAI.Responses.FunctionTool[];
  runners: Map<CalendarToolName, FunctionToolRunner>;
  close: () => Promise<void>;
};

export function isCalendarToolName(name: string): name is CalendarToolName {
  return CALENDAR_TOOL_NAMES.some((tool) => name === `calendar_${tool}`);
}

const validator = new AjvJsonSchemaValidator();
const validators = new Map(
  CALENDAR_TOOLS.map((tool) => [
    tool.name,
    validator.getValidator<Record<string, unknown>>(tool.inputSchema),
  ]),
);

export async function connectCalendarMcp(
  database: Database | undefined,
  context: LlmToolContext | undefined,
  signal?: AbortSignal,
  telegram?: Pick<Api, "getChatMember">,
): Promise<CalendarMcpTools | undefined> {
  if (
    !database ||
    !context ||
    !APP_ENV.GOOGLE_CALENDAR_CREDENTIALS ||
    !(await getCalendarMcpEnabled(database, context.chatId))
  )
    return;
  const bindings = await getChatCalendars(database, context.chatId);
  if (!bindings.length) return;
  const versions = new Map(
    bindings.map((binding) => [binding.calendar_id, binding.verification_id]),
  );
  const assertEnabled = async () => {
    if (!(await getCalendarMcpEnabled(database, context.chatId)))
      throw new Error("Calendar MCP was disabled for this chat.");
    const current = await getChatCalendars(database, context.chatId);
    if (
      !current.some(
        (item) => versions.get(item.calendar_id) === item.verification_id,
      )
    )
      throw new Error("The chat calendar changed. Start a new request.");
    return current;
  };
  const authorize = async (id?: string): Promise<ChatCalendarTable> => {
    const current = await assertEnabled();
    if (!id && current.length !== 1)
      throw new Error(
        "Multiple calendars are linked. Choose calendarId from list_calendars.",
      );
    const binding = current.find(
      (item) => item.calendar_id === (id ?? current[0]?.calendar_id),
    );
    if (!binding)
      throw new Error("This calendar is not verified for this chat.");
    if (versions.get(binding.calendar_id) !== binding.verification_id)
      throw new Error("The chat calendar changed. Start a new request.");
    return binding;
  };
  const authorizeAdmin = async () => {
    const userId = context.userId;
    if (
      isBotAdminId(userId) ||
      (userId !== undefined && context.chatId === userId)
    )
      return;
    if (userId !== undefined && context.chatId < 0 && telegram) {
      const member = await telegram.getChatMember(context.chatId, userId);
      if (member.status === "creator" || member.status === "administrator")
        return;
    }
    throw new Error(
      "Only a chat administrator can manage calendar links, settings, sharing or watches.",
    );
  };
  const client = new Client({ name: "context-tg-calendar", version: "1.0.0" });
  const server = new Server(
    { name: "Calendar MCP", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const close = async () => {
    try {
      await client.close();
    } finally {
      await server.close();
    }
  };
  try {
    const api = await getGoogleCalendarApi();
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: CALENDAR_TOOLS,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      await assertEnabled();
      const name = request.params.name as CalendarOperation;
      const validated = validators.get(name)?.(request.params.arguments ?? {});
      if (!validated?.valid) throw new Error("Invalid Calendar MCP arguments.");
      if (ADMIN_CALENDAR_OPERATIONS.has(name)) await authorizeAdmin();
      const result = await executeCalendarOperation(name, validated.data, {
        database,
        context,
        api,
        authorize,
        signal: AbortSignal.any([extra.signal, ...(signal ? [signal] : [])]),
      });
      // Only a calendar created by this authenticated operation joins this session.
      if (name === "create_calendar" && result.linked) {
        const created = result.calendar as { id: string };
        const binding = (await getChatCalendars(database, context.chatId)).find(
          (item) => item.calendar_id === created.id,
        );
        if (binding) versions.set(binding.calendar_id, binding.verification_id);
      }
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
