import type { TelegramMessage } from "../shared/types.ts";

const prefixPattern = /^\s*(?:loylex|лойлекс|лойликс)(?=$|[\s:;,—–-])[\s:;,—–-]*/iu;
const stopPattern = /^\/stop(?:@[a-z0-9_]+)?$/iu;
const tasksPattern = /^\/tasks(?:@[a-z0-9_]+)?$/iu;
const cancelPattern = /^\/cancel_(\d+)(?:@([a-z0-9_]+))?$/iu;

export type TriggerDecision = {
  prompt: string;
  kind: "prefix" | "reply";
};

export function isStopCommand(
  message: TelegramMessage,
  botUserId: number,
  botUsername?: string,
): boolean {
  if (message.reply_to_message?.from?.id !== botUserId) {
    return false;
  }
  const text = (message.text ?? message.caption ?? "").trim();
  const match = text.match(stopPattern);
  if (!match) {
    return false;
  }
  const mention = text.slice("/stop".length).trim();
  if (!mention || !botUsername) {
    return true;
  }
  return mention.slice(1).toLocaleLowerCase() === botUsername.toLocaleLowerCase();
}

export function isTasksCommand(message: TelegramMessage, botUsername?: string): boolean {
  const text = (message.text ?? message.caption ?? "").trim();
  if (!tasksPattern.test(text)) {
    return false;
  }
  const mention = text.slice("/tasks".length).trim();
  if (!mention || !botUsername) {
    return true;
  }
  return mention.slice(1).toLocaleLowerCase() === botUsername.toLocaleLowerCase();
}

export function cancelTaskMessageId(message: TelegramMessage, botUsername?: string): number | null {
  const text = (message.text ?? message.caption ?? "").trim();
  const match = text.match(cancelPattern);
  if (!match) {
    return null;
  }
  const mention = match[2];
  if (mention && botUsername && mention.toLocaleLowerCase() !== botUsername.toLocaleLowerCase()) {
    return null;
  }
  const messageId = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
}

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
