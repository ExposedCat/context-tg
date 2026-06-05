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
import {
  type LlmCitation,
  type LlmReport,
  LlmRequestError,
  type LlmRequestOptions,
  type LlmResponse,
  type LlmToolContext,
  requestLlm,
  type ToolName,
} from "./llm.ts";
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
  text?: string;
  caption?: string;
  quote?: {
    text: string;
  };
  reply_to_message?: TextMessage;
};

type BotReaction = "🤔";

const logError = createDebug("app:chat:error");

export const chatComposer = new Composer<Context>();

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
  return Boolean(resolveMessageAgent(text, ownUsername));
}

function buildRootRequest(text: string, replyText?: string): string {
  return replyText ? `${replyText}\n\n${text}` : text;
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
};

function formatToolUsageEmojis(tools: ToolName[]): string {
  const usedEmojiIds = new Set<string>();
  const emojis: string[] = [];

  for (const tool of tools) {
    const emoji = TOOL_USAGE_EMOJIS[tool];

    if (!emoji || usedEmojiIds.has(emoji.id)) {
      continue;
    }

    usedEmojiIds.add(emoji.id);
    emojis.push(
      `<tg-emoji emoji-id="${emoji.id}">${emoji.fallback}</tg-emoji>`,
    );
  }

  return emojis.join(" ");
}

function appendToolUsageEmojis(text: string, tools: ToolName[]): string {
  const suffix = formatToolUsageEmojis(tools);

  if (!suffix) {
    return text;
  }

  const trimmedText = text.trimEnd();
  return trimmedText ? `${trimmedText}\n\n${suffix}` : suffix;
}

function formatLlmResponse(llmResponse: LlmResponse): {
  text: string;
  parse_mode: "HTML";
} {
  const response = llmResponse.response ?? "";
  const text = hasSearchInfo(llmResponse)
    ? formatCitations(response, llmResponse.web_search.citations)
    : sanitizeLlmHtml(response);

  return {
    text: appendToolUsageEmojis(text, llmResponse.tools),
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
  const captionChunks = splitHtmlMessage(
    formattedResponse.text || "Report attached.",
    TELEGRAM_CAPTION_CHUNK_SIZE,
  );
  const sentMessages = [];

  try {
    await Deno.writeTextFile(tmpPath, report.documentHtml);

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
      logError("Failed to delete temporary report:", { tmpPath, error }),
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
  let imageUsageConsumed = false;
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
        return await withTypingAction(ctx, () => {
          const requestOptions: LlmRequestOptions = {
            context: toolContext,
            onProgress: async (progress) => {
              progressResponseId = progress.responseId ?? progressResponseId;
            },
            onWarning: (details: string) =>
              sendLlmWarning(ctx, message, details),
            signal: taskAbortController.signal,
          };

          return responseId
            ? requestLlm(
                buildThreadRequest(text, message.quote?.text),
                agentTools,
                responseId,
                requestOptions,
                agent.buildInstructions(),
                agent.MODEL,
              )
            : requestLlm(
                buildRootRequest(text, reply && getMessageText(reply)),
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

    if (llmResponse.report) {
      const imageUsage = await consumeUsage(
        ctx.database,
        chatId,
        "image_responses",
      );

      if (!imageUsage.ok) {
        throw new Error(
          formatQuotaExceededResponse("image_responses", imageUsage),
        );
      }

      imageUsageConsumed = true;
    }

    const sentMessages = llmResponse.report
      ? await sendReportResponse(
          ctx,
          message,
          llmResponse.report,
          formattedResponse,
        )
      : [];

    if (!llmResponse.report) {
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

      if (imageUsageConsumed) {
        await refundUsage(ctx.database, chatId, "image_responses");
      }
    }

    if (taskStatus === "canceled") {
      if (resumable) {
        await ctx.reply(
          `Canceled. Resume: ${getResumeCommand(message.message_id)}`,
          {
            ...linkPreviewOptions,
            reply_parameters: {
              message_id: message.message_id,
            },
          },
        );
      }
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

  if (!text || (!isAddressed(text, ctx.me.username) && !thread)) {
    await next();
    return;
  }

  await handleChatRequest(ctx, message, text, {
    reply,
    thread,
    threadId: repliedTask?.thread_id,
    onUnhandledError: next,
  });
});
