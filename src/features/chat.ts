import { createDebug } from "@grammyjs/debug";
import { Composer, InputFile } from "grammy";
import type { Context } from "../bot.ts";
import {
  type AgentDefinition,
  getAgentById,
  normalAgent,
  resolveMessageAgent,
  stripMessageAgentName,
} from "./agents/index.ts";
import { APP_ENV } from "./env.ts";
import {
  type LlmCitation,
  type LlmGeneratedImage,
  type LlmImageInput,
  type LlmReport,
  LlmRequestError,
  type LlmRequestInput,
  type LlmRequestOptions,
  type LlmResponse,
  type LlmToolContext,
  requestLlm,
  type ToolName,
} from "./llm.ts";
import { startsWithCommandPrefix } from "./message-filter.ts";
import {
  completeTask,
  createTask,
  createTaskAbortController,
  deleteTaskAbortController,
  getTask,
  hasResumableTask,
  type TaskStatus,
} from "./tasks.ts";
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

type TextMessage = {
  message_id: number;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
  document?: TelegramDocument;
  quote?: {
    text: string;
  };
  reply_to_message?: TextMessage;
};

type TelegramUser = {
  id: number;
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

type TelegramImageAttachment = {
  fileId: string;
  mimeType?: string;
};

type BotReaction = "🤔";

const logError = createDebug("app:chat:error");

export const chatComposer = new Composer<Context>();

const TELEGRAM_CAPTION_CHUNK_SIZE = 1000;
const TELEGRAM_RICH_MESSAGE_CHUNK_SIZE_BYTES = 30_000;
const SLOW_RESPONSE_REACTION_DELAY_MS = 15_000;

const linkPreviewOptions = {
  link_preview_options: {
    is_disabled: true,
  },
};

function getMessageText(message: TextMessage): string | undefined {
  return message.text ?? message.caption;
}

function getLlmContextText(
  message: TextMessage | undefined,
): string | undefined {
  const text = message && getMessageText(message);
  return startsWithCommandPrefix(text) ? undefined : text;
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
  message: TextMessage | undefined,
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

function hasImageAttachments(message: TextMessage | undefined): boolean {
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

function buildRootRequest(text: string, replyText?: string): string {
  return replyText ? `${replyText}\n\n${text}` : text;
}

function buildRootRequestText(
  text: string,
  reply: TextMessage | undefined,
): string {
  const replyText = getLlmContextText(reply);

  if (replyText && hasImageAttachments(reply)) {
    return `Replied message:\n${replyText}\n\nUser: ${text}`;
  }

  if (replyText) {
    return buildRootRequest(text, replyText);
  }

  if (hasImageAttachments(reply)) {
    return `User is replying to the attached image.\n\nUser: ${text}`;
  }

  return text;
}

function buildThreadRequest(text: string, quoteText?: string): string {
  const quote = quoteText?.trim();

  return quote
    ? `Replying to quote: ${JSON.stringify(quote)}\nUser: ${JSON.stringify(
        text,
      )}`
    : text;
}

function getLlmToolContext(
  chatId: number,
  message: TextMessage,
): LlmToolContext {
  return {
    chatId,
    messageId: message.message_id,
    replyMessageId: message.reply_to_message?.message_id,
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
  messages: Array<TextMessage | undefined>,
  signal?: AbortSignal,
): Promise<LlmRequestInput> {
  const attachments = messages.flatMap(getMessageImageAttachments);

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

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
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

function splitTextMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let chunk = "";

  for (const character of text) {
    if (chunk.length >= maxLength) {
      chunks.push(chunk);
      chunk = "";
    }

    chunk += character;
  }

  if (chunk) {
    chunks.push(chunk);
  }

  return chunks.length > 0 ? chunks : [text];
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

function getValidCitations(
  response: string,
  citations: LlmCitation[],
): LlmCitation[] {
  return citations
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

function hasSearchInfo(llmResponse: LlmResponse): boolean {
  return (
    llmResponse.web_search.used ||
    llmResponse.web_search.citations.length > 0 ||
    llmResponse.web_search.sources.length > 0
  );
}

const TOOL_USAGE_EMOJIS: Partial<
  Record<ToolName, { id: string; fallback: string }>
> = {
  web_search: { id: "5879585266426973039", fallback: "🔎" },
  search_chat: { id: "5891169510483823323", fallback: "💬" },
  read_last_messages: { id: "5891169510483823323", fallback: "💬" },
  send_report: { id: "5877597667231534929", fallback: "📄" },
  send_trading_report: { id: "5877597667231534929", fallback: "📄" },
  get_markets_state: { id: "5900104897885376843", fallback: "📈" },
  fetch_ticker_price: { id: "5974217466270716579", fallback: "💵" },
  get_recent_news: { id: "6008090211181923982", fallback: "📰" },
  read_youtube_video: { id: "6005986106703613755", fallback: "▶️" },
  generate_image: { id: "5766879414704935108", fallback: "🖼️" },
};

function formatToolUsageMarkdown(tools: ToolName[]): string {
  const usedEmojiIds = new Set<string>();
  const emojis: string[] = [];

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

function appendToolUsageMarkdown(text: string, tools: ToolName[]): string {
  const suffix = formatToolUsageMarkdown(tools);

  if (!suffix) {
    return text;
  }

  const trimmedText = text.trimEnd();
  return trimmedText ? `${trimmedText}\n\n${suffix}` : suffix;
}

function formatToolUsageText(tools: ToolName[]): string {
  const usedEmojiIds = new Set<string>();
  const emojis: string[] = [];

  for (const tool of tools) {
    const emoji = TOOL_USAGE_EMOJIS[tool];

    if (!emoji || usedEmojiIds.has(emoji.id)) {
      continue;
    }

    usedEmojiIds.add(emoji.id);
    emojis.push(emoji.fallback);
  }

  return emojis.join(" ");
}

function appendToolUsageText(text: string, tools: ToolName[]): string {
  const suffix = formatToolUsageText(tools);

  if (!suffix) {
    return text;
  }

  const trimmedText = text.trimEnd();
  return trimmedText ? `${trimmedText}\n\n${suffix}` : suffix;
}

function getResponseSourceLinks(llmResponse: LlmResponse): string[] {
  const links: string[] = [];

  for (const citation of getValidCitations(
    llmResponse.response ?? "",
    llmResponse.web_search.citations,
  )) {
    if (!links.includes(citation.link)) {
      links.push(citation.link);
    }
  }

  for (const source of llmResponse.web_search.sources) {
    if (!links.includes(source.link)) {
      links.push(source.link);
    }
  }

  return links;
}

function appendMarkdownSources(text: string, llmResponse: LlmResponse): string {
  const links = getResponseSourceLinks(llmResponse);

  if (links.length === 0) {
    return text;
  }

  const sources = links
    .map((link, index) => `${index + 1}. ${link}`)
    .join("\n");
  const trimmedText = text.trimEnd();
  return `${trimmedText}\n\nSources\n${sources}`;
}

function formatLlmResponse(llmResponse: LlmResponse): {
  richMarkdown: string;
  captionText: string;
} {
  const response = llmResponse.response ?? "";
  const richMarkdown = hasSearchInfo(llmResponse)
    ? appendMarkdownSources(response, llmResponse)
    : response;

  return {
    richMarkdown: appendToolUsageMarkdown(richMarkdown, llmResponse.tools),
    captionText: appendToolUsageText(response, llmResponse.tools),
  };
}

function getErrorResponseText(error: unknown): string {
  if (error instanceof LlmRequestError) {
    const prefix = error.kind === "content_filter" ? "Warn" : "Error";
    return `${prefix}: ${sanitizeLlmHtml(error.details)}`;
  }

  const details = error instanceof Error ? error.message : String(error);
  return `Error: ${sanitizeLlmHtml(details)}`;
}

function formatQuotaExceededResponse(
  key: UsageKey,
  status: Pick<UsageConsumeResult, "used" | "quota">,
): string {
  return `Quota exceeded: ${key} ${status.used}/${status.quota}`;
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

    if (tool === "generate_image" && !options.imageUsageRemaining) {
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

function normalizeReportFilename(filename: string): string {
  const safeFilename = filename
    .replaceAll(/[\\/]/g, "-")
    .replaceAll(/[^a-z0-9._ -]/gi, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  const normalized = safeFilename || "research-report.html";

  return /\.html?$/i.test(normalized) ? normalized : `${normalized}.html`;
}

async function sendReportResponse(
  ctx: Context,
  message: TextMessage,
  report: LlmReport,
  formattedResponse: ReturnType<typeof formatLlmResponse>,
): Promise<Array<{ message_id: number }>> {
  const filename = normalizeReportFilename(report.filename);
  const tmpPath = await Deno.makeTempFile({
    prefix: "context-tg-report-",
    suffix: ".html",
  });
  const captionChunks = splitTextMessage(
    formattedResponse.captionText || "Report attached.",
    TELEGRAM_CAPTION_CHUNK_SIZE,
  );
  const sentMessages = [];

  try {
    await Deno.writeTextFile(tmpPath, report.documentHtml);

    const sentDocument = await ctx.replyWithDocument(
      new InputFile(tmpPath, filename),
      {
        caption: captionChunks[0],
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

  for (const chunk of captionChunks.slice(1)) {
    const sentMessage = await ctx.reply(chunk, {
      ...linkPreviewOptions,
      reply_parameters: {
        message_id: message.message_id,
      },
    });

    sentMessages.push(sentMessage);
  }

  return sentMessages;
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

async function createImageInputFile(
  image: LlmGeneratedImage,
): Promise<{ input: string | InputFile; cleanup: () => Promise<void> }> {
  if (image.url) {
    return {
      input: image.url,
      cleanup: async () => {},
    };
  }

  if (!image.dataUrl) {
    throw new Error("Generated image is missing data.");
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

async function sendGeneratedImagesResponse(
  ctx: Context,
  message: TextMessage,
  images: LlmGeneratedImage[],
  formattedResponse: ReturnType<typeof formatLlmResponse>,
): Promise<Array<{ message_id: number }>> {
  const captionChunks = splitTextMessage(
    formattedResponse.captionText || "Image attached.",
    TELEGRAM_CAPTION_CHUNK_SIZE,
  );
  const sentMessages = [];

  for (const [index, image] of images.entries()) {
    const { input, cleanup } = await createImageInputFile(image);

    try {
      const sentPhoto = await ctx.replyWithPhoto(input, {
        caption: index === 0 ? captionChunks[0] : undefined,
        reply_parameters: {
          message_id: message.message_id,
        },
      });
      sentMessages.push(sentPhoto);
    } finally {
      await cleanup();
    }
  }

  for (const chunk of captionChunks.slice(1)) {
    const sentMessage = await ctx.reply(chunk, {
      ...linkPreviewOptions,
      reply_parameters: {
        message_id: message.message_id,
      },
    });

    sentMessages.push(sentMessage);
  }

  return sentMessages;
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
    const sentMessage = await ctx.api.raw.sendRichMessage({
      chat_id: ctx.chat.id,
      rich_message: {
        markdown: chunk,
      },
      reply_parameters: {
        message_id: message.message_id,
      },
    });

    sentMessages.push(sentMessage);
  }

  return sentMessages;
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

type HandleChatRequestOptions = {
  reply?: TextMessage;
  thread?: Thread;
  threadId?: number;
  taskText?: string;
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
  const thread = options.thread;
  const threadId = thread?.thread_id ?? options.threadId ?? message.message_id;
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
    const toolUsage = await getUsageStatus(ctx.database, chatId, "tool_usages");

    if (agent.tools.length > 0 && toolUsage.used >= toolUsage.quota) {
      throw new Error(formatQuotaExceededResponse("tool_usages", toolUsage));
    }

    const imageUsageRemaining = await hasUsageRemaining(
      ctx.database,
      chatId,
      "image_responses",
    );
    const agentTools = filterToolsForUsage(agent.tools, {
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
            context: toolContext,
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
              buildThreadRequest(
                text,
                startsWithCommandPrefix(message.quote?.text)
                  ? undefined
                  : message.quote?.text,
              ),
              [message],
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

          const request = await buildLlmRequestInput(
            ctx,
            buildRootRequestText(text, reply),
            [reply, message],
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

    const formattedResponse = formatLlmResponse(llmResponse);

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

    const sentMessages =
      llmResponse.images.length > 0
        ? await sendGeneratedImagesResponse(
            ctx,
            message,
            llmResponse.images,
            formattedResponse,
          )
        : llmResponse.report
          ? await sendReportResponse(
              ctx,
              message,
              llmResponse.report,
              formattedResponse,
            )
          : [];

    if (!llmResponse.report && llmResponse.images.length === 0) {
      sentMessages.push(
        ...(await sendRichMarkdownResponse(
          ctx,
          message,
          formattedResponse.richMarkdown,
        )),
      );
    }

    responseSent = true;

    if (!llmResponse.response_id) {
      return;
    }

    await saveThread(ctx.database, {
      chat_id: chatId,
      message_id: message.message_id,
      thread_id: threadId,
      response_id: llmResponse.response_id,
      agent_id: agent.id,
    });

    for (const sentMessage of sentMessages) {
      await createThread(ctx.database, {
        chat_id: chatId,
        message_id: sentMessage.message_id,
        thread_id: threadId,
        response_id: llmResponse.response_id,
        agent_id: agent.id,
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
    if (!responseSent) {
      await refundUsage(ctx.database, chatId, "text_responses");

      if (imageUsageConsumedCount > 0) {
        await refundUsage(
          ctx.database,
          chatId,
          "image_responses",
          imageUsageConsumedCount,
        );
      }
    }

    if (taskStatus === "canceled") {
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

    const errorResponse = resumable
      ? `${getErrorResponseText(error)}\n\nResume: ${getResumeCommand(
          message.message_id,
        )}`
      : getErrorResponseText(error);

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

chatComposer.on("message", async (ctx, next) => {
  if (!ctx.chat) {
    await next();
    return;
  }

  const message = ctx.message as TextMessage;
  const text = getMessageText(message);
  const reply = message.reply_to_message;
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
    thread,
    threadId: repliedTask?.thread_id,
    onUnhandledError: next,
  });
});
