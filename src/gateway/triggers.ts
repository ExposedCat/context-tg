import type { TelegramMessage } from "../shared/types.ts";

const prefixPattern = /^\s*(?:loylex|лойлекс|лойликс)(?=$|[\s:;,—–-])[\s:;,—–-]*/iu;
const stopPattern = /^\/stop(?:@[a-z0-9_]+)?$/iu;
const tasksPattern = /^\/tasks(?:@[a-z0-9_]+)?$/iu;
const cancelPattern = /^\/cancel_(\d+)(?:@([a-z0-9_]+))?$/iu;
const resumePattern = /^\/resume_(\d+)(?:@([a-z0-9_]+))?$/iu;
const helpPattern = /^\/(?:start|help)(?:@([a-z0-9_]+))?$/iu;
const newChatCommandPattern = /^\/newchat(?:@[a-z0-9_]+)?(?:\s+[\s\S]*)?$/iu;
const newChatPattern = /^\/newchat(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/iu;

export type TriggerDecision = {
  prompt: string;
  kind: "prefix" | "private" | "reply";
};

function messageText(message: TelegramMessage): string {
  return message.text ?? message.caption ?? "";
}

function mentionsAnotherBot(mention: string | undefined, botUsername: string | undefined): boolean {
  return Boolean(
    mention && botUsername && mention.toLocaleLowerCase() !== botUsername.toLocaleLowerCase(),
  );
}

export function isNewChatCommand(message: TelegramMessage): boolean {
  return newChatCommandPattern.test(messageText(message).trim());
}

export function newChatPrompt(message: TelegramMessage, botUsername?: string): string | null {
  const match = messageText(message).trim().match(newChatPattern);
  if (!match || mentionsAnotherBot(match[1], botUsername)) {
    return null;
  }
  return match[2]?.trim() || "Ответь на это сообщение.";
}

export function isStopCommand(
  message: TelegramMessage,
  botUserId: number,
  botUsername?: string,
): boolean {
  if (message.reply_to_message?.from?.id !== botUserId) {
    return false;
  }
  const text = messageText(message).trim();
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
  const text = messageText(message).trim();
  if (!tasksPattern.test(text)) {
    return false;
  }
  const mention = text.slice("/tasks".length).trim();
  if (!mention || !botUsername) {
    return true;
  }
  return mention.slice(1).toLocaleLowerCase() === botUsername.toLocaleLowerCase();
}

export function isHelpCommand(message: TelegramMessage, botUsername?: string): boolean {
  const text = messageText(message).trim();
  const match = text.match(helpPattern);
  if (!match) {
    return false;
  }
  const mention = match[1];
  return (
    !mention || !botUsername || mention.toLocaleLowerCase() === botUsername.toLocaleLowerCase()
  );
}

export function cancelTaskMessageId(message: TelegramMessage, botUsername?: string): number | null {
  const text = messageText(message).trim();
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

export function resumeTaskMessageId(message: TelegramMessage, botUsername?: string): number | null {
  const text = messageText(message).trim();
  const match = text.match(resumePattern);
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
  const text = messageText(message);
  const prefix = text.match(prefixPattern);
  if (prefix) {
    const prompt = text.slice(prefix[0].length).trim();
    return { kind: "prefix", prompt: prompt || "Ответь на это сообщение." };
  }

  if (message.reply_to_message?.from?.id === botUserId) {
    return { kind: "reply", prompt: text.trim() || "Продолжай по вложению." };
  }

  if (message.chat.type === "private") {
    return { kind: "private", prompt: text.trim() || "Ответь на это сообщение." };
  }

  return null;
}
