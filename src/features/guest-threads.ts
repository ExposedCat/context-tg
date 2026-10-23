import { randomUUID } from "node:crypto";

export const GUEST_THREAD_CALLBACK_PREFIX = "guest-thread:";
const REFERENCE_PATTERN =
  /^guest-thread:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

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

export function createGuestThreadReference() {
  const referenceId = randomUUID();
  return {
    referenceId,
    callbackData: `${GUEST_THREAD_CALLBACK_PREFIX}${referenceId}`,
  };
}

export function getGuestThreadReference(
  markup:
    | {
        inline_keyboard: ReadonlyArray<
          ReadonlyArray<{ text?: string; callback_data?: string }>
        >;
      }
    | undefined,
): string | undefined {
  const references = new Set(
    markup?.inline_keyboard.flatMap((row) =>
      row.flatMap((button) => {
        const match = button.callback_data?.match(REFERENCE_PATTERN);
        return match ? [match[1]] : [];
      }),
    ),
  );
  return references.size === 1 ? references.values().next().value : undefined;
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
