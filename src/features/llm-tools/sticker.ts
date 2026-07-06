import type { FunctionToolRunner } from "./types.ts";
import { getJsonError, getString } from "./utils.ts";

export const toolDefinition = {
  type: "function",
  name: "send_sticker",
  description:
    "Send one sticker along with response. Use this for expressive sticker reactions when a sticker is more natural than text. Call at most once per response.",
  parameters: {
    type: "object",
    properties: {
      emoji: {
        type: "string",
        description:
          "The emoji to match in the configured sticker packs, for example 😂, 😭, ❤️, or 👍.",
      },
    },
    required: ["emoji"],
    additionalProperties: false,
  },
  strict: true,
} as const;

export const execute: FunctionToolRunner = (args) => {
  const emoji = getString(args?.emoji);

  if (!emoji) {
    return getJsonError("Missing sticker emoji.");
  }

  return {
    output: JSON.stringify({
      sticker: {
        requested: true,
        emoji,
        placeholder: `[sticker ${emoji}]`,
        note: "The app will handle sticker delivery. Do not mention sticker availability or call send_sticker again for this response.",
      },
    }),
    sticker: { emoji },
  };
};
