import { createDebug } from "@grammyjs/debug";
import { Composer } from "grammy";
import type { Context } from "../bot.ts";
import { APP_ENV } from "./env.ts";
import {
  type LlmCitation,
  type LlmResponse,
  type LlmToolContext,
  requestLlm,
  type ToolName,
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

const logError = createDebug("app:chat:error");

export const chatComposer = new Composer<Context>();

const TYPING_ACTION_INTERVAL_MS = 3000;

const LLM_TOOLS: ToolName[] = [
  "web_search",
  "fetch_ticker_price",
  "get_markets_state",
  "search_chat",
  "read_last_messages",
];

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
  const response = llmResponse.response ?? "I could not generate a response.";

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
    const llmResponse = await withTypingAction(ctx, () => {
      return thread?.response_id
        ? requestLlm(
            buildThreadRequest(text, message.quote?.text),
            LLM_TOOLS,
            thread.response_id,
            toolContext,
          )
        : requestLlm(
            buildRootRequest(text, reply && getMessageText(reply)),
            LLM_TOOLS,
            undefined,
            toolContext,
          );
    });
    const formattedResponse = formatLlmResponse(llmResponse);
    const sentMessage = await ctx.reply(formattedResponse.text, {
      ...linkPreviewOptions,
      parse_mode: formattedResponse.parse_mode,
      reply_parameters: {
        message_id: message.message_id,
      },
    });

    if (!llmResponse.response_id) {
      return;
    }

    await createThread(ctx.database, {
      chat_id: ctx.chat.id,
      message_id: sentMessage.message_id,
      response_id: llmResponse.response_id,
    });
  } catch (error) {
    await ctx.reply("I could not generate a response", {
      ...linkPreviewOptions,
      parse_mode: "HTML",
    });
    logError("Error handling message:", error);
    await next();
  }
});
