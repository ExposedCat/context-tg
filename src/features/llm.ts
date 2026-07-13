import { createDebug } from "@grammyjs/debug";
import OpenAI from "@openai/openai";
import { delay, throwIfAborted } from "../utils/async.ts";
import {
  type AgentId,
  type AgentModel,
  getAgentById,
  getCallableAgentById,
  normalAgent,
} from "./agents/index.ts";
import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";
import {
  getLlmChatResponseMessages,
  saveLlmChatResponseMessages,
} from "./llm-chat-responses.ts";
import {
  getChatReasoningEffort,
  getReasoningEffort,
  type ReasoningSetting,
} from "./llm-models.ts";
import * as agentTool from "./llm-tools/agent.ts";
import {
  executeReadLastMessages,
  executeSearchChat,
  readLastMessagesToolDefinition,
  searchChatToolDefinition,
} from "./llm-tools/chat.ts";
import * as gdeltTool from "./llm-tools/gdelt.ts";
import * as imageTool from "./llm-tools/image.ts";
import * as marketTool from "./llm-tools/market.ts";
import * as memoTool from "./llm-tools/memos.ts";
import type { LlmReport } from "./llm-tools/reports.ts";
import * as reportsTool from "./llm-tools/reports.ts";
import * as scheduleTool from "./llm-tools/schedule.ts";
import * as stickerTool from "./llm-tools/sticker.ts";
import type {
  FunctionToolResult,
  FunctionToolRunner,
  LlmGeneratedImage,
  LlmSticker,
  LlmToolContext,
} from "./llm-tools/types.ts";
import * as webSearchTool from "./llm-tools/web-search.ts";
import * as youtubeTool from "./llm-tools/youtube.ts";
import { buildMemosMetadataSection } from "./memos.ts";

export type { LlmReport } from "./llm-tools/reports.ts";
export type {
  LlmGeneratedImage,
  LlmSticker,
  LlmToolContext,
} from "./llm-tools/types.ts";

export const TOOL_DEFINITIONS = {
  web_search: webSearchTool.toolDefinition,
  read_web_page: webSearchTool.readPageToolDefinition,
  get_markets_state: marketTool.toolDefinition,
  search_chat: searchChatToolDefinition,
  read_last_messages: readLastMessagesToolDefinition,
  get_recent_news: gdeltTool.toolDefinition,
  read_youtube_video: youtubeTool.toolDefinition,
  generate_image: imageTool.toolDefinition,
  generate_image_nsfw: imageTool.nsfwToolDefinition,
  send_sticker: stickerTool.toolDefinition,
  send_report: reportsTool.toolDefinition,
  send_trading_report: reportsTool.tradingToolDefinition,
  call_agent: agentTool.toolDefinition,
  schedule_message: scheduleTool.scheduleMessageToolDefinition,
  cron_message: scheduleTool.cronMessageToolDefinition,
  remember: memoTool.saveMemoToolDefinition,
  forget: memoTool.forgetMemoToolDefinition,
} as const;

export type ToolName = keyof typeof TOOL_DEFINITIONS;

const FUNCTION_TOOL_RUNNERS = {
  web_search: webSearchTool.execute,
  read_web_page: webSearchTool.executeReadPage,
  get_markets_state: marketTool.execute,
  search_chat: executeSearchChat,
  read_last_messages: executeReadLastMessages,
  get_recent_news: gdeltTool.execute,
  read_youtube_video: youtubeTool.execute,
  generate_image: imageTool.execute,
  generate_image_nsfw: imageTool.executeNsfw,
  send_sticker: stickerTool.execute,
  send_report: reportsTool.execute,
  send_trading_report: reportsTool.executeTrading,
  call_agent: agentTool.createRunner(runAgent),
  schedule_message: scheduleTool.executeScheduleMessage,
  cron_message: scheduleTool.executeCronMessage,
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
  context?: LlmToolContext;
  agentId?: AgentId;
  onProgress?: (progress: LlmProgress) => void | Promise<void>;
  onWarning?: (details: string) => void | Promise<void>;
  signal?: AbortSignal;
};

export type LlmImageInput = {
  image_url: string;
  detail?: "low" | "high" | "auto" | "original";
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
  prompt_tokens?: number;
  completion_tokens?: number;
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
  finish_reason?: string | null;
  usage?: LlmDebugUsage;
};

export type LlmDebugInfo = {
  responses: LlmDebugModelResponse[];
  tool_calls: LlmDebugToolCall[];
};

export type LlmResponse = {
  response_id?: string;
  handoff_agent_id?: AgentId;
  response?: string;
  report?: LlmReport;
  images: LlmGeneratedImage[];
  stickers: LlmSticker[];
  errors: string[];
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

type ChatCompletionAssistantMessageParam =
  OpenAI.Chat.ChatCompletionAssistantMessageParam;
type ChatCompletionContentPartImage =
  OpenAI.Chat.ChatCompletionContentPartImage;
type ChatCompletionMessageParam = OpenAI.Chat.ChatCompletionMessageParam;
type ChatCompletionMessageToolCall = OpenAI.Chat.ChatCompletionMessageToolCall;
type ChatCompletionTool = OpenAI.Chat.ChatCompletionTool;
type ChatCompletionToolMessageParam =
  OpenAI.Chat.ChatCompletionToolMessageParam;
type ChatUrlCitationAnnotation = {
  url_citation: {
    start_index: number;
    end_index: number;
    url: string;
  };
};

type ApiResponse = OpenAI.Chat.ChatCompletion;

type FunctionToolCall = ChatCompletionMessageToolCall & {
  type: "function";
  function: {
    name: FunctionToolName;
    arguments: string;
  };
};

type FunctionCallOutput = ChatCompletionToolMessageParam;

type LlmApiInput = ChatCompletionMessageParam[];

type FunctionToolCallResult = {
  toolOutput: FunctionCallOutput;
  handoffAgentId?: AgentId;
};

type LlmRuntimeSettings = {
  reasoning: ReasoningSetting;
};

const logDebug = createDebug("app:llm:debug");
const logError = createDebug("app:llm:error");
const MAX_LLM_RETRIES = 10;
const LLM_RATE_LIMIT_RETRY_DELAY_MS = 3000;
const LLM_RATE_LIMIT_MAX_RETRIES = 5;
const MAX_FUNCTION_TOOL_ROUNDS = 4;
const DUPLICATE_STICKER_RESPONSE = "You have already sent a sticker";
const RETRIABLE_EMPTY_RESPONSE_DETAILS = new Set([
  "empty response",
  "missing choice",
]);

type LlmRequestState = {
  lastResponseId?: string;
  messages: ChatCompletionMessageParam[];
  handoffAgentId?: AgentId;
  receivedResponse: boolean;
  sentImmediateContentFilterWarning: boolean;
  hasStickerSlot: boolean;
  report?: LlmReport;
  images: LlmGeneratedImage[];
  stickers: LlmSticker[];
  errors: string[];
  debug: LlmDebugInfo;
};

function getSystemInstructions(): string {
  return normalAgent.buildInstructions();
}

async function withMemoMetadata(
  instructions: string,
  options: LlmRequestOptions,
): Promise<string> {
  const database = options.database;
  const chatId = options.context?.chatId;
  const agentId = options.agentId ?? normalAgent.id;
  const agent = getAgentById(agentId);

  if (!database || chatId === undefined) {
    return instructions;
  }

  if (agent?.usesMemory === false) {
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

function getClient(): OpenAI {
  return new OpenAI({
    apiKey: APP_ENV.LLM_API_KEY,
    baseURL: APP_ENV.LLM_BASE_URL,
  });
}

function getConfiguredDeploymentName(model: AgentModel): string {
  if (model.deploymentName) {
    return model.deploymentName;
  }

  throw new Error(
    `LLM model "${model.id}" is not configured. Admin must run /model ${model.id} DEPLOYMENT_NAME.`,
  );
}

async function resolveRuntimeSettings(
  model: AgentModel,
  options: LlmRequestOptions,
): Promise<LlmRuntimeSettings> {
  const database = options.database;
  const chatId = options.context?.chatId;

  if (!database || chatId === undefined) {
    return {
      reasoning: getReasoningEffort(),
    };
  }

  return {
    reasoning: await getChatReasoningEffort(database, chatId, model.id),
  };
}

function getToolDefinitions(tools: ToolName[]): ChatCompletionTool[] {
  const definitions: ChatCompletionTool[] = [];

  for (const tool of tools) {
    definitions.push(createChatFunctionToolDefinition(TOOL_DEFINITIONS[tool]));
  }

  return definitions;
}

function createChatFunctionToolDefinition(
  definition: FunctionToolDefinition,
): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      strict: definition.strict,
    },
  };
}

function isFunctionToolName(tool: string): tool is FunctionToolName {
  return tool in FUNCTION_TOOL_RUNNERS;
}

function isFunctionToolCall(
  call: ChatCompletionMessageToolCall,
): call is FunctionToolCall {
  return (
    call.type === "function" &&
    typeof call.id === "string" &&
    typeof call.function.name === "string" &&
    isFunctionToolName(call.function.name) &&
    typeof call.function.arguments === "string"
  );
}

function getResponseChoice(response: ApiResponse) {
  return response.choices[0];
}

function getResponseMessage(response: ApiResponse) {
  return getResponseChoice(response)?.message;
}

function getResponseText(response: ApiResponse): string | undefined {
  const content = getResponseMessage(response)?.content;
  return typeof content === "string" && content ? content : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getToolCallName(call: ChatCompletionMessageToolCall): string {
  return call.type === "function" ? call.function.name : call.custom.name;
}

function getCitations(response: ApiResponse): LlmCitation[] {
  return (
    (getResponseMessage(response)?.annotations ??
      []) as ChatUrlCitationAnnotation[]
  ).map((annotation) => ({
    start_index: annotation.url_citation.start_index,
    end_index: annotation.url_citation.end_index,
    link: annotation.url_citation.url,
  }));
}

function getWebSearchSourceLinks(response: ApiResponse): string[] {
  return getCitations(response).map((citation) => citation.link);
}

function getCalledTools(response: ApiResponse): ToolName[] {
  const calledTools = new Set<ToolName>();

  if (getCitations(response).length > 0) {
    calledTools.add("web_search");
  }

  for (const call of getFunctionToolCalls(response)) {
    calledTools.add(call.function.name);
  }

  return [...calledTools];
}

function getUnsupportedToolCallNames(response: ApiResponse): string[] {
  const names: string[] = [];

  for (const call of getResponseMessage(response)?.tool_calls ?? []) {
    if (!isFunctionToolCall(call)) {
      names.push(getToolCallName(call));
    }
  }

  return names;
}

function getToolCallCount(response: ApiResponse): number {
  return (
    getFunctionToolCalls(response).length +
    (getCitations(response).length > 0 ? 1 : 0)
  );
}

function createInputMessage(
  request: LlmRequestMessageInput,
): ChatCompletionMessageParam {
  if (typeof request === "string") {
    return { role: "user", content: request };
  }

  const images = request.images ?? [];
  if (images.length === 0) {
    return { role: "user", content: request.text };
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: request.text.trim() || "Please respond to the attached image.",
      },
      ...images.map(createImageContentPart),
    ],
  };
}

function createInputMessages(request: LlmRequestInput): LlmApiInput {
  return (Array.isArray(request) ? request : [request]).map(createInputMessage);
}

function getFunctionToolCalls(response: ApiResponse): FunctionToolCall[] {
  return (getResponseMessage(response)?.tool_calls ?? []).filter(
    isFunctionToolCall,
  );
}

function createImageContentPart(
  image: LlmImageInput,
): ChatCompletionContentPartImage {
  return {
    type: "image_url",
    image_url: {
      url: image.image_url,
      detail: image.detail === "original" ? "high" : (image.detail ?? "auto"),
    },
  };
}

function parseJsonObject(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function createDebugToolCall(call: FunctionToolCall): LlmDebugToolCall {
  return {
    name: call.function.name,
    input: parseJsonObject(call.function.arguments) ?? call.function.arguments,
  };
}

function getNumberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function getResponseUsage(response: ApiResponse): LlmDebugUsage | undefined {
  const usage = (response as unknown as { usage?: unknown }).usage;

  if (!isRecord(usage)) {
    return undefined;
  }

  const promptDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const debugUsage: LlmDebugUsage = {
    prompt_tokens: getNumberValue(usage.prompt_tokens),
    completion_tokens: getNumberValue(usage.completion_tokens),
    total_tokens: getNumberValue(usage.total_tokens),
    cached_tokens: getNumberValue(promptDetails.cached_tokens),
    reasoning_tokens: getNumberValue(completionDetails.reasoning_tokens),
  };

  return Object.values(debugUsage).some((value) => value !== undefined)
    ? debugUsage
    : undefined;
}

function createDebugModelResponse(
  response: ApiResponse,
  model: AgentModel,
  settings: LlmRuntimeSettings,
): LlmDebugModelResponse {
  return {
    response_id: response.id || undefined,
    deployment: model.id,
    requested_model: getConfiguredDeploymentName(model),
    response_model: response.model || undefined,
    reasoning_effort: settings.reasoning,
    reasoning_sent: model.withReasoning && settings.reasoning !== null,
    finish_reason: getResponseChoice(response)?.finish_reason,
    usage: getResponseUsage(response),
  };
}

function recordResponseDebug(
  response: ApiResponse,
  state: LlmRequestState,
  model: AgentModel,
  settings: LlmRuntimeSettings,
) {
  state.debug.responses.push(
    createDebugModelResponse(response, model, settings),
  );
  state.debug.tool_calls.push(
    ...getFunctionToolCalls(response).map(createDebugToolCall),
  );
}

function formatToolCallLog(call: FunctionToolCall): Record<string, unknown> {
  return {
    callId: call.id,
    name: call.function.name,
    arguments:
      parseJsonObject(call.function.arguments) ?? call.function.arguments,
  };
}

function formatResponseSummary(response: ApiResponse): Record<string, unknown> {
  const choice = getResponseChoice(response);

  return {
    id: response.id,
    finishReason: choice?.finish_reason,
    outputTextLength: getResponseText(response)?.length ?? 0,
    functionCalls: getFunctionToolCalls(response).map(formatToolCallLog),
    tools: getCalledTools(response),
    citations: getCitations(response).length,
  };
}

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

function getErrorObject(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  return error as Record<string, unknown>;
}

function isRateLimitError(error: unknown): boolean {
  const errorObject = getErrorObject(error);
  const apiError = getErrorObject(errorObject?.error);
  const values = [
    error instanceof Error ? error.message : undefined,
    errorObject?.code,
    errorObject?.type,
    apiError?.code,
    apiError?.type,
    apiError?.message,
  ];

  return (
    errorObject?.status === 429 ||
    values.some(
      (value) =>
        typeof value === "string" &&
        /rate[_ -]?limit|too_many_requests/i.test(value),
    )
  );
}

function getErrorDetail(error: unknown): string {
  if (error instanceof LlmRequestError) {
    return error.details;
  }

  const errorObject = getErrorObject(error);
  const apiError = getErrorObject(errorObject?.error);
  const parts = [
    typeof errorObject?.status === "number"
      ? `status ${errorObject.status}`
      : undefined,
    typeof errorObject?.code === "string" ? errorObject.code : undefined,
    typeof errorObject?.type === "string" ? errorObject.type : undefined,
    typeof apiError?.code === "string" ? apiError.code : undefined,
    typeof apiError?.message === "string" ? apiError.message : undefined,
    error instanceof Error ? error.message : undefined,
  ].filter((part): part is string => Boolean(part));

  return [...new Set(parts)].join(": ") || String(error);
}

function isContentFilterError(error: unknown): boolean {
  if (error instanceof LlmRequestError) {
    return error.kind === "content_filter";
  }

  const errorObject = getErrorObject(error);
  const apiError = getErrorObject(errorObject?.error);
  const values = [
    error instanceof Error ? error.name : undefined,
    error instanceof Error ? error.message : undefined,
    errorObject?.code,
    errorObject?.type,
    apiError?.code,
    apiError?.type,
    apiError?.message,
  ];

  return values.some(
    (value) =>
      typeof value === "string" &&
      /content[_ -]?filter|content_filter|policy_violation/i.test(value),
  );
}

function getResponseError(response: ApiResponse): LlmRequestError | undefined {
  const choice = getResponseChoice(response);

  if (!choice) {
    return new LlmRequestError("LLM response was empty", "missing choice");
  }

  if (choice.finish_reason === "content_filter") {
    return new LlmRequestError(
      "LLM response was blocked by content filtering",
      "content_filter",
      "content_filter",
    );
  }

  const unsupportedToolCalls = getUnsupportedToolCallNames(response);

  if (unsupportedToolCalls.length > 0) {
    return new LlmRequestError(
      "LLM requested an unsupported tool",
      `unsupported tool call: ${unsupportedToolCalls.join(", ")}`,
    );
  }

  if (
    !getResponseText(response) &&
    getFunctionToolCalls(response).length === 0
  ) {
    return new LlmRequestError("LLM response was empty", "empty response");
  }

  return undefined;
}

function isEmptyResponseError(error: unknown): boolean {
  return (
    error instanceof LlmRequestError &&
    RETRIABLE_EMPTY_RESPONSE_DETAILS.has(error.details)
  );
}

function createToolOutput(
  call: FunctionToolCall,
  output: string,
): FunctionCallOutput {
  logDebug("Tool call response", {
    callId: call.id,
    name: call.function.name,
    output,
  });

  return {
    role: "tool",
    tool_call_id: call.id,
    content: output,
  };
}

function normalizeFunctionToolResult(
  result: FunctionToolResult | string,
): FunctionToolResult {
  return typeof result === "string" ? { output: result } : result;
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

async function runFunctionToolCall(
  client: OpenAI,
  call: FunctionToolCall,
  state: LlmRequestState,
  context?: LlmToolContext,
  database?: Database,
  signal?: AbortSignal,
  agentId: AgentId = normalAgent.id,
): Promise<FunctionToolCallResult> {
  throwIfAborted(signal);
  const args = parseJsonObject(call.function.arguments);
  logDebug("Running tool call", formatToolCallLog(call));
  const runner = FUNCTION_TOOL_RUNNERS[call.function.name];
  const reservedStickerSlot = call.function.name === "send_sticker";

  if (reservedStickerSlot) {
    if (state.hasStickerSlot) {
      return {
        toolOutput: createToolOutput(call, DUPLICATE_STICKER_RESPONSE),
      };
    }

    state.hasStickerSlot = true;
  }

  let result: FunctionToolResult;
  try {
    result = normalizeFunctionToolResult(
      await runner(args, context, { signal, database, agentId, client }),
    );
    throwIfAborted(signal);
  } catch (error) {
    throwIfAborted(signal);
    const details = getErrorDetail(error);
    const message = `Tool ${call.function.name} failed: ${details}`;
    state.errors.push(message);
    if (reservedStickerSlot) {
      state.hasStickerSlot = state.stickers.length > 0;
    }
    logError("Function tool call failed", {
      call: formatToolCallLog(call),
      error,
    });

    return {
      toolOutput: createToolOutput(
        call,
        JSON.stringify({
          error: "Tool call failed",
          tool: call.function.name,
          details,
        }),
      ),
    };
  }

  if (result.report) {
    state.report = result.report;
  }

  if (result.image) {
    state.images.push(result.image);
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

  return {
    toolOutput: createToolOutput(call, result.output),
    handoffAgentId: result.handoffAgentId,
  };
}

const chatResponseMessageCache = new Map<
  string,
  ChatCompletionMessageParam[]
>();

function cloneChatMessages(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  return JSON.parse(JSON.stringify(messages)) as ChatCompletionMessageParam[];
}

function getLocalResponseId(response: ApiResponse): string {
  return response.id || `chatcmpl-local-${crypto.randomUUID()}`;
}

function createInterruptedToolOutput(
  toolCallId: string,
): ChatCompletionToolMessageParam {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: "Tool execution was interrupted before a result was available.",
  };
}

function createSkippedToolOutput(
  call: FunctionToolCall,
): ChatCompletionToolMessageParam {
  return {
    role: "tool",
    tool_call_id: call.id,
    content:
      "Tool execution was skipped because the maximum tool round limit was reached. Produce the final answer from the available context and mention any important missing data.",
  };
}

function closePendingToolCalls(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  const pendingToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        pendingToolCallIds.add(call.id);
      }
      continue;
    }

    if (message.role === "tool") {
      pendingToolCallIds.delete(message.tool_call_id);
    }
  }

  if (pendingToolCallIds.size === 0) {
    return messages;
  }

  return [
    ...messages,
    ...[...pendingToolCallIds].map(createInterruptedToolOutput),
  ];
}

async function loadPreviousChatMessages(
  responseId: string | undefined,
  options: LlmRequestOptions,
): Promise<ChatCompletionMessageParam[]> {
  if (!responseId) {
    return [];
  }

  const cachedMessages = chatResponseMessageCache.get(responseId);
  if (cachedMessages) {
    return closePendingToolCalls(cloneChatMessages(cachedMessages));
  }

  if (!options.database) {
    logDebug("No database available for chat response history", { responseId });
    return [];
  }

  const messages = await getLlmChatResponseMessages(
    options.database,
    responseId,
  );

  if (!messages) {
    logDebug("No persisted chat response history found", { responseId });
    return [];
  }

  chatResponseMessageCache.set(responseId, cloneChatMessages(messages));
  return closePendingToolCalls(messages);
}

async function saveChatResponseMessages(
  responseId: string,
  previousResponseId: string | undefined,
  messages: ChatCompletionMessageParam[],
  options: LlmRequestOptions,
): Promise<void> {
  const savedMessages = cloneChatMessages(messages);
  chatResponseMessageCache.set(responseId, savedMessages);

  if (!options.database) {
    return;
  }

  try {
    await saveLlmChatResponseMessages(options.database, {
      responseId,
      previousResponseId,
      messages: savedMessages,
    });
  } catch (error) {
    logError("Failed to save chat response history", { responseId, error });
  }
}

function createAssistantHistoryMessage(
  response: ApiResponse,
): ChatCompletionAssistantMessageParam {
  const message = getResponseMessage(response);
  const historyMessage: ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content: message?.content ?? null,
  };

  if (message?.tool_calls?.length) {
    historyMessage.tool_calls = message.tool_calls;
  }

  if (message?.refusal) {
    historyMessage.refusal = message.refusal;
  }

  return historyMessage;
}

async function recordChatResponse(
  response: ApiResponse,
  input: LlmApiInput,
  state: LlmRequestState,
  previousResponseId: string | undefined,
  options: LlmRequestOptions,
): Promise<string> {
  const responseId = getLocalResponseId(response);
  const messages = [
    ...state.messages,
    ...input,
    createAssistantHistoryMessage(response),
  ];

  state.messages = messages;
  state.lastResponseId = responseId;
  await saveChatResponseMessages(
    responseId,
    previousResponseId,
    messages,
    options,
  );

  return responseId;
}

async function createFinalTextResponse(
  client: OpenAI,
  response: ApiResponse,
  options: LlmRequestOptions,
  state: LlmRequestState,
  model: AgentModel,
  instructions: string,
  settings: LlmRuntimeSettings,
): Promise<ApiResponse> {
  const unresolvedFunctionCalls = getFunctionToolCalls(response);

  if (unresolvedFunctionCalls.length === 0 || getResponseText(response)) {
    return response;
  }

  logDebug("Forcing final text response after unresolved tool calls", {
    response: formatResponseSummary(response),
  });

  return await createLlmResponseWithRetries(
    client,
    unresolvedFunctionCalls.map(createSkippedToolOutput),
    [],
    state.lastResponseId,
    state,
    options,
    model,
    instructions,
    settings,
  );
}

async function createLlmResponse(
  client: OpenAI,
  input: LlmApiInput,
  tools: ToolName[],
  messages: ChatCompletionMessageParam[],
  model: AgentModel = normalAgent.MODEL,
  instructions = getSystemInstructions(),
  settings: LlmRuntimeSettings = {
    reasoning: getReasoningEffort(),
  },
  signal?: AbortSignal,
): Promise<ApiResponse> {
  throwIfAborted(signal);
  const toolDefinitions = getToolDefinitions(tools);

  return await client.chat.completions.create(
    {
      model: getConfiguredDeploymentName(model),
      messages: [
        {
          role: "system",
          content: instructions,
        },
        ...messages,
        ...input,
      ],
      // temperature: APP_ENV.LLM_TEMPERATURE,
      tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
      tool_choice: toolDefinitions.length > 0 ? "auto" : undefined,
      ...(model.withReasoning && settings.reasoning !== null
        ? { reasoning_effort: settings.reasoning }
        : {}),
    },
    { signal },
  );
}

async function createLlmResponseWithRetries(
  client: OpenAI,
  input: LlmApiInput,
  tools: ToolName[],
  responseId: string | undefined,
  state: LlmRequestState,
  options: LlmRequestOptions = {},
  model: AgentModel = normalAgent.MODEL,
  instructions = getSystemInstructions(),
  settings: LlmRuntimeSettings = {
    reasoning: getReasoningEffort(),
  },
): Promise<ApiResponse> {
  let lastError: unknown;
  let currentResponseId = responseId;
  let retryAttempts = 0;
  let rateLimitRetries = 0;

  while (true) {
    throwIfAborted(options.signal);
    const immediate = !state.receivedResponse;

    try {
      const response = await createLlmResponse(
        client,
        input,
        tools,
        state.messages,
        model,
        instructions,
        settings,
        options.signal,
      );
      const responseError = getResponseError(response);

      if (responseError) {
        throw responseError;
      }

      recordResponseDebug(response, state, model, settings);
      state.receivedResponse = true;
      currentResponseId = await recordChatResponse(
        response,
        input,
        state,
        currentResponseId,
        options,
      );

      return response;
    } catch (error) {
      lastError = error;
      const rateLimited = isRateLimitError(error);
      const contentFiltered = isContentFilterError(error);
      const emptyResponse = isEmptyResponseError(error);
      const retryingRateLimit =
        rateLimited && rateLimitRetries < LLM_RATE_LIMIT_MAX_RETRIES;
      const retryingModelError =
        retryAttempts < MAX_LLM_RETRIES &&
        (!immediate || contentFiltered || emptyResponse);
      const retrying = retryingRateLimit || retryingModelError;

      logError("LLM response step failed", {
        retryAttempts,
        rateLimitRetries,
        immediate,
        retrying,
        responseId: currentResponseId,
        lastResponseId: state.lastResponseId,
        error,
      });

      if (retryingRateLimit) {
        rateLimitRetries += 1;
        await delay(LLM_RATE_LIMIT_RETRY_DELAY_MS, options.signal);
        continue;
      }

      if (immediate && contentFiltered) {
        if (!state.sentImmediateContentFilterWarning) {
          state.sentImmediateContentFilterWarning = true;
          await options.onWarning?.(getErrorDetail(error));
        }
      }

      if (immediate && !contentFiltered && !emptyResponse) {
        throw new LlmRequestError(
          "LLM request failed immediately",
          getErrorDetail(error),
          "error",
          state.lastResponseId,
        );
      }

      if (retryAttempts >= MAX_LLM_RETRIES) {
        break;
      }

      retryAttempts += 1;
    }
  }

  throw new LlmRequestError(
    "LLM request failed after retries",
    getErrorDetail(lastError),
    "error",
    state.lastResponseId,
  );
}

async function resolveFunctionToolCalls(
  client: OpenAI,
  initialResponse: ApiResponse,
  tools: ToolName[],
  options: LlmRequestOptions = {},
  state: LlmRequestState,
  model: AgentModel = normalAgent.MODEL,
  instructions = getSystemInstructions(),
  settings: LlmRuntimeSettings = {
    reasoning: getReasoningEffort(),
  },
): Promise<{
  response: ApiResponse;
  calledTools: ToolName[];
  toolCallCount: number;
  lastResponseId?: string;
}> {
  const calledTools = new Set(getCalledTools(initialResponse));
  let toolCallCount = getToolCallCount(initialResponse);
  let response = initialResponse;
  await options.onProgress?.({
    toolCallCount,
    responseId: state.lastResponseId,
  });

  for (let index = 0; index < MAX_FUNCTION_TOOL_ROUNDS; index += 1) {
    const functionCalls = getFunctionToolCalls(response);

    if (functionCalls.length === 0) {
      break;
    }

    const toolCallResults = await Promise.all(
      functionCalls.map((call) =>
        runFunctionToolCall(
          client,
          call,
          state,
          options.context,
          options.database,
          options.signal,
          options.agentId ?? normalAgent.id,
        ),
      ),
    );
    for (const result of toolCallResults) {
      if (result.handoffAgentId) {
        state.handoffAgentId = result.handoffAgentId;
      }
    }
    await options.onProgress?.({
      toolCallCount,
      responseId: state.lastResponseId,
    });

    response = await createLlmResponseWithRetries(
      client,
      toolCallResults.map((result) => result.toolOutput),
      tools,
      state.lastResponseId,
      state,
      options,
      model,
      instructions,
      settings,
    );

    toolCallCount += getToolCallCount(response);
    await options.onProgress?.({
      toolCallCount,
      responseId: state.lastResponseId,
    });

    for (const tool of getCalledTools(response)) {
      calledTools.add(tool);
    }
  }

  response = await createFinalTextResponse(
    client,
    response,
    options,
    state,
    model,
    instructions,
    settings,
  );

  await options.onProgress?.({
    toolCallCount,
    responseId: state.lastResponseId,
  });

  return {
    response,
    calledTools: [...calledTools],
    toolCallCount,
    lastResponseId: state.lastResponseId,
  };
}

async function requestLlmWithInstructions(
  request: LlmRequestInput,
  tools: ToolName[],
  responseId?: string | null,
  options: LlmRequestOptions = {},
  instructions = getSystemInstructions(),
  model: AgentModel = normalAgent.MODEL,
): Promise<LlmResponse> {
  logDebug("Sending request to LLM", { tools, responseId, model });
  const client = getClient();
  const settings = await resolveRuntimeSettings(model, options);
  const runtimeInstructions = await withMemoMetadata(instructions, options);
  const previousMessages = await loadPreviousChatMessages(
    responseId ?? undefined,
    options,
  );
  const state: LlmRequestState = {
    lastResponseId: responseId ?? undefined,
    messages: previousMessages,
    receivedResponse: false,
    sentImmediateContentFilterWarning: false,
    hasStickerSlot: false,
    images: [],
    stickers: [],
    errors: [],
    debug: {
      responses: [],
      tool_calls: [],
    },
  };
  const initialResponse = await createLlmResponseWithRetries(
    client,
    createInputMessages(request),
    tools,
    responseId ?? undefined,
    state,
    options,
    model,
    runtimeInstructions,
    settings,
  );

  const { response, calledTools, toolCallCount, lastResponseId } =
    await resolveFunctionToolCalls(
      client,
      initialResponse,
      tools,
      options,
      state,
      model,
      runtimeInstructions,
      settings,
    );
  logDebug("Received response from LLM", formatResponseSummary(response));

  if (!getResponseText(response) && getFunctionToolCalls(response).length > 0) {
    logDebug("LLM response still contains unresolved function calls", {
      response: formatResponseSummary(response),
    });
  }

  const citations = getCitations(response);
  const citationLinks = new Set(citations.map((citation) => citation.link));
  const sources = getWebSearchSourceLinks(response)
    .filter((link) => !citationLinks.has(link))
    .map((link) => ({ link }));
  const responseText = getResponseText(response);

  return {
    response_id: lastResponseId,
    handoff_agent_id: state.handoffAgentId,
    response: responseText,
    report: state.report,
    images: state.images,
    stickers: state.stickers,
    errors: state.errors,
    web_search: {
      used: calledTools.includes("web_search"),
      citations,
      sources,
    },
    tools: calledTools,
    tool_call_count: toolCallCount,
    debug: state.debug,
  };
}

async function runAgent(
  agentId: string,
  task: string,
  context?: LlmToolContext,
  signal?: AbortSignal,
  database?: Database,
): Promise<FunctionToolResult> {
  const agent = getCallableAgentById(agentId);

  if (!agent) {
    return {
      output: JSON.stringify({
        error: "Unknown or unavailable agent.",
        agent: agentId,
      }),
    };
  }

  const result = await requestLlmWithInstructions(
    `Delegated task from ultimate agent:\n${task}\n\nReturn a concise result for the ultimate agent to synthesize.`,
    agent.tools,
    undefined,
    { context, database, signal, agentId: agent.id },
    agent.buildInstructions(),
    agent.MODEL,
  );

  const output = JSON.stringify({
    agent: agent.id,
    response: result.response ?? "",
    report_attached: Boolean(result.report),
    stickers_attached: result.stickers.length,
    tools_used: result.tools,
    tool_call_count: result.tool_call_count,
    errors: result.errors,
    web_search: result.web_search.used,
  });

  if (result.report) {
    return {
      output,
      handoffAgentId: agent.id,
      report: result.report,
      stickers: result.stickers,
    };
  }

  return { output, handoffAgentId: agent.id, stickers: result.stickers };
}

export async function requestLlm(
  request: LlmRequestInput,
  tools: ToolName[],
  responseId?: string | null,
  options: LlmRequestOptions = {},
  instructions = getSystemInstructions(),
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
