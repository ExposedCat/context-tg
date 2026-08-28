import { normalizeWhitespace } from "../../utils/text.ts";
import {
  MAX_LAST_MESSAGES_COUNT,
  readLastMessages,
  readMessageWindow,
} from "../last-messages.ts";
import {
  type MessageSearchWindow,
  searchMessageWindows,
} from "../message-search.ts";
import type { MessageMetadata, MessageSearchResult } from "../messages.ts";
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
    "Search remembered messages in the current Telegram chat or forum topic using semantic and lexical matching. Returns a JSON array of relevant conversation windows, with each matched anchor surrounded by nearby messages and its reply parent when available. Telegram photos and image documents are represented as reusable tg://photo or tg://document Markdown, followed by their caption when present; inspect one by passing its exact ID to read_image. Messages from the same album share media_group_id. Telegram stickers are represented as [sticker EMOJI]. The sender_id and date filters are optional; only use them when the user explicitly needs a sender or date range filter. Prefer using only queries.",
  parameters: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        description:
          "One or more concise natural-language queries for hybrid semantic and lexical search. Include a sender name in the query when searching by name.",
        items: {
          type: "string",
        },
      },
      exact_phrases: {
        type: "array",
        description:
          "Optional exact phrases for quoted wording, URLs, usernames, codes, hashes, or other identifiers. Do not use for ordinary conceptual searches.",
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

export const getMessageContextToolDefinition = {
  type: "function",
  name: "get_message_context",
  description:
    "Read the exact chronological neighborhood around one remembered message in the current Telegram chat or forum topic. Use this after search_chat when a result is unclear or needs more surrounding discussion. Use a message_id returned by chat context or search results; do not guess IDs or use this for broad search.",
  parameters: {
    type: "object",
    properties: {
      message_id: {
        type: "number",
        description: "The Telegram message ID to read around.",
        minimum: 1,
      },
      radius: {
        type: "number",
        description:
          "How many remembered messages to return before and after the target message.",
        minimum: 1,
        maximum: 10,
      },
    },
    required: ["message_id", "radius"],
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

function parseMessageId(value: unknown): number | undefined {
  const messageId = getFiniteNumber(value);
  if (messageId === undefined || messageId < 1) {
    return undefined;
  }

  return Math.floor(messageId);
}

function parseRadius(value: unknown): number {
  const radius = getFiniteNumber(value);
  return Math.max(1, Math.min(10, Math.floor(radius ?? 1)));
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

  if (message.media_group_id !== undefined) {
    data.media_group_id = message.media_group_id;
  }

  if (message.reply_to_message_id !== undefined) {
    data.reply_to_id = message.reply_to_message_id;
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

export function formatSearchWindowsJson(
  windows: readonly MessageSearchWindow[],
): string {
  return JSON.stringify(
    windows.map((window) => ({
      anchor_ids: window.anchor_ids,
      score: window.score,
      queries: window.queries,
      matched_by: window.matched_by,
      messages: window.messages.map((message) => ({
        ...formatMessageData(message),
        is_anchor: message.is_anchor,
        ...(message.is_reply_context ? { is_reply_context: true } : {}),
      })),
    })),
    null,
    2,
  );
}

export function formatMessageContextJson(
  targetMessageId: number,
  radius: number,
  messages: readonly MessageMetadata[],
): string {
  return JSON.stringify(
    {
      message_id: targetMessageId,
      radius,
      target_found: messages.some(
        (message) => message.message_id === targetMessageId,
      ),
      messages: messages.map((message) => ({
        ...formatMessageData(message),
        is_target: message.message_id === targetMessageId,
      })),
    },
    null,
    2,
  );
}

export const executeSearchChat: FunctionToolRunner = async (args, context) => {
  const missingContext = getMissingContextResponse("search chat", context);
  if (missingContext || !context) {
    return missingContext ?? "";
  }

  const queries = Array.isArray(args?.queries)
    ? args.queries.filter((query): query is string => typeof query === "string")
    : [];
  const exactPhrases = Array.isArray(args?.exact_phrases)
    ? args.exact_phrases.filter(
        (phrase): phrase is string => typeof phrase === "string",
      )
    : [];
  const results = await searchMessageWindows({
    queries,
    exactPhrases,
    from: getOptionalDate(args?.from),
    to: getOptionalDate(args?.to),
    chatId: context.chatId,
    threadId: context.threadId,
    senderId: getFiniteNumber(args?.sender_id),
    limit: 6,
  });

  return formatSearchWindowsJson(results);
};

export const executeGetMessageContext: FunctionToolRunner = async (
  args,
  context,
) => {
  const missingContext = getMissingContextResponse(
    "get message context",
    context,
  );
  if (missingContext || !context) {
    return missingContext ?? "";
  }

  const messageId = parseMessageId(args?.message_id);
  if (messageId === undefined) {
    return JSON.stringify({
      error: "message_id must be a positive finite number",
    });
  }

  const radius = parseRadius(args?.radius);
  const messages = await readMessageWindow({
    chatId: context.chatId,
    anchorMessageId: messageId,
    before: radius,
    after: radius,
    threadId: context.threadId,
  });

  return formatMessageContextJson(messageId, radius, messages);
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
