import { normalizeWhitespace } from "../../utils/text.ts";
import { MAX_LAST_MESSAGES_COUNT, readLastMessages } from "../last-messages.ts";
import {
  type MessageMetadata,
  type MessageSearchResult,
  search as searchMessages,
} from "../messages.ts";
import type { FunctionToolRunner } from "./types.ts";
import {
  getFiniteNumber,
  getMissingContextResponse,
  getOptionalDate,
} from "./utils.ts";

export const searchChatToolDefinition = {
  type: "function",
  name: "search_chat",
  description:
    "Search remembered messages in the current Telegram chat or forum topic. Returns a JSON array of message objects. Telegram photos are represented as [photo attachment], followed by their caption when present. Telegram stickers are represented as [sticker EMOJI]. The sender_id and date filters are optional; only use them when the user explicitly needs a sender or date range filter. Prefer using only queries.",
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
    "Read recent remembered text messages from the current Telegram chat. Returns a JSON array of message objects. Only quote messages when you are asked to do so. If you are tasked to do a summary or help with ongoing discussion, you must read messages as an extra context, do not just list or recite entire discussion unless explicitly requested to do so.",
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

function parseCount(value: unknown): number {
  const count = getFiniteNumber(value);

  if (count === undefined) {
    return 1;
  }

  return Math.max(1, Math.min(MAX_LAST_MESSAGES_COUNT, Math.floor(count)));
}

function formatMessageData(
  message: MessageMetadata | MessageSearchResult,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: message.message_id,
    date: message.date,
    sender_id: message.sender_id,
    sender: message.sender_name,
    text: normalizeWhitespace(message.text),
  };

  if (message.thread_id !== undefined) {
    data.thread_id = message.thread_id;
  }

  if ("score" in message) {
    data.score = message.score;
  }

  if ("queries" in message) {
    data.queries = message.queries;
  }

  return data;
}

export function formatMessagesJson(
  messages: readonly MessageMetadata[] | readonly MessageSearchResult[],
): string {
  return JSON.stringify(messages.map(formatMessageData), null, 2);
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
    from: getOptionalDate(args?.from),
    to: getOptionalDate(args?.to),
    chatId: context.chatId,
    threadId: context.threadId,
    senderId: getFiniteNumber(args?.sender_id),
    limit: 20,
  });

  return formatMessagesJson(results);
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

  const anchorMessageId = context.replyMessageId;
  const messages = await readLastMessages(parseCount(args?.count), {
    chatId: context.chatId,
    ...(anchorMessageId !== undefined ? { messageId: anchorMessageId } : {}),
    threadId: context.threadId,
  });

  return formatMessagesJson(messages);
};
