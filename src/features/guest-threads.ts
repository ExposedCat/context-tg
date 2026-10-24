type GuestMessage = {
  chat?: { id?: number; type?: string };
  from?: { id: number };
};

// Private guest chats have two account-specific views of one conversation.
export function getGuestConversationKey(
  message: GuestMessage,
  topicId?: number,
): string | undefined {
  const chat = message.chat;
  if (chat?.id === undefined) return undefined;
  if (chat.type === "private") {
    if (!message.from) return undefined;
    return `dm:${[chat.id, message.from.id].sort((a, b) => a - b).join(":")}:${topicId ?? 0}`;
  }
  return `chat:${chat.id}:${topicId ?? 0}`;
}

// Supergroups have shared message IDs. DMs and basic groups use the caller's
// account-specific sequence, so numeric links must also identify that account.
export function getGuestMessageScope(
  conversationKey: string,
  chatId: number,
  callerId: number,
): string {
  return chatId <= -1_000_000_000_000
    ? `${conversationKey}:messages`
    : `${conversationKey}:viewer:${callerId}`;
}

// This is a fallback for an unknown ID in another participant's view. Hash
// rendered text without case folding or removing punctuation; never rank
// candidates by their dates or insertion order.
export function getGuestContentFingerprint(
  text: string,
  format: "markdown" | "plain" = "plain",
): string | undefined {
  let content = text;
  if (format === "markdown") {
    // Text alone cannot identify an image-only or mixed-media response.
    if (/!\[[^\]]*\]\(|<img\b/i.test(text)) return undefined;
    const line = (value: string) => `${value}\n`;
    const cell = (value: string) => `${value} | `;
    content = Bun.markdown.render(text, {
      paragraph: line,
      heading: line,
      code: line,
      listItem: line,
      th: cell,
      td: cell,
      tr: (value) => line(value.replace(/ \| $/, "")),
      html: (value) =>
        Bun.markdown.render(
          value
            .replaceAll(/<\/t[dh]>/gi, " | ")
            .replaceAll(/<\/(?:tr|p)>|<br\s*\/?>/gi, "\n")
            .replaceAll(/<[^>]*>/g, "")
            .replaceAll(/ \| (?=\n|$)/g, ""),
          {},
          { noHtmlBlocks: true, noHtmlSpans: true },
        ),
    });
  }
  content = normalizeWhitespace(content).normalize("NFC");
  // Versioned so old, more lossy fingerprints cannot enter this lookup.
  return content
    ? `text-v2:${createHash("sha256").update(content).digest("hex")}`
    : undefined;
}

// TDLib base64url-encodes the bare inputBotInlineMessageID (20 bytes) or
// inputBotInlineMessageID64 (24 bytes). Reject unknown encodings, never infer
// the sent ID by incrementing the triggering message's ID.
// https://github.com/tdlib/td/blob/master/td/telegram/InlineMessageManager.cpp
// https://core.telegram.org/constructor/inputBotInlineMessageID64
export function decodeGuestInlineMessageId(
  inlineMessageId: string,
): { ownerId: number; messageId: number } | undefined {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(inlineMessageId)) return undefined;
  const bytes = Buffer.from(inlineMessageId, "base64url");
  if (
    (bytes.length !== 20 && bytes.length !== 24) ||
    bytes.toString("base64url") !== inlineMessageId.replace(/=+$/, "")
  )
    return undefined;
  const dcId = bytes.readInt32LE(0);
  const ownerId =
    bytes.length === 20
      ? bytes.readInt32LE(8)
      : Number(bytes.readBigInt64LE(4));
  const messageId = bytes.readInt32LE(bytes.length === 20 ? 4 : 12);
  if (
    dcId <= 0 ||
    dcId > 1000 ||
    !Number.isSafeInteger(ownerId) ||
    ownerId === 0 ||
    messageId <= 0
  )
    return undefined;
  return { ownerId, messageId };
}

export function getGuestInlineMessageId({
  inline_message_id,
  conversation_key,
  chat_id,
  caller_id,
}: {
  inline_message_id: string | null;
  conversation_key: string | null;
  chat_id: number;
  caller_id: number | null;
}): number | undefined {
  if (!inline_message_id || !conversation_key || caller_id === null)
    return undefined;
  const decoded = decodeGuestInlineMessageId(inline_message_id);
  if (!decoded) return undefined;
  const expectedOwner =
    chat_id <= -1_000_000_000_000 ? chat_id + 1_000_000_000_000 : caller_id;
  return decoded.ownerId === expectedOwner ? decoded.messageId : undefined;
}

import { createHash } from "node:crypto";
import { normalizeWhitespace } from "../utils/text.ts";
