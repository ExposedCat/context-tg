import { createDebug } from "@grammyjs/debug";
import { Composer, InputFile } from "grammy";
import type { Context } from "../bot.ts";
import {
  escapeHtml,
  escapeHtmlAttribute,
  normalizeHtmlFilename,
  normalizeWhitespace,
  truncateCodePoints,
} from "../utils/text.ts";
import {
  type AgentDefinition,
  getAgentById,
  guestAgent,
  normalAgent,
  resolveMessageAgent,
  stripMessageAgentName,
} from "./agents/index.ts";
import { findRandomStickerForEmoji } from "./emoji-packs.ts";
import { APP_ENV } from "./env.ts";
import { readLastMessages } from "./last-messages.ts";
import {
  type LlmCitation,
  type LlmDebugInfo,
  type LlmGeneratedImage,
  type LlmImageInput,
  type LlmReport,
  LlmRequestError,
  type LlmRequestInput,
  type LlmRequestMessageInput,
  type LlmRequestOptions,
  type LlmResponse,
  type LlmSticker,
  type LlmToolContext,
  requestLlm,
  type ToolName,
} from "./llm.ts";
import { getChatDebugMode } from "./llm-models.ts";
import { formatMessageLine } from "./llm-tools/chat.ts";
import { startsWithCommandPrefix } from "./message-filter.ts";
import type { MessageMetadata } from "./messages.ts";
import {
  incrementProactiveResponseMessageCount,
  shouldTriggerProactiveResponse,
} from "./proactive.ts";
import {
  completeTask,
  createTask,
  createTaskAbortController,
  deleteTaskAbortController,
  getTask,
  hasResumableTask,
  type TaskStatus,
} from "./tasks.ts";
import { disabledLinkPreviewOptions as linkPreviewOptions } from "./telegram.ts";
import { createThread, getThread, saveThread, type Thread } from "./threads.ts";
import {
  consumeUsage,
  getUsageStatus,
  hasUsageRemaining,
  recordUsage,
  refundUsage,
  type UsageConsumeResult,
  type UsageKey,
} from "./usage.ts";

type LlmContextMessage = {
  text?: string;
  caption?: string;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  origin?: MessageOrigin;
  animation?: unknown;
  audio?: unknown;
  photo?: PhotoSize[];
  document?: TelegramDocument;
  paid_media?: unknown;
  video?: unknown;
  voice?: unknown;
  sticker?: TelegramSticker;
};

type TextMessage = LlmContextMessage & {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  quote?: {
    text: string;
  };
  reply_to_message?: TextMessage;
  external_reply?: LlmContextMessage;
};

type ProactiveTriggerMessage = {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  origin?: MessageOrigin;
  quote?: {
    text: string;
  };
  sticker?: TelegramSticker;
  reply_to_message?: {
    message_id: number;
    message_thread_id?: number;
    is_topic_message?: boolean;
    from?: TelegramUser;
    text?: string;
    caption?: string;
    sticker?: TelegramSticker;
  };
  external_reply?: LlmContextMessage;
};

type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramChat = {
  id?: number;
  first_name?: string;
  last_name?: string;
  title?: string;
  username?: string;
};

type MessageOrigin =
  | {
      type: "user";
      sender_user: TelegramUser;
    }
  | {
      type: "hidden_user";
      sender_user_name: string;
    }
  | {
      type: "chat";
      sender_chat: TelegramChat;
      author_signature?: string;
    }
  | {
      type: "channel";
      chat: TelegramChat;
      author_signature?: string;
    };

type PhotoSize = {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
};

type TelegramDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
};

type TelegramSticker = {
  emoji?: string;
};

type TelegramImageAttachment = {
  fileId: string;
  mimeType?: string;
};

type BotReaction = "🤔";

const logError = createDebug("app:chat:error");

export const chatComposer = new Composer<Context>();

const TELEGRAM_RICH_MESSAGE_CHUNK_SIZE_BYTES = 30_000;
const GUEST_RESULT_DESCRIPTION_LENGTH = 120;
const SLOW_RESPONSE_REACTION_DELAY_MS = 15_000;
const PROACTIVE_CONTEXT_MESSAGE_COUNT = 10;
const PROACTIVE_TASK_TEXT = "Proactive response";
const PROACTIVE_DISABLED_TOOLS = new Set<ToolName>([
  "generate_image",
  "generate_image_nsfw",
  "send_sticker",
  "schedule_message",
  "cron_message",
  "remember",
  "forget",
]);
const UNSUPPORTED_CAPTIONED_MEDIA_TYPES = [
  { key: "animation", label: "animation" },
  { key: "audio", label: "audio" },
  { key: "document", label: "document" },
  { key: "paid_media", label: "paid" },
  { key: "video", label: "video" },
  { key: "voice", label: "voice" },
] as const satisfies ReadonlyArray<{
  key: keyof TextMessage;
  label: string;
}>;

function getMessageText(message: LlmContextMessage): string | undefined {
  return message.text ?? message.caption;
}

function formatStickerMarker(emoji: string | undefined): string {
  const trimmedEmoji = emoji?.trim();
  return trimmedEmoji ? `[sticker ${trimmedEmoji}]` : "[sticker]";
}

function getStickerMarker(
  message: LlmContextMessage | undefined,
): string | undefined {
  return message?.sticker
    ? formatStickerMarker(message.sticker.emoji)
    : undefined;
}

function getUnsupportedCaptionedMediaLabel(
  message: LlmContextMessage,
): string | undefined {
  if (hasImageAttachments(message)) {
    return undefined;
  }

  return UNSUPPORTED_CAPTIONED_MEDIA_TYPES.find(
    ({ key }) => message[key] !== undefined,
  )?.label;
}

function buildLlmMessageText(message: LlmContextMessage, text: string): string {
  const label = getUnsupportedCaptionedMediaLabel(message);

  return label ? `[Unsupported ${label} media]\n${text}` : text;
}

function getLlmContextText(
  message: LlmContextMessage | undefined,
): string | undefined {
  const text = message && getMessageText(message);
  return message && text && !startsWithCommandPrefix(text)
    ? buildLlmMessageText(message, text)
    : undefined;
}

function getTelegramChatName(
  chat: TelegramChat | undefined,
): string | undefined {
  if (!chat) {
    return undefined;
  }

  if (chat.title) {
    return chat.username ? `${chat.title} (@${chat.username})` : chat.title;
  }

  return getTelegramUserName(chat);
}

function getTelegramUserName(
  user: TelegramUser | TelegramChat | undefined,
): string | undefined {
  if (!user) {
    return undefined;
  }

  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  if (name && user.username) {
    return `${name} (@${user.username})`;
  }

  return name || (user.username ? `@${user.username}` : String(user.id ?? ""));
}

function getMessageOriginSenderName(
  origin: MessageOrigin | undefined,
): string | undefined {
  switch (origin?.type) {
    case "user":
      return getTelegramUserName(origin.sender_user);
    case "hidden_user":
      return origin.sender_user_name;
    case "chat":
      return origin.author_signature ?? getTelegramChatName(origin.sender_chat);
    case "channel":
      return origin.author_signature ?? getTelegramChatName(origin.chat);
    default:
      return undefined;
  }
}

function getMessageSenderName(
  message: LlmContextMessage | undefined,
  fallback: string,
): string {
  const senderName =
    getTelegramChatName(message?.sender_chat) ??
    getTelegramUserName(message?.from) ??
    getMessageOriginSenderName(message?.origin);

  return senderName?.trim() ? senderName : fallback;
}

function getLlmMessageContent(
  message: LlmContextMessage | undefined,
  text?: string,
): string | undefined {
  const messageText =
    message && text !== undefined
      ? buildLlmMessageText(message, text)
      : getLlmContextText(message);
  const parts = [
    getStickerMarker(message),
    hasImageAttachments(message) ? "[Attached image]" : undefined,
    messageText,
  ].filter((part): part is string => part !== undefined && part.trim() !== "");

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function getLargestPhoto(
  photos: PhotoSize[] | undefined,
): PhotoSize | undefined {
  return photos?.toSorted((left, right) => {
    const leftPixels = left.width * left.height;
    const rightPixels = right.width * right.height;

    return rightPixels - leftPixels;
  })[0];
}

function getImageMimeTypeFromFilename(filename: string | undefined) {
  const extension = filename?.split(".").at(-1)?.toLocaleLowerCase();

  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    default:
      return undefined;
  }
}

function isImageDocument(document: TelegramDocument): boolean {
  return (
    document.mime_type?.startsWith("image/") === true ||
    getImageMimeTypeFromFilename(document.file_name) !== undefined
  );
}

function getMessageImageAttachments(
  message: LlmContextMessage | undefined,
): TelegramImageAttachment[] {
  if (!message) {
    return [];
  }

  const attachments: TelegramImageAttachment[] = [];
  const photo = getLargestPhoto(message.photo);

  if (photo) {
    attachments.push({ fileId: photo.file_id, mimeType: "image/jpeg" });
  }

  if (message.document && isImageDocument(message.document)) {
    attachments.push({
      fileId: message.document.file_id,
      mimeType:
        message.document.mime_type ??
        getImageMimeTypeFromFilename(message.document.file_name),
    });
  }

  return attachments;
}

function hasImageAttachments(message: LlmContextMessage | undefined): boolean {
  return getMessageImageAttachments(message).length > 0;
}

function isAddressed(text: string, ownUsername: string): boolean {
  return Boolean(resolveMessageAgent(text, ownUsername));
}

function isDirectReplyToBot(
  reply: TextMessage | undefined,
  botId: number,
): boolean {
  return reply?.from?.id === botId;
}

function isImplicitForumTopicReply(
  message: TextMessage,
  reply: TextMessage | undefined,
): boolean {
  return (
    message.is_topic_message === true &&
    message.message_thread_id !== undefined &&
    reply?.message_id === message.message_thread_id
  );
}

function getActualReply(message: TextMessage): TextMessage | undefined {
  const reply = message.reply_to_message;

  return isImplicitForumTopicReply(message, reply) ? undefined : reply;
}

function getForumThreadId(
  message: TextMessage,
  reply: TextMessage | undefined,
): number | undefined {
  if (message.is_topic_message === true) {
    return message.message_thread_id ?? reply?.message_thread_id;
  }

  if (reply?.is_topic_message === true) {
    return reply.message_thread_id;
  }

  return undefined;
}

function getQuoteReplyContextText(message: TextMessage): string | undefined {
  const quote = message.quote?.text.trim();

  return quote && !startsWithCommandPrefix(quote) ? quote : undefined;
}

function getReplyContext(
  message: TextMessage,
  reply: TextMessage | undefined,
): LlmContextMessage | undefined {
  if (reply) {
    return reply;
  }

  return message.external_reply;
}

function formatRegularLlmMessage(
  message: LlmContextMessage | undefined,
  text?: string,
): string | undefined {
  const content = getLlmMessageContent(message, text);

  if (!content) {
    return undefined;
  }

  return `${getMessageSenderName(message, "Unknown")}:\n${content}`;
}

function formatCurrentLlmMessage(
  message: TextMessage,
  text: string,
  replyContext: LlmContextMessage | undefined,
): string {
  const senderName = getMessageSenderName(message, "User");
  const replySenderName = getMessageSenderName(replyContext, "Unknown");
  const content = getLlmMessageContent(message, text) ?? text;
  const quoteText = getQuoteReplyContextText(message);

  if (quoteText) {
    return [
      `${senderName} quoting ${replySenderName}:`,
      `> ${JSON.stringify(quoteText)}`,
      content,
    ].join("\n");
  }

  if (replyContext) {
    return `${senderName} replying to ${replySenderName}:\n${content}`;
  }

  return `${senderName}:\n${content}`;
}

function buildRootRequestMessages(
  message: TextMessage,
  text: string,
  replyContext: LlmContextMessage | undefined,
): Array<{
  text: string;
  message: LlmContextMessage | undefined;
}> {
  const currentMessageText = formatCurrentLlmMessage(
    message,
    text,
    replyContext,
  );
  const quoteText = getQuoteReplyContextText(message);
  const replyMessageText =
    replyContext && !quoteText
      ? formatRegularLlmMessage(replyContext)
      : undefined;

  if (replyMessageText) {
    return [
      { text: replyMessageText, message: replyContext },
      { text: currentMessageText, message },
    ];
  }

  return [{ text: currentMessageText, message }];
}

function buildThreadRequest(
  message: TextMessage,
  text: string,
  replyContext: LlmContextMessage | undefined,
): string {
  return formatCurrentLlmMessage(message, text, replyContext);
}

function getLlmToolContext(
  chatId: number,
  message: TextMessage,
): LlmToolContext {
  const reply = getActualReply(message);

  return {
    chatId,
    messageId: message.message_id,
    userId: message.from?.id,
    userName: getTelegramUserName(message.from),
    replyMessageId: reply?.message_id,
    threadId: getForumThreadId(message, reply),
  };
}

function getTelegramFileUrl(filePath: string): string {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://api.telegram.org/file/bot${APP_ENV.BOT_TOKEN}/${encodedPath}`;
}

function getResponseMimeType(
  response: Response,
  fallbackMimeType: string | undefined,
  filePath: string,
): string {
  const responseMimeType = response.headers.get("content-type")?.split(";")[0];

  if (responseMimeType?.startsWith("image/")) {
    return responseMimeType;
  }

  return (
    fallbackMimeType ?? getImageMimeTypeFromFilename(filePath) ?? "image/jpeg"
  );
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

async function downloadImageDataUrl(
  ctx: Context,
  attachment: TelegramImageAttachment,
  signal?: AbortSignal,
): Promise<LlmImageInput> {
  const file = await ctx.api.getFile(attachment.fileId, signal);

  if (!file.file_path) {
    throw new Error("Telegram image file path is unavailable.");
  }

  const response = await fetch(getTelegramFileUrl(file.file_path), { signal });

  if (!response.ok) {
    throw new Error(`Telegram image download failed: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const mimeType = getResponseMimeType(
    response,
    attachment.mimeType,
    file.file_path,
  );

  return {
    image_url: `data:${mimeType};base64,${encodeBase64(bytes)}`,
    detail: "auto",
  };
}

async function buildLlmRequestInput(
  ctx: Context,
  text: string,
  message: LlmContextMessage | undefined,
  signal?: AbortSignal,
): Promise<LlmRequestMessageInput> {
  const attachments = getMessageImageAttachments(message);

  if (attachments.length === 0) {
    return text;
  }

  return {
    text,
    images: await Promise.all(
      attachments.map((attachment) =>
        downloadImageDataUrl(ctx, attachment, signal),
      ),
    ),
  };
}

async function buildLlmRequestInputs(
  ctx: Context,
  messages: Array<{
    text: string;
    message: LlmContextMessage | undefined;
  }>,
  signal?: AbortSignal,
): Promise<LlmRequestInput> {
  const inputs = await Promise.all(
    messages.map(({ text, message }) =>
      buildLlmRequestInput(ctx, text, message, signal),
    ),
  );

  return inputs.length === 1 ? inputs[0] : inputs;
}

async function submitTypingAction(ctx: Context): Promise<void> {
  try {
    await ctx.replyWithChatAction("typing");
  } catch (error) {
    logError("Failed to submit typing action:", error);
  }
}

async function submitReaction(
  ctx: Context,
  reaction: BotReaction,
): Promise<void> {
  try {
    await ctx.react(reaction);
  } catch (error) {
    logError("Failed to submit reaction:", { reaction, error });
  }
}

async function sendLlmWarning(
  ctx: Context,
  message: TextMessage,
  details: string,
): Promise<void> {
  try {
    await ctx.reply(`Warn: ${sanitizeLlmHtml(details)}`, {
      ...linkPreviewOptions,
      parse_mode: "HTML",
      reply_parameters: {
        message_id: message.message_id,
      },
    });
  } catch (error) {
    logError("Failed to send LLM warning:", error);
  }
}

function createSlowResponseReactionTracker(ctx: Context): {
  stop: () => void;
} {
  let reacted = false;
  let stopped = false;

  const timeoutId = setTimeout(() => {
    if (stopped || reacted) {
      return;
    }

    reacted = true;
    void submitReaction(ctx, "🤔");
  }, SLOW_RESPONSE_REACTION_DELAY_MS);

  return {
    stop() {
      stopped = true;
      clearTimeout(timeoutId);
    },
  };
}

async function withTypingAction<T>(
  ctx: Context,
  callback: () => Promise<T>,
): Promise<T> {
  await submitTypingAction(ctx);
  return await callback();
}

function getAttributeValue(
  tagBody: string,
  attributeName: string,
): string | null {
  const match = tagBody.match(
    new RegExp(
      `^${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))$`,
      "i",
    ),
  );

  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function normalizeAllowedTag(tag: string): string | null {
  const tagBody = tag.slice(1, -1).trim();

  if (/^br\s*\/?$/i.test(tagBody)) {
    return "\n";
  }

  if (tagBody.startsWith("/")) {
    const tagName = tagBody.slice(1).trim().toLocaleLowerCase();
    return ["b", "code", "a", "blockquote"].includes(tagName)
      ? `</${tagName}>`
      : null;
  }

  const match = tagBody.match(/^([a-z]+)(.*)$/i);
  const tagName = match?.[1]?.toLocaleLowerCase();
  const attributes = match?.[2]?.trim() ?? "";

  if (tagName === "b") {
    return attributes ? null : `<${tagName}>`;
  }

  if (tagName === "code") {
    if (!attributes) {
      return "<code>";
    }

    const lang = getAttributeValue(attributes, "lang");
    return lang === null ? null : `<code lang="${escapeHtmlAttribute(lang)}">`;
  }

  if (tagName === "a") {
    const href = getAttributeValue(attributes, "href");
    return href === null ? null : `<a href="${escapeHtmlAttribute(href)}">`;
  }

  if (tagName === "blockquote") {
    if (!attributes) {
      return "<blockquote>";
    }

    return attributes.toLocaleLowerCase() === "expandable"
      ? "<blockquote expandable>"
      : null;
  }

  return null;
}

function sanitizeLlmHtml(text: string): string {
  let sanitized = "";
  let cursor = 0;

  for (const match of text.matchAll(/<[^>]*>/g)) {
    const tag = match[0];
    const index = match.index ?? 0;
    sanitized += escapeHtml(text.slice(cursor, index));
    sanitized += normalizeAllowedTag(tag) ?? escapeHtml(tag);
    cursor = index + tag.length;
  }

  return sanitized + escapeHtml(text.slice(cursor));
}

function getUtf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function splitRichMarkdownMessage(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;

  for (const character of text) {
    const characterBytes = getUtf8ByteLength(character);

    if (
      chunk &&
      chunkBytes + characterBytes > TELEGRAM_RICH_MESSAGE_CHUNK_SIZE_BYTES
    ) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }

    chunk += character;
    chunkBytes += characterBytes;
  }

  if (chunk) {
    chunks.push(chunk);
  }

  return chunks.length > 0 ? chunks : [text];
}

type MarkdownLinkRange = {
  start: number;
  end: number;
};

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }

  return slashCount % 2 === 1;
}

function findUnescapedMarkdownCharacter(
  text: string,
  character: string,
  startIndex: number,
): number {
  for (let index = startIndex; index < text.length; index++) {
    if (text[index] === character && !isEscapedMarkdownCharacter(text, index)) {
      return index;
    }
  }

  return -1;
}

function getMarkdownLinkRanges(text: string): MarkdownLinkRange[] {
  const ranges: MarkdownLinkRange[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const labelStart = findUnescapedMarkdownCharacter(text, "[", cursor);

    if (labelStart === -1) {
      break;
    }

    const labelEnd = findUnescapedMarkdownCharacter(text, "]", labelStart + 1);

    if (labelEnd === -1) {
      break;
    }

    if (text[labelEnd + 1] !== "(") {
      cursor = labelEnd + 1;
      continue;
    }

    const destinationEnd = findUnescapedMarkdownCharacter(
      text,
      ")",
      labelEnd + 2,
    );

    if (destinationEnd === -1) {
      break;
    }

    ranges.push({ start: labelStart, end: destinationEnd + 1 });
    cursor = destinationEnd + 1;
  }

  return ranges;
}

function getCitationReplacementRange(
  response: string,
  citation: LlmCitation,
  markdownLinks: MarkdownLinkRange[],
): Pick<LlmCitation, "start_index" | "end_index"> {
  const overlappingLinks = markdownLinks.filter(
    (range) =>
      citation.start_index < range.end && citation.end_index > range.start,
  );
  const link =
    overlappingLinks.find((range) =>
      response.slice(range.start, range.end).includes(citation.link),
    ) ?? overlappingLinks[0];

  const range = link
    ? { start_index: link.start, end_index: link.end }
    : citation;

  const nextSourceText = ` (${citation.link})`;

  if (response.startsWith(nextSourceText, range.end_index)) {
    return {
      start_index: range.start_index,
      end_index: range.end_index + nextSourceText.length,
    };
  }

  return range;
}

function getValidCitations(
  response: string,
  citations: LlmCitation[],
): LlmCitation[] {
  const markdownLinks = getMarkdownLinkRanges(response);

  return citations
    .map((citation) => ({
      ...citation,
      ...getCitationReplacementRange(response, citation, markdownLinks),
    }))
    .filter(
      (citation) =>
        citation.start_index >= 0 &&
        citation.end_index > citation.start_index &&
        citation.end_index <= response.length,
    )
    .sort((left, right) => left.start_index - right.start_index)
    .filter((citation, index, sortedCitations) => {
      const previous = sortedCitations[index - 1];
      return !previous || citation.start_index >= previous.end_index;
    });
}

function escapeMarkdownLinkDestination(url: string): string {
  return url.replaceAll("\\", "\\\\").replaceAll(")", "\\)");
}

function formatMarkdownCitations(
  response: string,
  citations: LlmCitation[],
): string {
  let cursor = 0;
  let formatted = "";

  for (const citation of getValidCitations(response, citations)) {
    formatted += response.slice(cursor, citation.start_index);
    formatted += `[ℹ️](${escapeMarkdownLinkDestination(citation.link)})`;
    cursor = citation.end_index;
  }

  return formatted + response.slice(cursor);
}

const TOOL_USAGE_EMOJIS: Partial<
  Record<ToolName, { id: string; fallback: string }>
> = {
  web_search: { id: "5879585266426973039", fallback: "🌐" },
  read_web_page: { id: "5960551395730919906", fallback: "📝" },
  search_chat: { id: "5874960879434338403", fallback: "🔎" },
  read_last_messages: { id: "5891169510483823323", fallback: "💬" },
  send_report: { id: "5877597667231534929", fallback: "📄" },
  send_trading_report: { id: "5877597667231534929", fallback: "📄" },
  get_markets_state: { id: "5900104897885376843", fallback: "📈" },
  get_recent_news: { id: "6008090211181923982", fallback: "📰" },
  read_youtube_video: { id: "6005986106703613755", fallback: "▶️" },
  generate_image: { id: "5814690801665446789", fallback: "🖼️" },
  generate_image_nsfw: { id: "5816705961666025146", fallback: "🖼️" },
  schedule_message: { id: "5967412305338568701", fallback: "⏰" },
  cron_message: { id: "5967412305338568701", fallback: "⏰" },
  remember: { id: "5778168620278354602", fallback: "💾" },
  forget: { id: "5877738786971979125", fallback: "🗑️" },
};
const ERROR_USAGE_EMOJI = {
  id: "5881702736843511327",
  fallback: "⚠️",
} as const;

function formatToolUsageMarkdown(
  tools: ToolName[],
  includeErrorIcon: boolean,
): string {
  const usedEmojiIds = new Set<string>();
  const emojis: string[] = [];

  if (includeErrorIcon) {
    usedEmojiIds.add(ERROR_USAGE_EMOJI.id);
    emojis.push(
      `![${ERROR_USAGE_EMOJI.fallback}](tg://emoji?id=${ERROR_USAGE_EMOJI.id})`,
    );
  }

  for (const tool of tools) {
    const emoji = TOOL_USAGE_EMOJIS[tool];

    if (!emoji || usedEmojiIds.has(emoji.id)) {
      continue;
    }

    usedEmojiIds.add(emoji.id);
    emojis.push(`![${emoji.fallback}](tg://emoji?id=${emoji.id})`);
  }

  return emojis.join(" ");
}

function formatMarkdownBlockquote(text: string): string {
  const trimmedText = text.trim();

  if (!trimmedText) {
    return "";
  }

  return trimmedText
    .split(/\r?\n/)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function getUniqueNonEmptyLines(values: string[]): string[] {
  const lines = values.map((value) => value.trim()).filter(Boolean);
  return [...new Set(lines)];
}

function appendResponseFooterMarkdown(
  text: string,
  tools: ToolName[],
  errors: string[],
): string {
  const uniqueErrors = getUniqueNonEmptyLines(errors);
  const suffix = formatToolUsageMarkdown(tools, uniqueErrors.length > 0);
  const sections: string[] = [];
  const trimmedText = text.trimEnd();

  if (trimmedText) {
    sections.push(trimmedText);
  }

  for (const error of uniqueErrors) {
    const blockquote = formatMarkdownBlockquote(error);

    if (blockquote) {
      sections.push(blockquote);
    }
  }

  if (suffix) {
    sections.push(suffix);
  }

  return sections.join("\n\n");
}

function formatDebugValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDebugMarkdown(debug: LlmDebugInfo): string {
  const sections: string[] = ["Debug"];
  const reasoning = getUniqueNonEmptyLines(debug.reasoning);

  if (reasoning.length > 0) {
    sections.push(["Reasoning", ...reasoning].join("\n\n"));
  }

  if (debug.tool_calls.length > 0) {
    const lines = ["Tool calls"];

    for (const [index, toolCall] of debug.tool_calls.entries()) {
      lines.push(
        `${index + 1}. ${toolCall.name}`,
        formatDebugValue(toolCall.input),
      );
    }

    sections.push(lines.join("\n"));
  }

  if (sections.length === 1) {
    return "";
  }

  return `<blockquote expandable>${escapeHtml(
    sections.join("\n\n"),
  )}</blockquote>`;
}

function removeStickerPlaceholders(
  response: string,
  stickers: LlmSticker[],
): string {
  const placeholders = new Set([
    "[sticker]",
    ...stickers.map((sticker) => formatStickerMarker(sticker.emoji)),
  ]);
  let text = response;
  let removed = false;

  for (const placeholder of placeholders) {
    if (!text.includes(placeholder)) {
      continue;
    }

    removed = true;
    text = text.split(placeholder).join("");
  }

  if (!removed) {
    return response;
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.replaceAll(/[ \t]+([,.;:!?])/g, "$1").trimEnd())
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

function formatLlmResponse(
  llmResponse: LlmResponse,
  options: { debug?: boolean; errors?: string[] } = {},
): {
  richMarkdown: string;
} {
  const response = llmResponse.response ?? "";
  const richMarkdown = removeStickerPlaceholders(
    formatMarkdownCitations(response, llmResponse.web_search.citations),
    llmResponse.stickers,
  );
  const errors = [...llmResponse.errors, ...(options.errors ?? [])];
  const responseWithFooter = appendResponseFooterMarkdown(
    richMarkdown,
    llmResponse.tools,
    errors,
  );
  const debugMarkdown = options.debug
    ? formatDebugMarkdown(llmResponse.debug)
    : "";

  return {
    richMarkdown: [debugMarkdown, responseWithFooter]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function getHttpUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function getImageFileExtension(mimeType: string | undefined): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function parseDataUrlImage(dataUrl: string): {
  bytes: Uint8Array;
  mimeType: string;
} {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl);

  if (!match) {
    throw new Error("Generated image data URL is invalid.");
  }

  return {
    mimeType: match[1],
    bytes: decodeBase64(match[2]),
  };
}

async function createGeneratedImageInputFile(
  image: LlmGeneratedImage,
): Promise<{ input: string | InputFile; cleanup: () => Promise<void> }> {
  const url = getHttpUrl(image.url);

  if (url) {
    return {
      input: url,
      cleanup: async () => {},
    };
  }

  if (!image.dataUrl) {
    throw new Error("Generated image is missing image data.");
  }

  const parsed = parseDataUrlImage(image.dataUrl);
  const extension = getImageFileExtension(image.mimeType ?? parsed.mimeType);
  const tmpPath = await Deno.makeTempFile({
    prefix: "context-tg-image-",
    suffix: `.${extension}`,
  });

  await Deno.writeFile(tmpPath, parsed.bytes);

  return {
    input: new InputFile(tmpPath, `generated-image.${extension}`),
    cleanup: async () => {
      await Deno.remove(tmpPath).catch((error) =>
        logError("Failed to delete temporary generated image:", {
          tmpPath,
          error,
        }),
      );
    },
  };
}

function getErrorDetails(error: unknown): string {
  if (error instanceof LlmRequestError) {
    return error.details;
  }

  return error instanceof Error ? error.message : String(error);
}

function formatHtmlBlockquote(text: string): string {
  const trimmedText = text.trim() || "Unknown error";
  return `<blockquote>${escapeHtml(trimmedText)}</blockquote>`;
}

function formatModelFailureResponse(
  error: unknown,
  resumeCommand: string | undefined,
): string {
  const parts = [
    "Failed to generate response",
    formatHtmlBlockquote(getErrorDetails(error)),
  ];

  if (resumeCommand) {
    parts.push(resumeCommand);
  }

  return parts.join("\n\n");
}

function formatQuotaExceededResponse(
  key: UsageKey,
  status: Pick<UsageConsumeResult, "used" | "quota">,
): string {
  return `Quota exceeded: ${key} ${status.used}/${status.quota}`;
}

function formatGuestModelFailureResponse(error: unknown): string {
  return [
    "Failed to generate response",
    formatMarkdownBlockquote(getErrorDetails(error)),
  ].join("\n\n");
}

function filterToolsForUsage(
  tools: ToolName[],
  options: {
    toolUsageRemaining: boolean;
    imageUsageRemaining: boolean;
  },
): ToolName[] {
  return tools.filter((tool) => {
    if (!options.toolUsageRemaining) {
      return false;
    }

    if (
      (tool === "send_report" || tool === "send_trading_report") &&
      !options.imageUsageRemaining
    ) {
      return false;
    }

    if (
      (tool === "generate_image" || tool === "generate_image_nsfw") &&
      !options.imageUsageRemaining
    ) {
      return false;
    }

    return true;
  });
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

async function sendReportResponse(
  ctx: Context,
  message: TextMessage,
  report: LlmReport,
  formattedResponse: ReturnType<typeof formatLlmResponse>,
): Promise<Array<{ message_id: number }>> {
  const filename = normalizeHtmlFilename(report.filename);
  const tmpPath = await Deno.makeTempFile({
    prefix: "context-tg-report-",
    suffix: ".html",
  });
  const sentMessages = [];

  try {
    await Deno.writeTextFile(tmpPath, report.documentHtml);

    const sentDocument = await ctx.replyWithDocument(
      new InputFile(tmpPath, filename),
      {
        reply_parameters: {
          message_id: message.message_id,
        },
      },
    );
    sentMessages.push(sentDocument);
  } finally {
    await Deno.remove(tmpPath).catch((error) =>
      logError("Failed to delete temporary report:", { tmpPath, error }),
    );
  }

  sentMessages.push(
    ...(await sendRichMarkdownResponse(
      ctx,
      message,
      formattedResponse.richMarkdown || "Report attached.",
    )),
  );

  return sentMessages;
}

async function sendGeneratedImagePhotos(
  ctx: Context,
  message: TextMessage,
  images: LlmGeneratedImage[],
): Promise<Array<{ message_id: number }>> {
  const sentMessages = [];

  for (const image of images) {
    const { input, cleanup } = await createGeneratedImageInputFile(image);

    try {
      const sentPhoto = await ctx.replyWithPhoto(input, {
        reply_parameters: {
          message_id: message.message_id,
        },
      });
      sentMessages.push(sentPhoto);
    } finally {
      await cleanup();
    }
  }

  return sentMessages;
}

async function sendStickerMessages(
  ctx: Context,
  message: TextMessage,
  stickers: LlmSticker[],
): Promise<{
  sentMessages: Array<{ message_id: number }>;
  unsentStickers: LlmSticker[];
}> {
  const sentMessages: Array<{ message_id: number }> = [];
  const unsentStickers: LlmSticker[] = [];

  for (const requestedSticker of stickers) {
    try {
      const sticker = await findRandomStickerForEmoji(
        ctx.database,
        ctx.api,
        requestedSticker.emoji,
      );

      if (!sticker) {
        unsentStickers.push(requestedSticker);
        continue;
      }

      const sentSticker = await ctx.replyWithSticker(sticker.fileId, {
        reply_parameters: {
          message_id: message.message_id,
        },
      });
      sentMessages.push(sentSticker);
    } catch (error) {
      unsentStickers.push(requestedSticker);
      logError("Failed to send sticker:", {
        emoji: requestedSticker.emoji,
        error,
      });
    }
  }

  return { sentMessages, unsentStickers };
}

async function sendRichMarkdownResponse(
  ctx: Context,
  message: TextMessage,
  richMarkdown: string,
): Promise<Array<{ message_id: number }>> {
  if (!ctx.chat) {
    return [];
  }

  const sentMessages = [];
  const content = richMarkdown.trim() ? richMarkdown : "Done.";

  for (const chunk of splitRichMarkdownMessage(content)) {
    const sentMessage = await ctx.api.sendRichMessage(
      ctx.chat.id,
      {
        markdown: chunk,
      },
      {
        reply_parameters: {
          message_id: message.message_id,
        },
      },
    );

    sentMessages.push(sentMessage);
  }

  return sentMessages;
}

function formatGuestResultDescription(richMarkdown: string): string {
  const normalized = normalizeWhitespace(
    richMarkdown
      .replaceAll(/!\[[^\]]*]\([^)]+\)/g, "")
      .replaceAll(/\[[^\]]*]\(([^)]+)\)/g, "$1")
      .replaceAll(/[`*_~>#|[\]()]/g, " "),
  );

  return truncateCodePoints(normalized, GUEST_RESULT_DESCRIPTION_LENGTH);
}

function buildGuestArticleResult(
  message: TextMessage,
  richMarkdown: string,
): Parameters<Context["answerGuestQuery"]>[0] {
  const content = richMarkdown.trim() ? richMarkdown : "Done.";

  return {
    type: "article",
    id: `guest-${message.message_id}`,
    title: "Laylo",
    description: formatGuestResultDescription(content),
    input_message_content: {
      rich_message: {
        markdown: splitRichMarkdownMessage(content)[0],
      },
    },
  };
}

async function sendGuestLlmResponse(
  ctx: Context,
  message: TextMessage,
  llmResponse: LlmResponse,
): Promise<void> {
  const formattedResponse = formatLlmResponse(llmResponse);
  const richMarkdown = formattedResponse.richMarkdown.trim();
  const result = buildGuestArticleResult(
    message,
    formattedResponse.richMarkdown,
  );

  try {
    await ctx.answerGuestQuery(result);
  } catch (error) {
    logError("Failed to answer guest query:", error);

    if (richMarkdown) {
      await sendRichMarkdownResponse(ctx, message, richMarkdown);
    } else {
      await ctx.reply("Done.");
    }
  }
}

async function sendGuestMarkdownResponse(
  ctx: Context,
  message: TextMessage,
  richMarkdown: string,
): Promise<void> {
  try {
    await ctx.answerGuestQuery(buildGuestArticleResult(message, richMarkdown));
  } catch (error) {
    logError("Failed to answer guest query:", error);
    await sendRichMarkdownResponse(ctx, message, richMarkdown);
  }
}

function getResumeCommand(messageId: number): string {
  return `/resume_${messageId}`;
}

function getResumePrompt(taskText: string): string {
  return [
    "Continue the previous failed or canceled task and produce the final answer.",
    "",
    `Original task: ${taskText}`,
  ].join("\n");
}

function getErrorRecoveryPrompt(taskText: string, error: unknown): string {
  return [
    "The previous attempt to handle this Telegram message failed because of an application or tool error.",
    "Use the original request and the error below to produce the best user-facing response you can.",
    "If the task cannot be completed because of the error, explain that briefly. Do not include the diagnostic blockquote or footer icon; the app will append those.",
    "",
    "Original request:",
    taskText.trim() || "No text message was available.",
    "",
    "Error:",
    getErrorDetails(error),
  ].join("\n");
}

function getResumableResponseId(
  error: unknown,
  progressResponseId: string | undefined,
): string | undefined {
  return error instanceof LlmRequestError
    ? (error.lastResponseId ?? progressResponseId)
    : progressResponseId;
}

async function saveResumableTaskThread(
  ctx: Context,
  chatId: number,
  message: TextMessage,
  threadId: number,
  agent: AgentDefinition,
  responseId: string | undefined,
  taskCreated: boolean,
): Promise<boolean> {
  if (!responseId || !taskCreated) {
    return false;
  }

  try {
    await saveThread(ctx.database, {
      chat_id: chatId,
      message_id: message.message_id,
      thread_id: threadId,
      response_id: responseId,
      agent_id: agent.id,
    });
    return true;
  } catch (error) {
    logError("Failed to save resumable task thread:", { responseId, error });
    return false;
  }
}

async function saveRecoveredResponseThread(
  ctx: Context,
  chatId: number,
  message: TextMessage,
  threadId: number,
  agent: AgentDefinition,
  llmResponse: LlmResponse,
  sentMessages: Array<{ message_id: number }>,
  saveOriginalMessageThread: boolean,
): Promise<void> {
  if (!llmResponse.response_id) {
    return;
  }

  const responseAgent = getAgentById(llmResponse.handoff_agent_id) ?? agent;

  try {
    if (saveOriginalMessageThread) {
      await saveThread(ctx.database, {
        chat_id: chatId,
        message_id: message.message_id,
        thread_id: threadId,
        response_id: llmResponse.response_id,
        agent_id: responseAgent.id,
      });
    }

    for (const sentMessage of sentMessages) {
      await createThread(ctx.database, {
        chat_id: chatId,
        message_id: sentMessage.message_id,
        thread_id: threadId,
        response_id: llmResponse.response_id,
        agent_id: responseAgent.id,
      });
    }
  } catch (error) {
    logError("Failed to save recovered error response thread:", {
      responseId: llmResponse.response_id,
      error,
    });
  }
}

async function sendRecoveredErrorResponse(
  ctx: Context,
  chatId: number,
  message: TextMessage,
  taskText: string,
  threadId: number,
  agent: AgentDefinition,
  error: unknown,
  signal: AbortSignal,
  saveOriginalMessageThread: boolean,
): Promise<void> {
  const toolContext = getLlmToolContext(chatId, message);
  const llmResponse = await withTypingAction(
    ctx,
    async () =>
      await requestLlm(
        getErrorRecoveryPrompt(taskText, error),
        [],
        undefined,
        {
          database: ctx.database,
          context: toolContext,
          agentId: agent.id,
          signal,
        },
        agent.buildInstructions(),
        agent.MODEL,
      ),
  );
  const formattedResponse = formatLlmResponse(llmResponse, {
    debug: await getChatDebugMode(ctx.database, chatId),
    errors: [getErrorDetails(error)],
  });
  const sentMessages = await sendRichMarkdownResponse(
    ctx,
    message,
    formattedResponse.richMarkdown,
  );

  await saveRecoveredResponseThread(
    ctx,
    chatId,
    message,
    threadId,
    agent,
    llmResponse,
    sentMessages,
    saveOriginalMessageThread,
  );
}

type HandleChatRequestOptions = {
  reply?: TextMessage;
  replyContext?: LlmContextMessage;
  requestMessages?: Array<{
    text: string;
    message: LlmContextMessage | undefined;
  }>;
  thread?: Thread;
  threadId?: number;
  taskText?: string;
  tools?: ToolName[];
  onUnhandledError?: () => Promise<void>;
};

async function handleChatRequest(
  ctx: Context,
  message: TextMessage,
  text: string,
  options: HandleChatRequestOptions = {},
): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const chatId = ctx.chat.id;
  const reply = options.reply;
  const replyContext = options.replyContext ?? reply;
  const thread = options.thread;
  const threadId =
    thread?.thread_id ??
    options.threadId ??
    message.message_thread_id ??
    message.message_id;
  const textUsage = await consumeUsage(ctx.database, chatId, "text_responses");

  if (!textUsage.ok) {
    await ctx.reply(formatQuotaExceededResponse("text_responses", textUsage), {
      reply_parameters: {
        message_id: message.message_id,
      },
    });
    return;
  }

  const taskKey = {
    chat_id: chatId,
    message_id: message.message_id,
  };
  let taskCreated = false;
  let taskStatus: Exclude<TaskStatus, "working"> = "finished";
  let responseSent = false;
  let imageUsageConsumedCount = 0;
  let progressResponseId: string | undefined;
  let activeAgent: AgentDefinition = normalAgent;
  const taskAbortController = createTaskAbortController(taskKey);

  try {
    await createTask(ctx.database, {
      ...taskKey,
      thread_id: threadId,
      task_text:
        options.taskText ?? stripMessageAgentName(text, ctx.me.username),
    });
    taskCreated = true;
  } catch (error) {
    logError("Failed to create task:", { error });
  }

  try {
    const explicitAgent = resolveMessageAgent(text, ctx.me.username);
    const threadAgent = getAgentById(thread?.agent_id) ?? normalAgent;
    const agent: AgentDefinition = explicitAgent ?? threadAgent;
    activeAgent = agent;
    const requestedTools = options.tools ?? agent.tools;
    const toolUsage = await getUsageStatus(ctx.database, chatId, "tool_usages");

    if (requestedTools.length > 0 && toolUsage.used >= toolUsage.quota) {
      throw new Error(formatQuotaExceededResponse("tool_usages", toolUsage));
    }

    const imageUsageRemaining = await hasUsageRemaining(
      ctx.database,
      chatId,
      "image_responses",
    );
    const agentTools = filterToolsForUsage(requestedTools, {
      toolUsageRemaining: toolUsage.used < toolUsage.quota,
      imageUsageRemaining,
    });
    const responseId =
      thread?.response_id &&
      (!explicitAgent || explicitAgent.id === threadAgent.id)
        ? thread.response_id
        : undefined;
    const toolContext = getLlmToolContext(chatId, message);
    const slowResponseReaction = createSlowResponseReactionTracker(ctx);
    const llmResponse = await (async () => {
      try {
        return await withTypingAction(ctx, async () => {
          const requestOptions: LlmRequestOptions = {
            database: ctx.database,
            context: toolContext,
            agentId: agent.id,
            onProgress: async (progress) => {
              progressResponseId = progress.responseId ?? progressResponseId;
            },
            onWarning: (details: string) =>
              sendLlmWarning(ctx, message, details),
            signal: taskAbortController.signal,
          };

          if (responseId) {
            const request = await buildLlmRequestInput(
              ctx,
              buildThreadRequest(message, text, replyContext),
              message,
              taskAbortController.signal,
            );

            return await requestLlm(
              request,
              agentTools,
              responseId,
              requestOptions,
              agent.buildInstructions(),
              agent.MODEL,
            );
          }

          const request = await buildLlmRequestInputs(
            ctx,
            options.requestMessages ??
              buildRootRequestMessages(message, text, replyContext),
            taskAbortController.signal,
          );

          return await requestLlm(
            request,
            agentTools,
            undefined,
            requestOptions,
            agent.buildInstructions(),
            agent.MODEL,
          );
        });
      } finally {
        slowResponseReaction.stop();
      }
    })();

    await recordUsage(
      ctx.database,
      chatId,
      "tool_usages",
      llmResponse.tool_call_count,
    );

    const imageAttachmentCount =
      llmResponse.images.length + (llmResponse.report ? 1 : 0);

    if (imageAttachmentCount > 0) {
      const imageUsage = await consumeUsage(
        ctx.database,
        chatId,
        "image_responses",
        imageAttachmentCount,
      );

      if (!imageUsage.ok) {
        throw new Error(
          formatQuotaExceededResponse("image_responses", imageUsage),
        );
      }

      imageUsageConsumedCount = imageAttachmentCount;
    }

    const sentMessages = [
      ...(await sendGeneratedImagePhotos(ctx, message, llmResponse.images)),
    ];
    const stickerMessages = await sendStickerMessages(
      ctx,
      message,
      llmResponse.stickers,
    );
    sentMessages.push(...stickerMessages.sentMessages);

    const formattedResponse = formatLlmResponse(llmResponse, {
      debug: await getChatDebugMode(ctx.database, chatId),
    });
    const missingStickerFallback =
      stickerMessages.sentMessages.length === 0
        ? stickerMessages.unsentStickers[0]?.emoji
        : undefined;

    if (llmResponse.report) {
      sentMessages.push(
        ...(await sendReportResponse(
          ctx,
          message,
          llmResponse.report,
          formattedResponse,
        )),
      );
    } else if (llmResponse.images.length > 0) {
      sentMessages.push(
        ...(await sendRichMarkdownResponse(
          ctx,
          message,
          formattedResponse.richMarkdown || "Image attached.",
        )),
      );
    } else if (
      formattedResponse.richMarkdown ||
      llmResponse.stickers.length === 0
    ) {
      sentMessages.push(
        ...(await sendRichMarkdownResponse(
          ctx,
          message,
          formattedResponse.richMarkdown,
        )),
      );
    } else if (missingStickerFallback) {
      sentMessages.push(
        ...(await sendRichMarkdownResponse(
          ctx,
          message,
          missingStickerFallback,
        )),
      );
    }

    responseSent = true;

    if (!llmResponse.response_id) {
      return;
    }

    const responseAgent = getAgentById(llmResponse.handoff_agent_id) ?? agent;

    await saveThread(ctx.database, {
      chat_id: chatId,
      message_id: message.message_id,
      thread_id: threadId,
      response_id: llmResponse.response_id,
      agent_id: responseAgent.id,
    });

    for (const sentMessage of sentMessages) {
      await createThread(ctx.database, {
        chat_id: chatId,
        message_id: sentMessage.message_id,
        thread_id: threadId,
        response_id: llmResponse.response_id,
        agent_id: responseAgent.id,
      });
    }
  } catch (error) {
    taskStatus =
      taskAbortController.signal.aborted || isAbortError(error)
        ? "canceled"
        : "failed";
    logError("Error handling message:", error);
    const resumableResponseId = getResumableResponseId(
      error,
      progressResponseId,
    );
    const resumable = await saveResumableTaskThread(
      ctx,
      chatId,
      message,
      threadId,
      activeAgent,
      resumableResponseId,
      taskCreated,
    );
    const refundUnusedUsage = async () => {
      if (responseSent) {
        return;
      }

      await refundUsage(ctx.database, chatId, "text_responses");

      if (imageUsageConsumedCount > 0) {
        await refundUsage(
          ctx.database,
          chatId,
          "image_responses",
          imageUsageConsumedCount,
        );
      }
    };

    if (taskStatus === "canceled") {
      await refundUnusedUsage();
      const canceledResponse = resumable
        ? `Canceled. Resume: ${getResumeCommand(message.message_id)}`
        : "Canceled.";

      await ctx.reply(canceledResponse, {
        ...linkPreviewOptions,
        reply_parameters: {
          message_id: message.message_id,
        },
      });
      return;
    }

    let responseError = error;

    if (!(error instanceof LlmRequestError) && !responseSent) {
      try {
        await sendRecoveredErrorResponse(
          ctx,
          chatId,
          message,
          options.taskText ?? stripMessageAgentName(text, ctx.me.username),
          threadId,
          activeAgent,
          error,
          taskAbortController.signal,
          !resumable,
        );
        responseSent = true;
        return;
      } catch (recoveryError) {
        responseError = recoveryError;
        logError("Failed to recover from non-model error:", {
          originalError: error,
          recoveryError,
        });
      }
    }

    await refundUnusedUsage();

    const errorResponse = formatModelFailureResponse(
      responseError,
      resumable ? getResumeCommand(message.message_id) : undefined,
    );

    await ctx.reply(errorResponse, {
      ...linkPreviewOptions,
      parse_mode: "HTML",
    });
    await options.onUnhandledError?.();
  } finally {
    deleteTaskAbortController(taskKey);
    if (taskCreated) {
      try {
        await completeTask(ctx.database, taskKey, taskStatus);
      } catch (error) {
        logError("Failed to finish task:", { error });
      }
    }
  }
}

async function handleGuestChatRequest(
  ctx: Context,
  message: TextMessage,
  text: string,
): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const chatId = ctx.chat.id;
  const textUsage = await consumeUsage(ctx.database, chatId, "text_responses");

  if (!textUsage.ok) {
    await sendGuestMarkdownResponse(
      ctx,
      message,
      formatQuotaExceededResponse("text_responses", textUsage),
    );
    return;
  }

  let responseSent = false;

  try {
    const toolUsage = await getUsageStatus(ctx.database, chatId, "tool_usages");

    if (guestAgent.tools.length > 0 && toolUsage.used >= toolUsage.quota) {
      throw new Error(formatQuotaExceededResponse("tool_usages", toolUsage));
    }

    const agentTools = filterToolsForUsage(guestAgent.tools, {
      toolUsageRemaining: toolUsage.used < toolUsage.quota,
      imageUsageRemaining: false,
    });
    const toolContext = getLlmToolContext(chatId, message);
    const request = await buildLlmRequestInputs(
      ctx,
      buildRootRequestMessages(message, text, undefined),
    );
    const llmResponse = await withTypingAction(
      ctx,
      async () =>
        await requestLlm(
          request,
          agentTools,
          undefined,
          {
            database: ctx.database,
            context: toolContext,
            agentId: guestAgent.id,
          },
          guestAgent.buildInstructions(),
          guestAgent.MODEL,
        ),
    );

    await recordUsage(
      ctx.database,
      chatId,
      "tool_usages",
      llmResponse.tool_call_count,
    );

    await sendGuestLlmResponse(ctx, message, llmResponse);
    responseSent = true;
  } catch (error) {
    logError("Error handling guest message:", error);

    if (!responseSent) {
      await refundUsage(ctx.database, chatId, "text_responses");
    }

    await sendGuestMarkdownResponse(
      ctx,
      message,
      formatGuestModelFailureResponse(error),
    );
  }
}

function getProactiveTools(): ToolName[] {
  return normalAgent.tools.filter(
    (tool) => !PROACTIVE_DISABLED_TOOLS.has(tool),
  );
}

function buildProactiveRequest(messages: MessageMetadata[]): string {
  return [
    "Automatic internal trigger: you were called into the chat after the configured message interval.",
    "Use the recent chat context below, equivalent to read_last_messages with count 10, and answer naturally as Laylo.",
    "Do not mention the automatic trigger, counters, or tools. Keep it short and make one useful, funny, or context-aware contribution to the current conversation.",
    "",
    "Recent chat messages, oldest to newest:",
    messages.map(formatMessageLine).join("\n"),
  ].join("\n");
}

function shouldSkipProactiveAgentResponse(
  ctx: Context,
  message: TextMessage,
): boolean {
  const text = getMessageText(message);
  const reply = getActualReply(message);

  return (
    !text ||
    startsWithCommandPrefix(text) ||
    isAddressed(text, ctx.me.username) ||
    isDirectReplyToBot(reply, ctx.me.id)
  );
}

export async function maybeSendProactiveAgentResponse(
  ctx: Context,
  message: ProactiveTriggerMessage,
  chatId: number,
): Promise<void> {
  const textMessage = message as TextMessage;

  if (shouldSkipProactiveAgentResponse(ctx, textMessage)) {
    return;
  }

  const { messageCount, enabled, intervalMessageCount } =
    await incrementProactiveResponseMessageCount(ctx.database, chatId);

  if (
    !shouldTriggerProactiveResponse(messageCount, enabled, intervalMessageCount)
  ) {
    return;
  }

  const reply = getActualReply(textMessage);
  const threadId = getForumThreadId(textMessage, reply);
  const messages = await readLastMessages(PROACTIVE_CONTEXT_MESSAGE_COUNT, {
    chatId,
    messageId: message.message_id,
    threadId,
  });

  if (messages.length === 0) {
    return;
  }

  await handleChatRequest(ctx, textMessage, PROACTIVE_TASK_TEXT, {
    requestMessages: [
      { text: buildProactiveRequest(messages), message: undefined },
    ],
    taskText: PROACTIVE_TASK_TEXT,
    threadId,
    tools: getProactiveTools(),
  });
}

export async function safelyMaybeSendProactiveAgentResponse(
  ctx: Context,
  message: ProactiveTriggerMessage,
  chatId: number,
): Promise<void> {
  try {
    await maybeSendProactiveAgentResponse(ctx, message, chatId);
  } catch (error) {
    logError("Failed to send proactive agent response:", error);
  }
}

export async function replyWithResumeTask(
  ctx: Context,
  messageId: number,
): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const taskKey = {
    chat_id: ctx.chat.id,
    message_id: messageId,
  };
  const task = await getTask(ctx.database, taskKey);

  if (!task) {
    await ctx.reply("Task not found.");
    return;
  }

  if (task.status === "working") {
    await ctx.reply("Task is still working.");
    return;
  }

  if (task.status === "finished") {
    await ctx.reply("Task already finished.");
    return;
  }

  if (!(await hasResumableTask(ctx.database, taskKey))) {
    await ctx.reply("Task has no progress to resume.");
    return;
  }

  const thread = await getThread(ctx.database, taskKey);

  if (!thread?.response_id) {
    await ctx.reply("Task has no progress to resume.");
    return;
  }

  const message = ctx.message as TextMessage;
  await handleChatRequest(ctx, message, getResumePrompt(task.task_text), {
    thread,
    taskText: `Resume: ${task.task_text}`,
  });
}

chatComposer.on("guest_message", async (ctx, next) => {
  if (!ctx.chat || !ctx.guestMessage) {
    await next();
    return;
  }

  const message = ctx.guestMessage as TextMessage;
  const text = getMessageText(message);
  const requestText =
    text ??
    (hasImageAttachments(message)
      ? "Please respond to the attached image."
      : undefined);

  if (!requestText || startsWithCommandPrefix(text)) {
    await next();
    return;
  }

  await handleGuestChatRequest(ctx, message, requestText);
});

chatComposer.on("message", async (ctx, next) => {
  if (!ctx.chat) {
    await next();
    return;
  }

  const message = ctx.message as TextMessage;
  const text = getMessageText(message);
  const reply = getActualReply(message);
  const replyContext = getReplyContext(message, reply);
  const isDirectBotReply = isDirectReplyToBot(reply, ctx.me.id);
  const addressed = text ? isAddressed(text, ctx.me.username) : false;
  const thread = reply
    ? await getThread(ctx.database, {
        chat_id: ctx.chat.id,
        message_id: reply.message_id,
      })
    : undefined;
  const repliedTask =
    reply && !thread
      ? await getTask(ctx.database, {
          chat_id: ctx.chat.id,
          message_id: reply.message_id,
        })
      : undefined;
  const requestText =
    text ??
    (isDirectBotReply && hasImageAttachments(message)
      ? "Please respond to the attached image."
      : undefined);

  if (
    !requestText ||
    startsWithCommandPrefix(text) ||
    (!addressed && !isDirectBotReply)
  ) {
    await next();
    return;
  }

  await handleChatRequest(ctx, message, requestText, {
    reply,
    replyContext,
    thread,
    threadId: repliedTask?.thread_id ?? message.message_thread_id,
    onUnhandledError: next,
  });
});
