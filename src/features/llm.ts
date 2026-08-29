import { createDebug } from "@grammyjs/debug";
import type { Api } from "grammy";
import { throwIfAborted } from "../utils/async.ts";
import { escapeXmlAttribute } from "../utils/text.ts";
import {
  type AgentId,
  type AgentModel,
  getAgentById,
  normalAgent,
} from "./agents/index.ts";
import {
  CodexAppServerClient,
  type CodexNotification,
  CodexRpcError,
  type CodexServerRequest,
} from "./codex-app-server.ts";
import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";
import {
  getChatReasoningEffort,
  getReasoningEffort,
  type ReasoningSetting,
} from "./llm-models.ts";
import { formatPromptMessageXml } from "./llm-prompt.ts";
import {
  executeGetMessageContext,
  executeReadLastMessages,
  executeSearchChat,
  getMessageContextToolDefinition,
  readLastMessagesToolDefinition,
  searchChatToolDefinition,
} from "./llm-tools/chat.ts";
import * as gdeltTool from "./llm-tools/gdelt.ts";
import * as imageTool from "./llm-tools/image.ts";
import * as imageSearchTool from "./llm-tools/image-search.ts";
import * as marketTool from "./llm-tools/market.ts";
import * as memoTool from "./llm-tools/memos.ts";
import * as replyTool from "./llm-tools/reply.ts";
import type { LlmReport } from "./llm-tools/reports.ts";
import * as reportsTool from "./llm-tools/reports.ts";
import * as scheduleTool from "./llm-tools/schedule.ts";
import * as stickerTool from "./llm-tools/sticker.ts";
import type {
  FunctionToolResult,
  FunctionToolRunner,
  LlmImageInput,
  LlmSticker,
  LlmToolContext,
} from "./llm-tools/types.ts";
import * as webSearchTool from "./llm-tools/web-search.ts";
import * as youtubeTool from "./llm-tools/youtube.ts";
import { buildMemosMetadataSection } from "./memos.ts";

export type { LlmReport } from "./llm-tools/reports.ts";
export type {
  LlmImageInput,
  LlmSticker,
  LlmToolContext,
} from "./llm-tools/types.ts";

export const TOOL_DEFINITIONS = {
  web_search: webSearchTool.toolDefinition,
  read_web_page: webSearchTool.readPageToolDefinition,
  search_images: imageSearchTool.toolDefinition,
  read_image: imageSearchTool.readImageToolDefinition,
  get_markets_state: marketTool.toolDefinition,
  search_chat: searchChatToolDefinition,
  get_message_context: getMessageContextToolDefinition,
  read_last_messages: readLastMessagesToolDefinition,
  get_recent_news: gdeltTool.toolDefinition,
  read_youtube_video: youtubeTool.toolDefinition,
  generate_image: imageTool.toolDefinition,
  send_sticker: stickerTool.toolDefinition,
  set_reply_message_id: replyTool.toolDefinition,
  send_report: reportsTool.toolDefinition,
  send_trading_report: reportsTool.tradingToolDefinition,
  schedule_message: scheduleTool.scheduleMessageToolDefinition,
  cron_message: scheduleTool.cronMessageToolDefinition,
  get_scheduled_messages: scheduleTool.getScheduledMessagesToolDefinition,
  cancel_scheduled_message: scheduleTool.cancelScheduledMessageToolDefinition,
  remember: memoTool.saveMemoToolDefinition,
  forget: memoTool.forgetMemoToolDefinition,
} as const;

export type ToolName = keyof typeof TOOL_DEFINITIONS;

const FUNCTION_TOOL_RUNNERS = {
  web_search: webSearchTool.execute,
  read_web_page: webSearchTool.executeReadPage,
  search_images: imageSearchTool.execute,
  read_image: imageSearchTool.executeReadImage,
  get_markets_state: marketTool.execute,
  search_chat: executeSearchChat,
  get_message_context: executeGetMessageContext,
  read_last_messages: executeReadLastMessages,
  get_recent_news: gdeltTool.execute,
  read_youtube_video: youtubeTool.execute,
  generate_image: imageTool.execute,
  send_sticker: stickerTool.execute,
  set_reply_message_id: replyTool.execute,
  send_report: reportsTool.execute,
  send_trading_report: reportsTool.executeTrading,
  schedule_message: scheduleTool.executeScheduleMessage,
  cron_message: scheduleTool.executeCronMessage,
  get_scheduled_messages: scheduleTool.executeGetScheduledMessages,
  cancel_scheduled_message: scheduleTool.executeCancelScheduledMessage,
  remember: memoTool.executeSaveMemo,
  forget: memoTool.executeForgetMemo,
} satisfies Record<string, FunctionToolRunner>;

type FunctionToolName = keyof typeof FUNCTION_TOOL_RUNNERS;

export const DEFAULT_LLM_TOOLS = Object.keys(TOOL_DEFINITIONS) as ToolName[];

export type LlmProgress = {
  toolCallCount: number;
  responseId?: string;
};

export type LlmRequestOptions = {
  database?: Database;
  api?: Api;
  context?: LlmToolContext;
  agentId?: AgentId;
  onProgress?: (progress: LlmProgress) => void | Promise<void>;
  onWarning?: (details: string) => void | Promise<void>;
  signal?: AbortSignal;
};

export type LlmRequestMessageInput =
  | string
  | {
      text: string;
      images?: LlmImageInput[];
    };

export type LlmRequestInput = LlmRequestMessageInput | LlmRequestMessageInput[];

export type LlmCitation = {
  start_index: number;
  end_index: number;
  link: string;
};

export type LlmSource = {
  link: string;
};

export type LlmDebugToolCall = {
  name: string;
  input: unknown;
};

export type LlmDebugUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
};

export type LlmDebugModelResponse = {
  response_id?: string;
  deployment: string;
  requested_model: string;
  response_model?: string;
  reasoning_effort: ReasoningSetting;
  reasoning_sent: boolean;
  status?: string;
  incomplete_reason?: string;
  usage?: LlmDebugUsage;
};

export type LlmDebugInfo = {
  responses: LlmDebugModelResponse[];
  tool_calls: LlmDebugToolCall[];
};

export type LlmToolError = {
  tool: ToolName;
  details: string;
};

export type LlmResponse = {
  response_id?: string;
  response?: string;
  replyMessageId?: number | null;
  report?: LlmReport;
  generatedImageIds: string[];
  stickers: LlmSticker[];
  errors: LlmToolError[];
  web_search: {
    used: boolean;
    citations: LlmCitation[];
    sources: LlmSource[];
  };
  tools: ToolName[];
  tool_call_count: number;
  debug: LlmDebugInfo;
};

type FunctionToolDefinition =
  (typeof TOOL_DEFINITIONS)[keyof typeof TOOL_DEFINITIONS];

type CodexUserInput =
  | { type: "text"; text: string; text_elements: never[] }
  | {
      type: "image";
      url: string;
      detail?: "low" | "high" | "auto" | "original";
    };

type CodexThreadItem =
  | {
      type: "agentMessage";
      id: string;
      text: string;
      phase?: "commentary" | "final_answer" | null;
      delivery?: "async" | null;
    }
  | {
      type: string;
      id?: string;
      [key: string]: unknown;
    };

type CodexTurn = {
  id: string;
  items: CodexThreadItem[];
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: {
    message?: string;
    additionalDetails?: string | null;
    codexErrorInfo?: unknown;
  } | null;
};

type CodexThreadResponse = {
  thread: { id: string };
  model?: string;
};

type CodexTurnStartResponse = {
  turn: CodexTurn;
};

type CodexTokenUsage = {
  last?: {
    totalTokens?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
};

type LlmRuntimeSettings = {
  reasoning: ReasoningSetting;
};

type LlmRequestState = {
  threadId?: string;
  replyMessageId?: number | null;
  hasStickerSlot: boolean;
  report?: LlmReport;
  generatedImageIds: string[];
  stickers: LlmSticker[];
  errors: LlmToolError[];
  calledTools: Set<ToolName>;
  toolCallCount: number;
  usage?: LlmDebugUsage;
  debug: LlmDebugInfo;
};

type DynamicToolResult = {
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
  >;
  success: boolean;
};

const logDebug = createDebug("app:llm:debug");
const logError = createDebug("app:llm:error");
const MARKDOWN_TOOL_OUTPUTS = new Set<string>(["read_web_page"]);
const DUPLICATE_STICKER_RESPONSE = JSON.stringify({
  error: "Duplicate sticker",
  details: "You have already sent a sticker.",
});
const CODEX_RUNTIME_INSTRUCTIONS = [
  "This conversation is hosted for a Telegram bot.",
  "Use the supplied dynamic tools for external actions and information.",
  "Do not run shell commands, edit files, inspect the container, or ask for execution approval.",
].join("\n");

export class LlmRequestError extends Error {
  constructor(
    message: string,
    readonly details: string,
    readonly kind: "content_filter" | "error" = "error",
    readonly lastResponseId?: string,
  ) {
    super(message);
    this.name = "LlmRequestError";
  }
}

function getSystemInstructions(chatId?: number): string {
  if (chatId === undefined) {
    throw new Error("chatId is required to build system instructions");
  }

  return normalAgent.buildInstructions(chatId);
}

async function withMemoMetadata(
  instructions: string,
  options: LlmRequestOptions,
): Promise<string> {
  const database = options.database;
  const chatId = options.context?.chatId;
  const agentId = options.agentId ?? normalAgent.id;
  const agent = getAgentById(agentId);

  if (!database || chatId === undefined || agent?.usesMemory === false) {
    return instructions;
  }

  const memosSection = await buildMemosMetadataSection(
    database,
    chatId,
    agentId,
    options.context?.userId,
    options.context?.userName,
  );

  return memosSection ? `${instructions}\n\n${memosSection}` : instructions;
}

async function resolveRuntimeSettings(
  model: AgentModel,
  options: LlmRequestOptions,
): Promise<LlmRuntimeSettings> {
  const database = options.database;
  const chatId = options.context?.chatId;

  if (!database || chatId === undefined) {
    return { reasoning: getReasoningEffort() };
  }

  return {
    reasoning: await getChatReasoningEffort(database, chatId, model.id),
  };
}

function getConfiguredModelName(model: AgentModel): string | undefined {
  return APP_ENV.CODEX_MODEL || model.deploymentName || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFunctionToolName(tool: string): tool is FunctionToolName {
  return tool in FUNCTION_TOOL_RUNNERS;
}

function isPromptMessageXml(content: string): boolean {
  return /^\s*<message(?:\s|>)/.test(content);
}

function formatInputTextContent(content: string, fallback = ""): string {
  const text = content.trim() || fallback;

  return isPromptMessageXml(text)
    ? text
    : formatPromptMessageXml({ sender: "User" }, text);
}

function createCodexInput(request: LlmRequestInput): CodexUserInput[] {
  const requests = Array.isArray(request) ? request : [request];

  return requests.flatMap((item) => {
    if (typeof item === "string") {
      return [
        {
          type: "text" as const,
          text: formatInputTextContent(item),
          text_elements: [],
        },
      ];
    }

    const images = item.images ?? [];
    return [
      {
        type: "text" as const,
        text: formatInputTextContent(
          item.text,
          "Please respond to the attached image.",
        ),
        text_elements: [] as never[],
      },
      ...images.map((image) => ({
        type: "image" as const,
        url: image.image_url,
        detail: image.detail,
      })),
    ];
  });
}

function createDynamicTools(tools: ToolName[]) {
  return tools.map((tool) => {
    const definition: FunctionToolDefinition = TOOL_DEFINITIONS[tool];
    return {
      type: "function",
      name: definition.name,
      description: definition.description,
      inputSchema: definition.parameters,
    };
  });
}

function isJsonContent(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

function formatJsonToolResponseBody(output: string): string {
  if (!output) {
    return "null";
  }

  return isJsonContent(output) ? output : JSON.stringify({ result: output });
}

function formatToolResponseContent(tool: string, output: string): string {
  const attributes = [
    `tool="${escapeXmlAttribute(tool)}"`,
    ...(tool === "web_search" ? ['required_next_tool="read_web_page"'] : []),
    ...(tool === "search_images" ? ['required_next_tool="read_image"'] : []),
  ].join(" ");
  const body = MARKDOWN_TOOL_OUTPUTS.has(tool)
    ? output
    : formatJsonToolResponseBody(output);

  return [`<tool_response ${attributes}>`, body, "</tool_response>"].join("\n");
}

function normalizeFunctionToolResult(
  result: FunctionToolResult | string,
): FunctionToolResult {
  return typeof result === "string" ? { output: result } : result;
}

function getErrorDetail(error: unknown): string {
  if (error instanceof LlmRequestError) {
    return error.details;
  }

  if (error instanceof CodexRpcError) {
    const data =
      error.data === undefined ? "" : `: ${JSON.stringify(error.data)}`;
    return `${error.code}: ${error.message}${data}`;
  }

  return error instanceof Error ? error.message : String(error);
}

function isContentFilterError(error: unknown): boolean {
  return /content[_ -]?filter|policy[_ -]?violation|safety/i.test(
    getErrorDetail(error),
  );
}

function addStickerToState(
  state: LlmRequestState,
  sticker: LlmSticker,
  reservedStickerSlot = false,
): boolean {
  if (!reservedStickerSlot && state.hasStickerSlot) {
    return false;
  }

  state.hasStickerSlot = true;
  state.stickers.push(sticker);
  return true;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];

  for (let index = 0; index < bytes.length; index += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
  }

  return btoa(chunks.join(""));
}

async function getInlineImageUrl(
  image: LlmImageInput,
  signal?: AbortSignal,
): Promise<string> {
  if (image.image_url.startsWith("data:")) {
    return image.image_url;
  }

  const response = await fetch(image.image_url, { signal });
  if (!response.ok) {
    throw new Error(`Image download failed: HTTP ${response.status}`);
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Image download returned ${mimeType || "unknown content"}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

function applyToolResultToState(
  state: LlmRequestState,
  result: FunctionToolResult,
  reservedStickerSlot: boolean,
): void {
  if (result.report) {
    state.report = result.report;
  }
  if ("replyMessageId" in result) {
    state.replyMessageId = result.replyMessageId;
  }
  if (result.generatedImageId) {
    state.generatedImageIds.push(result.generatedImageId);
  }
  if (result.sticker) {
    addStickerToState(state, result.sticker, reservedStickerSlot);
  } else if (reservedStickerSlot) {
    state.hasStickerSlot = state.stickers.length > 0;
  }
  if (result.stickers) {
    for (const sticker of result.stickers) {
      if (!addStickerToState(state, sticker)) {
        break;
      }
    }
  }
}

async function runDynamicTool(
  tool: FunctionToolName,
  args: unknown,
  state: LlmRequestState,
  options: LlmRequestOptions,
): Promise<DynamicToolResult> {
  throwIfAborted(options.signal);
  state.calledTools.add(tool);
  state.toolCallCount += 1;
  state.debug.tool_calls.push({ name: tool, input: args });
  const reservedStickerSlot = tool === "send_sticker";

  if (reservedStickerSlot && state.hasStickerSlot) {
    return {
      contentItems: [
        {
          type: "inputText",
          text: formatToolResponseContent(tool, DUPLICATE_STICKER_RESPONSE),
        },
      ],
      success: true,
    };
  }

  if (reservedStickerSlot) {
    state.hasStickerSlot = true;
  }

  try {
    const result = normalizeFunctionToolResult(
      await FUNCTION_TOOL_RUNNERS[tool](
        isRecord(args) ? args : null,
        options.context,
        {
          signal: options.signal,
          database: options.database,
          agentId: options.agentId ?? normalAgent.id,
          api: options.api,
        },
      ),
    );
    throwIfAborted(options.signal);
    const inputImages = await Promise.all(
      (result.inputImages ?? []).map((image) =>
        getInlineImageUrl(image, options.signal),
      ),
    );
    applyToolResultToState(state, result, reservedStickerSlot);

    return {
      contentItems: [
        {
          type: "inputText",
          text: formatToolResponseContent(tool, result.output),
        },
        ...inputImages.map((imageUrl) => ({
          type: "inputImage" as const,
          imageUrl,
        })),
      ],
      success: true,
    };
  } catch (error) {
    throwIfAborted(options.signal);
    const details = getErrorDetail(error);
    state.errors.push({ tool, details });
    if (reservedStickerSlot) {
      state.hasStickerSlot = state.stickers.length > 0;
    }
    logError("Dynamic tool call failed", { tool, args, error });

    return {
      contentItems: [
        {
          type: "inputText",
          text: formatToolResponseContent(
            tool,
            JSON.stringify({ error: "Tool call failed", tool, details }),
          ),
        },
      ],
      success: false,
    };
  }
}

function getDynamicToolParams(params: unknown):
  | {
      tool: string;
      arguments: unknown;
    }
  | undefined {
  if (!isRecord(params) || typeof params.tool !== "string") {
    return undefined;
  }

  return { tool: params.tool, arguments: params.arguments };
}

async function handleCodexServerRequest(
  request: CodexServerRequest,
  state: LlmRequestState,
  options: LlmRequestOptions,
): Promise<unknown> {
  if (request.method === "item/tool/call") {
    const params = getDynamicToolParams(request.params);
    if (!params || !isFunctionToolName(params.tool)) {
      return {
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({ error: "Unsupported dynamic tool" }),
          },
        ],
        success: false,
      };
    }

    const result = await runDynamicTool(
      params.tool,
      params.arguments,
      state,
      options,
    );
    await options.onProgress?.({
      toolCallCount: state.toolCallCount,
      responseId: state.threadId,
    });
    return result;
  }

  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval"
  ) {
    return { decision: "decline" };
  }

  if (request.method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }

  if (request.method === "item/tool/requestUserInput") {
    return { answers: {} };
  }

  throw new CodexRpcError(
    -32601,
    `Unsupported Codex server request: ${request.method}`,
  );
}

function getNotificationParams(
  notification: CodexNotification,
): Record<string, unknown> | undefined {
  return isRecord(notification.params) ? notification.params : undefined;
}

function getCompletedTurn(
  notification: CodexNotification,
): CodexTurn | undefined {
  if (notification.method !== "turn/completed") {
    return undefined;
  }

  const params = getNotificationParams(notification);
  const turn = params?.turn;
  return isRecord(turn) && typeof turn.id === "string"
    ? (turn as unknown as CodexTurn)
    : undefined;
}

function updateUsageFromNotification(
  notification: CodexNotification,
  state: LlmRequestState,
): void {
  if (notification.method !== "thread/tokenUsage/updated") {
    return;
  }

  const params = getNotificationParams(notification);
  const tokenUsage = params?.tokenUsage as CodexTokenUsage | undefined;
  const usage = tokenUsage?.last;

  if (!usage) {
    return;
  }

  state.usage = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    cached_tokens: usage.cachedInputTokens,
    reasoning_tokens: usage.reasoningOutputTokens,
  };
}

function isCodexThreadId(value: string | null | undefined): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      ),
  );
}

function isMissingThreadError(error: unknown): boolean {
  return (
    error instanceof CodexRpcError &&
    /not found|unknown thread|missing thread|no rollout|rollout.*missing/i.test(
      error.message,
    )
  );
}

function getThreadConfig(): Record<string, unknown> {
  return {
    web_search: "disabled",
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "features.image_generation": false,
    "features.shell_tool": false,
    "features.unified_exec": false,
  };
}

async function startCodexThread(
  client: CodexAppServerClient,
  tools: ToolName[],
  instructions: string,
  modelName: string | undefined,
): Promise<CodexThreadResponse> {
  return await client.request<CodexThreadResponse>("thread/start", {
    ...(modelName ? { model: modelName } : {}),
    cwd: "/workspace",
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions: `${instructions}\n\n${CODEX_RUNTIME_INSTRUCTIONS}`,
    ephemeral: false,
    historyMode: "paginated",
    environments: [],
    dynamicTools: createDynamicTools(tools),
    config: getThreadConfig(),
  });
}

async function startOrResumeCodexThread(
  client: CodexAppServerClient,
  responseId: string | null | undefined,
  tools: ToolName[],
  instructions: string,
  modelName: string | undefined,
): Promise<CodexThreadResponse> {
  if (!isCodexThreadId(responseId)) {
    return await startCodexThread(client, tools, instructions, modelName);
  }

  try {
    return await client.request<CodexThreadResponse>("thread/resume", {
      threadId: responseId,
      ...(modelName ? { model: modelName } : {}),
      cwd: "/workspace",
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: `${instructions}\n\n${CODEX_RUNTIME_INSTRUCTIONS}`,
      excludeTurns: true,
      config: getThreadConfig(),
    });
  } catch (error) {
    if (!isMissingThreadError(error)) {
      throw error;
    }

    logError("Persisted Codex thread is unavailable; starting a new thread", {
      responseId,
      error,
    });
    return await startCodexThread(client, tools, instructions, modelName);
  }
}

function getFinalResponseText(turn: CodexTurn): string | undefined {
  const messages = turn.items.filter(
    (item): item is Extract<CodexThreadItem, { type: "agentMessage" }> =>
      item.type === "agentMessage" &&
      typeof item.text === "string" &&
      item.delivery !== "async",
  );
  const finalMessage =
    messages.findLast((message) => message.phase === "final_answer") ??
    messages.findLast((message) => message.phase !== "commentary");

  return finalMessage?.text || undefined;
}

function getTurnFailureDetails(turn: CodexTurn): string | undefined {
  if (turn.status === "completed") {
    return undefined;
  }

  return (
    turn.error?.additionalDetails ||
    turn.error?.message ||
    `turn status: ${turn.status}`
  );
}

async function waitForTurn(
  turnId: string,
  completedTurns: Map<string, CodexTurn>,
  waiters: Map<string, (turn: CodexTurn) => void>,
  signal?: AbortSignal,
): Promise<CodexTurn> {
  const completed = completedTurns.get(turnId);
  if (completed) {
    completedTurns.delete(turnId);
    return completed;
  }

  return await new Promise<CodexTurn>((resolve, reject) => {
    const abort = () => {
      waiters.delete(turnId);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    const finish = (turn: CodexTurn) => {
      signal?.removeEventListener("abort", abort);
      resolve(turn);
    };

    waiters.set(turnId, finish);
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
  });
}

async function interruptTurn(
  client: CodexAppServerClient,
  threadId: string | undefined,
  turnId: string | undefined,
): Promise<void> {
  if (!threadId || !turnId) {
    return;
  }

  try {
    await client.request("turn/interrupt", { threadId, turnId });
  } catch (error) {
    logError("Failed to interrupt Codex turn", { threadId, turnId, error });
  }
}

async function requestLlmWithInstructions(
  request: LlmRequestInput,
  tools: ToolName[],
  responseId?: string | null,
  options: LlmRequestOptions = {},
  instructions = getSystemInstructions(options.context?.chatId),
  model: AgentModel = normalAgent.MODEL,
): Promise<LlmResponse> {
  throwIfAborted(options.signal);
  const settings = await resolveRuntimeSettings(model, options);
  const runtimeInstructions = await withMemoMetadata(instructions, options);
  const modelName = getConfiguredModelName(model);
  const state: LlmRequestState = {
    hasStickerSlot: false,
    generatedImageIds: [],
    stickers: [],
    errors: [],
    calledTools: new Set(),
    toolCallCount: 0,
    debug: { responses: [], tool_calls: [] },
  };
  const completedTurns = new Map<string, CodexTurn>();
  const turnWaiters = new Map<string, (turn: CodexTurn) => void>();
  let activeTurnId: string | undefined;
  let responseModel: string | undefined;
  const client = new CodexAppServerClient({
    url: APP_ENV.CODEX_APP_SERVER_URL,
    token: APP_ENV.CODEX_APP_SERVER_TOKEN,
    onServerRequest: (serverRequest) =>
      handleCodexServerRequest(serverRequest, state, options),
    onNotification: (notification) => {
      updateUsageFromNotification(notification, state);
      const turn = getCompletedTurn(notification);
      if (!turn) {
        return;
      }

      const waiter = turnWaiters.get(turn.id);
      if (waiter) {
        turnWaiters.delete(turn.id);
        waiter(turn);
      } else {
        completedTurns.set(turn.id, turn);
      }
    },
  });

  try {
    logDebug("Connecting to Codex app-server", { tools, responseId, model });
    await client.connect();
    await client.request("initialize", {
      clientInfo: {
        name: "context_tg",
        title: "Context Telegram Bot",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
          "item/commandExecution/outputDelta",
        ],
      },
    });
    await client.notify("initialized");

    const thread = await startOrResumeCodexThread(
      client,
      responseId,
      tools,
      runtimeInstructions,
      modelName,
    );
    state.threadId = thread.thread.id;
    responseModel = thread.model;
    await options.onProgress?.({
      toolCallCount: state.toolCallCount,
      responseId: state.threadId,
    });

    const turnStart = await client.request<CodexTurnStartResponse>(
      "turn/start",
      {
        threadId: state.threadId,
        input: createCodexInput(request),
        ...(modelName ? { model: modelName } : {}),
        ...(settings.reasoning !== null ? { effort: settings.reasoning } : {}),
      },
    );
    activeTurnId = turnStart.turn.id;
    const turn =
      turnStart.turn.status === "inProgress"
        ? await waitForTurn(
            activeTurnId,
            completedTurns,
            turnWaiters,
            options.signal,
          )
        : turnStart.turn;
    throwIfAborted(options.signal);

    const failureDetails = getTurnFailureDetails(turn);
    if (failureDetails) {
      throw new LlmRequestError(
        "Codex turn did not complete",
        failureDetails,
        isContentFilterError(failureDetails) ? "content_filter" : "error",
        state.threadId,
      );
    }

    const responseText = getFinalResponseText(turn);
    if (!responseText) {
      throw new LlmRequestError(
        "Codex response was empty",
        "empty response",
        "error",
        state.threadId,
      );
    }

    state.debug.responses.push({
      response_id: state.threadId,
      deployment: model.id,
      requested_model: modelName ?? "codex-default",
      response_model: responseModel,
      reasoning_effort: settings.reasoning,
      reasoning_sent: model.withReasoning && settings.reasoning !== null,
      status: turn.status,
      usage: state.usage,
    });
    logDebug("Received Codex response", {
      threadId: state.threadId,
      turnId: turn.id,
      tools: [...state.calledTools],
      responseLength: responseText.length,
    });

    return {
      response_id: state.threadId,
      response: responseText,
      replyMessageId: state.replyMessageId,
      report: state.report,
      generatedImageIds: state.generatedImageIds,
      stickers: state.stickers,
      errors: state.errors,
      web_search: {
        used: state.calledTools.has("web_search"),
        citations: [],
        sources: [],
      },
      tools: [...state.calledTools],
      tool_call_count: state.toolCallCount,
      debug: state.debug,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      await interruptTurn(client, state.threadId, activeTurnId);
      throwIfAborted(options.signal);
    }

    if (error instanceof LlmRequestError) {
      if (error.kind === "content_filter") {
        await options.onWarning?.(error.details);
      }
      throw error;
    }

    const details = getErrorDetail(error);
    const kind = isContentFilterError(error) ? "content_filter" : "error";
    if (kind === "content_filter") {
      await options.onWarning?.(details);
    }
    throw new LlmRequestError(
      "Codex request failed",
      details,
      kind,
      state.threadId,
    );
  } finally {
    client.close();
  }
}

export async function requestLlm(
  request: LlmRequestInput,
  tools: ToolName[],
  responseId?: string | null,
  options: LlmRequestOptions = {},
  instructions = getSystemInstructions(options.context?.chatId),
  model: AgentModel = normalAgent.MODEL,
): Promise<LlmResponse> {
  return await requestLlmWithInstructions(
    request,
    tools,
    responseId,
    options,
    instructions,
    model,
  );
}
