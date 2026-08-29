import type { TelegramMessage } from "../shared/types.ts";

const prefixPattern = /^\s*(?:loylex|лойлекс)(?=$|[\s:;,—–-])[\s:;,—–-]*/iu;

export type TriggerDecision = {
  prompt: string;
  kind: "prefix" | "reply";
};

export function detectTrigger(message: TelegramMessage, botUserId: number): TriggerDecision | null {
  const text = message.text ?? message.caption ?? "";
  const prefix = text.match(prefixPattern);
  if (prefix) {
    const prompt = text.slice(prefix[0].length).trim();
    return { kind: "prefix", prompt: prompt || "Ответь на это сообщение." };
  }

  if (message.reply_to_message?.from?.id === botUserId) {
    return { kind: "reply", prompt: text.trim() || "Продолжай по вложению." };
  }

  return null;
}
