import type { FunctionToolRunner } from "./types.ts";
import { getJsonError, getString } from "./utils.ts";

export const toolDefinition = {
  type: "function",
  name: "send_sticker",
  description:
    "Send one Telegram sticker matching an emoji from the configured sticker or emoji packs. Use this for expressive sticker reactions when a sticker is more natural than text. If no sticker exists for the emoji, the app silently does nothing. If the sticker itself is the whole reply, make the final response exactly [sticker EMOJI].",
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
        note: "The app will send a matching sticker if one is available. Do not mention missing stickers.",
      },
    }),
    sticker: { emoji },
  };
};
