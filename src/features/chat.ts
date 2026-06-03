import { createDebug } from "@grammyjs/debug";
import { Composer, InputFile } from "grammy";
import type { Context } from "../bot.ts";
import { APP_ENV } from "./env.ts";
import {
  DEFAULT_LLM_TOOLS,
  type LlmCitation,
  type LlmHtmlReport,
  type LlmProgress,
  LlmRequestError,
  type LlmResponse,
  type LlmToolContext,
  requestLlm,
} from "./llm.ts";
import { createThread, getThread } from "./threads.ts";

type TextMessage = {
  message_id: number;
  text?: string;
  caption?: string;
  quote?: {
    text: string;
  };
  reply_to_message?: TextMessage;
};

type BotReaction = "🤔" | "👀";

const logError = createDebug("app:chat:error");

export const chatComposer = new Composer<Context>();

const TYPING_ACTION_INTERVAL_MS = 3000;
const TELEGRAM_MESSAGE_CHUNK_SIZE = 3000;
const TELEGRAM_CAPTION_CHUNK_SIZE = 1000;
const SLOW_RESPONSE_REACTION_DELAY_MS = 15_000;

const linkPreviewOptions = {
  link_preview_options: {
    is_disabled: true,
  },
};

function getMessageText(message: TextMessage): string | undefined {
  return message.text ?? message.caption;
}

function isAddressed(text: string, ownUsername: string): boolean {
  const normalizedText = text.toLocaleLowerCase();
  const hasName = APP_ENV.NAMES.some((name) =>
    normalizedText.startsWith(name.toLocaleLowerCase()),
  );
  const hasOwnTag = normalizedText.startsWith(
    `@${ownUsername.toLocaleLowerCase()}`,
  );

  return hasName || hasOwnTag;
}

function buildRootRequest(text: string, replyText?: string): string {
  return replyText ? `${replyText}\n\n${text}` : text;
}

function buildThreadRequest(text: string, quoteText?: string): string {
  const quote = quoteText?.trim();

  return quote
    ? `Replying to quote: ${JSON.stringify(quote)}\nUser: ${JSON.stringify(text)}`
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

function createToolUsageLabelTracker(
  ctx: Context,
  chatId: number,
  message: TextMessage,
): {
  show: (progress: LlmProgress) => Promise<void>;
} {
  let lastLabel: string | undefined;
  let sentMessageId: number | undefined;

  return {
    async show(progress) {
      const label = progress.usageLabel;

      if (!label || label === lastLabel) {
        return;
      }

      try {
        if (sentMessageId) {
          await ctx.api.editMessageText(chatId, sentMessageId, label);
          lastLabel = label;
          return;
        }

        const sentMessage = await ctx.reply(label, {
          reply_parameters: {
            message_id: message.message_id,
          },
        });
        sentMessageId = sentMessage.message_id;
        lastLabel = label;
      } catch (error) {
        logError("Failed to send tool usage label:", { label, error });
      }
    },
  };
}

async function withTypingAction<T>(
  ctx: Context,
  callback: () => Promise<T>,
): Promise<T> {
  await submitTypingAction(ctx);

  const intervalId = setInterval(() => {
    void submitTypingAction(ctx);
  }, TYPING_ACTION_INTERVAL_MS);

  try {
    return await callback();
  } finally {
    clearInterval(intervalId);
  }
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

function getHtmlTagName(tag: string): string | undefined {
  const tagBody = tag.slice(1, -1).trim();
  const name = tagBody.startsWith("/")
    ? tagBody.slice(1).trim()
    : tagBody.split(/\s+/, 1)[0];

  return name?.toLocaleLowerCase() || undefined;
}

function isClosingHtmlTag(tag: string): boolean {
  return tag.slice(1, -1).trim().startsWith("/");
}

function splitHtmlMessage(
  text: string,
  maxVisibleLength = TELEGRAM_MESSAGE_CHUNK_SIZE,
): string[] {
  const chunks: string[] = [];
  const openTags: Array<{ name: string; tag: string }> = [];
  let chunk = "";
  let chunkLength = 0;

  const getOpeningTags = () => openTags.map(({ tag }) => tag).join("");
  const getClosingTags = () =>
    openTags
      .toReversed()
      .map(({ name }) => `</${name}>`)
      .join("");

  const flushChunk = () => {
    if (chunkLength === 0) {
      return;
    }

    chunks.push(chunk + getClosingTags());
    chunk = getOpeningTags();
    chunkLength = 0;
  };

  const appendVisibleText = (visibleText: string) => {
    for (const character of visibleText) {
      if (chunkLength >= maxVisibleLength) {
        flushChunk();
      }

      chunk += character;
      chunkLength += 1;
    }
  };

  const appendEntity = (entity: string) => {
    if (chunkLength >= maxVisibleLength) {
      flushChunk();
    }

    chunk += entity;
    chunkLength += 1;
  };

  const appendTag = (tag: string) => {
    const tagName = getHtmlTagName(tag);
    if (!tagName) {
      chunk += tag;
      return;
    }

    const isClosingTag = isClosingHtmlTag(tag);
    if (!isClosingTag && chunkLength >= maxVisibleLength) {
      flushChunk();
    }

    chunk += tag;

    if (isClosingTag) {
      const lastOpenTag = openTags.at(-1);
      if (lastOpenTag?.name === tagName) {
        openTags.pop();
      }
      return;
    }

    openTags.push({ name: tagName, tag });
  };

  let cursor = 0;
  for (const match of text.matchAll(
    /<[^>]*>|&(?:[a-z]+|#[0-9]+|#x[0-9a-f]+);/gi,
  )) {
    const token = match[0];
    const index = match.index ?? 0;
    appendVisibleText(text.slice(cursor, index));

    if (token.startsWith("<")) {
      appendTag(token);
    } else {
      appendEntity(token);
    }

    cursor = index + token.length;
  }

  appendVisibleText(text.slice(cursor));
  flushChunk();

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

function formatCitations(response: string, citations: LlmCitation[]): string {
  let cursor = 0;
  let formatted = "";

  for (const citation of getValidCitations(response, citations)) {
    formatted += sanitizeLlmHtml(response.slice(cursor, citation.start_index));
    formatted += `<a href="${escapeHtmlAttribute(citation.link)}">ℹ️</a>`;
    cursor = citation.end_index;
  }

  return formatted + sanitizeLlmHtml(response.slice(cursor));
}

function hasSearchInfo(llmResponse: LlmResponse): boolean {
  return (
    llmResponse.web_search.used ||
    llmResponse.web_search.citations.length > 0 ||
    llmResponse.web_search.sources.length > 0
  );
}

function formatLlmResponse(llmResponse: LlmResponse): {
  text: string;
  parse_mode: "HTML";
} {
  const response = llmResponse.response ?? "";

  if (!hasSearchInfo(llmResponse)) {
    return {
      text: sanitizeLlmHtml(response),
      parse_mode: "HTML",
    };
  }

  return {
    text: formatCitations(response, llmResponse.web_search.citations),
    parse_mode: "HTML",
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

function normalizeReportFilename(filename: string): string {
  const safeFilename = filename
    .replaceAll(/[\\/]/g, "-")
    .replaceAll(/[^a-z0-9._ -]/gi, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  const normalized = safeFilename || "research-report.html";

  return /\.html?$/i.test(normalized) ? normalized : `${normalized}.html`;
}

function createHtmlDocument(report: LlmHtmlReport): string {
  const html = report.htmlString.trim();

  if (/^\s*(?:<!doctype\s+html\b|<html[\s>])/i.test(html)) {
    return html;
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(report.filename)}</title>
</head>
<body>
${report.htmlString}
</body>
</html>`;
}

async function sendHtmlReportResponse(
  ctx: Context,
  message: TextMessage,
  report: LlmHtmlReport,
  formattedResponse: ReturnType<typeof formatLlmResponse>,
): Promise<Array<{ message_id: number }>> {
  const filename = normalizeReportFilename(report.filename);
  const tmpPath = await Deno.makeTempFile({
    prefix: "context-tg-report-",
    suffix: ".html",
  });
  const captionChunks = splitHtmlMessage(
    formattedResponse.text || "Report attached.",
    TELEGRAM_CAPTION_CHUNK_SIZE,
  );
  const sentMessages = [];

  try {
    await Deno.writeTextFile(tmpPath, createHtmlDocument(report));

    const sentDocument = await ctx.replyWithDocument(
      new InputFile(tmpPath, filename),
      {
        caption: captionChunks[0],
        parse_mode: formattedResponse.parse_mode,
        reply_parameters: {
          message_id: message.message_id,
        },
      },
    );
    sentMessages.push(sentDocument);
  } finally {
    await Deno.remove(tmpPath).catch((error) =>
      logError("Failed to delete temporary HTML report:", { tmpPath, error }),
    );
  }

  for (const chunk of captionChunks.slice(1)) {
    const sentMessage = await ctx.reply(chunk, {
      ...linkPreviewOptions,
      parse_mode: formattedResponse.parse_mode,
      reply_parameters: {
        message_id: message.message_id,
      },
    });

    sentMessages.push(sentMessage);
  }

  return sentMessages;
}

chatComposer.on("message", async (ctx, next) => {
  const message = ctx.message as TextMessage;
  const text = getMessageText(message);
  const reply = message.reply_to_message;
  const thread = reply
    ? await getThread(ctx.database, {
        chat_id: ctx.chat.id,
        message_id: reply.message_id,
      })
    : undefined;

  if (!text || (!isAddressed(text, ctx.me.username) && !thread)) {
    await next();
    return;
  }

  try {
    const toolContext = getLlmToolContext(ctx.chat.id, message);
    const slowResponseReaction = createSlowResponseReactionTracker(ctx);
    const toolUsageLabel = createToolUsageLabelTracker(
      ctx,
      ctx.chat.id,
      message,
    );
    const llmResponse = await (async () => {
      try {
        return await withTypingAction(ctx, () => {
          const requestOptions = {
            context: toolContext,
            onProgress: (progress: LlmProgress) =>
              toolUsageLabel.show(progress),
            onWarning: (details: string) =>
              sendLlmWarning(ctx, message, details),
          };

          return thread?.response_id
            ? requestLlm(
                buildThreadRequest(text, message.quote?.text),
                DEFAULT_LLM_TOOLS,
                thread.response_id,
                requestOptions,
              )
            : requestLlm(
                buildRootRequest(text, reply && getMessageText(reply)),
                DEFAULT_LLM_TOOLS,
                undefined,
                requestOptions,
              );
        });
      } finally {
        slowResponseReaction.stop();
      }
    })();

    if (llmResponse.tools.includes("web_search")) {
      void submitReaction(ctx, "👀");
    }

    const formattedResponse = formatLlmResponse(llmResponse);
    const sentMessages = llmResponse.html_report
      ? await sendHtmlReportResponse(
          ctx,
          message,
          llmResponse.html_report,
          formattedResponse,
        )
      : [];

    if (!llmResponse.html_report) {
      for (const chunk of splitHtmlMessage(formattedResponse.text)) {
        const sentMessage = await ctx.reply(chunk, {
          ...linkPreviewOptions,
          parse_mode: formattedResponse.parse_mode,
          reply_parameters: {
            message_id: message.message_id,
          },
        });

        sentMessages.push(sentMessage);
      }
    }

    if (!llmResponse.response_id) {
      return;
    }

    for (const sentMessage of sentMessages) {
      await createThread(ctx.database, {
        chat_id: ctx.chat.id,
        message_id: sentMessage.message_id,
        response_id: llmResponse.response_id,
      });
    }
  } catch (error) {
    logError("Error handling message:", error);
    await ctx.reply(getErrorResponseText(error), {
      ...linkPreviewOptions,
      parse_mode: "HTML",
    });
    await next();
  }
});
