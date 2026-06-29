import { MAX_LAST_MESSAGES_COUNT, readLastMessages } from "../last-messages.ts";
import { search as searchMessages } from "../messages.ts";
import type { FunctionToolRunner, LlmToolContext } from "./types.ts";

export const searchChatToolDefinition = {
  type: "function",
  name: "search_chat",
  description:
    "Search remembered text messages in the current Telegram chat or forum topic. The sender_id and date filters are optional; only use them when the user explicitly needs a sender or date range filter. Prefer using only queries.",
  parameters: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        description:
          "One or more semantic search queries. Prefer concise natural-language queries, and include a sender name in the query when searching by name.",
        items: {
          type: "string",
        },
      },
      from: {
        type: "string",
        description:
          "Optional inclusive ISO 8601 start date. Only use when the user explicitly asks for a date or time range.",
      },
      to: {
        type: "string",
        description:
          "Optional inclusive ISO 8601 end date. Only use when the user explicitly asks for a date or time range.",
      },
      sender_id: {
        type: "number",
        description:
          "Optional Telegram sender id. Only use when the user explicitly gives or requires a sender id filter.",
      },
    },
    required: ["queries"],
    additionalProperties: false,
  },
  strict: false,
} as const;

export const readLastMessagesToolDefinition = {
  type: "function",
  name: "read_last_messages",
  description:
    "Read recent remembered text messages from the current Telegram chat. Use this when the user asks about the latest or surrounding chat context rather than semantic search. Only quote messages when you are asked to do so. If you are tasked to do a summary or help with ongoing discussion, you must read messages as an extra context, do not just list recite entire discussion uneless explicitly requested to do so.",
  parameters: {
    type: "object",
    properties: {
      count: {
        type: "number",
        description:
          "How many recent messages to read back from the anchor message. Maximum is 300.",
        minimum: 1,
        maximum: MAX_LAST_MESSAGES_COUNT,
      },
    },
    required: ["count"],
    additionalProperties: false,
  },
  strict: true,
} as const;

function parseOptionalDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function parseCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.min(MAX_LAST_MESSAGES_COUNT, Math.floor(value)));
}

function formatMessageLine(message: {
  date: string;
  sender_name: string;
  text: string;
}): string {
  const content = message.text.replaceAll(/\s+/g, " ").trim();
  return `[${message.date}] ${message.sender_name}: ${JSON.stringify(content)}`;
}

function getMissingContextResponse(tool: string, context?: LlmToolContext) {
  return context
    ? undefined
    : `Cannot ${tool}: current chat context is unavailable.`;
}

export const executeSearchChat: FunctionToolRunner = async (args, context) => {
  const missingContext = getMissingContextResponse("search chat", context);
  if (missingContext || !context) {
    return missingContext ?? "";
  }

  const queries = Array.isArray(args?.queries)
    ? args.queries.filter((query): query is string => typeof query === "string")
    : [];
  const results = await searchMessages({
    queries,
    from: parseOptionalDate(args?.from),
    to: parseOptionalDate(args?.to),
    chatId: context.chatId,
    threadId: context.threadId,
    senderId: parseOptionalNumber(args?.sender_id),
    limit: 20,
  });

  return results.length > 0
    ? results.map(formatMessageLine).join("\n")
    : "No matching chat messages found.";
};

export const executeReadLastMessages: FunctionToolRunner = async (
  args,
  context,
) => {
  const missingContext = getMissingContextResponse(
    "read last messages",
    context,
  );
  if (missingContext || !context) {
    return missingContext ?? "";
  }

  const anchorMessageId = context.replyMessageId ?? context.messageId;
  const messages = await readLastMessages(parseCount(args?.count), {
    chatId: context.chatId,
    messageId: anchorMessageId,
    threadId: context.threadId,
  });

  return messages.length > 0
    ? messages.map(formatMessageLine).join("\n")
    : "No remembered text messages found in that message range.";
};
