import { createHash } from "node:crypto";
import { normalizeWhitespace } from "../utils/text.ts";

type GuestMessage = {
  chat?: { id?: number; type?: string };
  from?: { id: number };
};

// A private guest chat is the same conversation from either participant's
// perspective. It is separate from both participants' direct bot chats.
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

// Telegram returns rendered text when a guest response is replied to, whereas
// delivery accepts Markdown. Compare visible content, not formatting or URLs.
export function getGuestContentFingerprint(text: string): string | undefined {
  const line = (value: string) => `${value}\n`;
  const plain = Bun.markdown.render(text.replaceAll(/<\/?[a-z][^>]*>/gi, " "), {
    paragraph: line,
    heading: line,
    code: line,
    listItem: line,
    tr: line,
    th: (value) => `${value} | `,
    td: (value) => `${value} | `,
    image: () => "",
  });
  const content = normalizeWhitespace(plain.replaceAll("|", " ")).normalize(
    "NFC",
  );
  return content
    ? createHash("sha256").update(content).digest("hex")
    : undefined;
}
