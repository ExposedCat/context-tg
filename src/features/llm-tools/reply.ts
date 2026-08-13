import type { FunctionToolRunner } from "./types.ts";
import { getJsonError } from "./utils.ts";

export const toolDefinition = {
  type: "function",
  name: "set_reply_message_id",
  description:
    "Set the Telegram message that the final response replies to. This is optional: by default the response replies to the latest user message. Call this only before the final response when you need to change its reply target. Only use a message ID explicitly provided in the conversation context or a tool result; never guess or invent one. Pass null to explicitly send without replying to any message.",
  parameters: {
    type: "object",
    properties: {
      message_id: {
        type: ["integer", "null"],
        description:
          "The explicitly known Telegram message id to reply to, or null to send without replying. Never guess or invent an id. Default: last user message.",
        minimum: 1,
      },
    },
    required: ["message_id"],
    additionalProperties: false,
  },
  strict: true,
} as const;

export const execute: FunctionToolRunner = (args) => {
  const messageId = args?.message_id;

  if (messageId === null) {
    return {
      output: JSON.stringify({ reply_message_id: null }),
      replyMessageId: null,
    };
  }

  if (
    typeof messageId !== "number" ||
    !Number.isSafeInteger(messageId) ||
    messageId < 1
  ) {
    return getJsonError("Invalid reply message id.");
  }

  return {
    output: JSON.stringify({ reply_message_id: messageId }),
    replyMessageId: messageId,
  };
};
