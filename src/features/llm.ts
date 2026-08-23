import { createDebug } from "@grammyjs/debug";
import OpenAI from "@openai/openai";
import { delay, throwIfAborted } from "../utils/async.ts";
import { escapeXmlAttribute } from "../utils/text.ts";
import {
  type AgentId,
  type AgentModel,
  getAgentById,
  normalAgent,
} from "./agents/index.ts";
import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";
import {
  getLlmResponseInputItems,
  saveLlmResponseInputItems,
} from "./llm-chat-responses.ts";
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
  LlmGeneratedImage,
  LlmImageInput,
  LlmSticker,
  LlmToolContext,
} from "./llm-tools/types.ts";
import * as webSearchTool from "./llm-tools/web-search.ts";
import * as youtubeTool from "./llm-tools/youtube.ts";
import { buildMemosMetadataSection } from "./memos.ts";

export type { LlmReport } from "./llm-tools/reports.ts";
export type {
  LlmGeneratedImage,
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
  status?: OpenAI.Responses.ResponseStatus;
  incomplete_reason?: string;
  usage?: LlmDebugUsage;
};

export type LlmDebugInfo = {
  responses: LlmDebugModelResponse[];
  tool_calls: LlmDebugToolCall[];
};

export type LlmResponse = {
  response_id?: string;
  response?: string;
  replyMessageId?: number | null;
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

type ApiResponse = OpenAI.Responses.Response;
type FunctionTool = OpenAI.Responses.FunctionTool;
type ResponseInputImage = OpenAI.Responses.ResponseInputImage;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type FunctionToolCall = OpenAI.Responses.ResponseFunctionToolCall & {
  name: FunctionToolName;
};
type FunctionCallOutput = Extract<
  ResponseInputItem,
  { type: "function_call_output" }
>;
type LlmApiInput = OpenAI.Responses.ResponseInput;

type FunctionToolCallResult = {
  toolOutput: FunctionCallOutput;
};

type LlmRuntimeSettings = {
  reasoning: ReasoningSetting;
};

const logDebug = createDebug("app:llm:debug");
const logError = createDebug("app:llm:error");
const MAX_LLM_RETRIES = 10;
const MAX_EMPTY_RESPONSE_RETRIES = 2;
const LLM_RATE_LIMIT_RETRY_DELAY_MS = 3000;
const LLM_RATE_LIMIT_MAX_RETRIES = 5;
const MAX_FUNCTION_TOOL_ROUNDS = 4;
const DUPLICATE_STICKER_RESPONSE = JSON.stringify({
  error: "Duplicate sticker",
  details: "You have already sent a sticker.",
});
const RETRIABLE_EMPTY_RESPONSE_DETAILS = new Set([
  "empty response",
  "missing output",
]);
const IMAGE_DOWNLOAD_ERROR_PATTERN =
  /error while downloading (?:file|image)|upstream status code:\s*(?:401|403|404|410)/i;
const MARKDOWN_TOOL_OUTPUTS = new Set<string>(["read_web_page"]);

type LlmRequestState = {
  lastResponseId?: string;
  replyMessageId?: number | null;
  inputItems: ResponseInputItem[];
  receivedResponse: boolean;
  sentImmediateContentFilterWarning: boolean;
  hasStickerSlot: boolean;
  report?: LlmReport;
  images: LlmGeneratedImage[];
  stickers: LlmSticker[];
  errors: string[];
  debug: LlmDebugInfo;
};

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

function getToolDefinitions(tools: ToolName[]): FunctionTool[] {
  const definitions: FunctionTool[] = [];

  for (const tool of tools) {
    definitions.push(createFunctionToolDefinition(TOOL_DEFINITIONS[tool]));
  }

  return definitions;
}

function createFunctionToolDefinition(
  definition: FunctionToolDefinition,
): FunctionTool {
  return {
    type: "function",
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    strict: definition.strict,
  };
}

function isFunctionToolName(tool: string): tool is FunctionToolName {
  return tool in FUNCTION_TOOL_RUNNERS;
}

function isFunctionToolCall(
  call: OpenAI.Responses.ResponseFunctionToolCall,
): call is FunctionToolCall {
  return (
    call.type === "function_call" &&
    typeof call.call_id === "string" &&
    typeof call.name === "string" &&
    isFunctionToolName(call.name) &&
    typeof call.arguments === "string"
  );
}

function getResponseText(response: ApiResponse): string | undefined {
  return response.output_text || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCitations(response: ApiResponse): LlmCitation[] {
  const citations: LlmCitation[] = [];
  let textOffset = 0;

  for (const item of response.output) {
    if (item.type !== "message") {
      continue;
    }

    for (const content of item.content) {
      if (content.type !== "output_text") {
        continue;
      }

      for (const annotation of content.annotations) {
        if (annotation.type !== "url_citation") {
          continue;
        }

        citations.push({
          start_index: textOffset + annotation.start_index,
          end_index: textOffset + annotation.end_index,
          link: annotation.url,
        });
      }

      textOffset += content.text.length;
    }
  }

  return citations;
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
    calledTools.add(call.name);
  }

  return [...calledTools];
}

function getUnsupportedToolCallNames(response: ApiResponse): string[] {
  const names: string[] = [];

  for (const item of response.output) {
    if (item.type === "function_call" && !isFunctionToolName(item.name)) {
      names.push(item.name);
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

function isPromptMessageXml(content: string): boolean {
  return /^\s*<message(?:\s|>)/.test(content);
}

function formatInputTextContent(content: string, fallback = ""): string {
  const text = content.trim() || fallback;

  return isPromptMessageXml(text)
    ? text
    : formatPromptMessageXml({ sender: "User" }, text);
}

function createInputMessage(
  request: LlmRequestMessageInput,
): ResponseInputItem {
  if (typeof request === "string") {
    return {
      type: "message",
      role: "user",
      content: formatInputTextContent(request),
    };
  }

  const images = request.images ?? [];
  if (images.length === 0) {
    return {
      type: "message",
      role: "user",
      content: formatInputTextContent(request.text),
    };
  }

  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: formatInputTextContent(
          request.text,
          "Please respond to the attached image.",
        ),
      },
      ...images.map(createImageContentPart),
    ],
  };
}

function createInputMessages(request: LlmRequestInput): LlmApiInput {
  return (Array.isArray(request) ? request : [request]).map(createInputMessage);
}

function normalizeUserMessageForRequest(
  item: ResponseInputItem,
): ResponseInputItem {
  if (item.type !== "message" || item.role !== "user") {
    return item;
  }

  const content = item.content;

  if (typeof content === "string") {
    return {
      ...item,
      content: formatInputTextContent(content),
    };
  }

  if (!Array.isArray(content)) {
    return item;
  }

  return {
    ...item,
    content: content.map((part) =>
      part.type === "input_text"
        ? { ...part, text: formatInputTextContent(part.text) }
        : part,
    ),
  };
}

function getFunctionToolCalls(response: ApiResponse): FunctionToolCall[] {
  return response.output
    .filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall =>
        item.type === "function_call",
    )
    .filter(isFunctionToolCall);
}

function createImageContentPart(image: LlmImageInput): ResponseInputImage {
  return {
    type: "input_image",
    image_url: image.image_url,
    detail: image.detail ?? "auto",
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
    name: call.name,
    input: parseJsonObject(call.arguments) ?? call.arguments,
  };
}

function getNumberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function getResponseUsage(response: ApiResponse): LlmDebugUsage | undefined {
  const usage = response.usage;

  if (!isRecord(usage)) {
    return undefined;
  }

  const inputDetails: Record<string, unknown> = isRecord(
    usage.input_tokens_details,
  )
    ? usage.input_tokens_details
    : {};
  const outputDetails: Record<string, unknown> = isRecord(
    usage.output_tokens_details,
  )
    ? usage.output_tokens_details
    : {};
  const debugUsage: LlmDebugUsage = {
    input_tokens: getNumberValue(usage.input_tokens),
    output_tokens: getNumberValue(usage.output_tokens),
    total_tokens: getNumberValue(usage.total_tokens),
    cached_tokens: getNumberValue(inputDetails.cached_tokens),
    reasoning_tokens: getNumberValue(outputDetails.reasoning_tokens),
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
    status: response.status,
    incomplete_reason: response.incomplete_details?.reason,
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
    callId: call.call_id,
    name: call.name,
    arguments: parseJsonObject(call.arguments) ?? call.arguments,
  };
}

function formatResponseSummary(response: ApiResponse): Record<string, unknown> {
  return {
    id: response.id,
    status: response.status,
    incompleteReason: response.incomplete_details?.reason,
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
    error instanceof LlmRequestError ? error.details : undefined,
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
  if (response.incomplete_details?.reason === "content_filter") {
    return new LlmRequestError(
      "LLM response was blocked by content filtering",
      "content_filter",
      "content_filter",
    );
  }

  if (response.error) {
    return new LlmRequestError(
      "LLM response failed",
      `${response.error.code}: ${response.error.message}`,
      isContentFilterError(response.error) ? "content_filter" : "error",
    );
  }

  if (
    response.status === "failed" ||
    response.status === "cancelled" ||
    response.status === "queued" ||
    response.status === "in_progress"
  ) {
    return new LlmRequestError(
      "LLM response did not complete",
      `response status: ${response.status}`,
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
    return new LlmRequestError(
      "LLM response was empty",
      response.output.length === 0 ? "missing output" : "empty response",
    );
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
  inputImages: LlmImageInput[] = [],
): FunctionCallOutput {
  logDebug("Tool call response", {
    callId: call.call_id,
    name: call.name,
    output,
  });

  const formattedOutput = formatToolResponseContent(call.name, output);

  return {
    type: "function_call_output",
    call_id: call.call_id,
    output:
      inputImages.length > 0
        ? [
            { type: "input_text", text: formattedOutput },
            ...inputImages.map(createImageContentPart),
          ]
        : formattedOutput,
  };
}

function recoverUnavailableReadImageInput(
  input: LlmApiInput,
  state: LlmRequestState,
  error: unknown,
): LlmApiInput | undefined {
  if (!IMAGE_DOWNLOAD_ERROR_PATTERN.test(getErrorDetail(error))) {
    return undefined;
  }

  const readImageCallIds = new Set(
    state.inputItems.flatMap((item) =>
      item.type === "function_call" && item.name === "read_image"
        ? [item.call_id]
        : [],
    ),
  );
  const recoveredCallIds: string[] = [];
  const recoveredInput = input.map((item) => {
    if (
      item.type !== "function_call_output" ||
      !readImageCallIds.has(item.call_id) ||
      !Array.isArray(item.output) ||
      !item.output.some((part) => part.type === "input_image")
    ) {
      return item;
    }

    recoveredCallIds.push(item.call_id);
    return {
      ...item,
      output: formatToolResponseContent(
        "read_image",
        JSON.stringify({
          error: "Image unavailable",
          details:
            "The vision service could not download this image. Try another image result or tell the user it is unavailable.",
        }),
      ),
    };
  });

  if (recoveredCallIds.length === 0) {
    return undefined;
  }

  logError("Vision service could not download read_image input", {
    callIds: recoveredCallIds,
    error,
  });
  return recoveredInput;
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

  if (!body) {
    return `<tool_response ${attributes}></tool_response>`;
  }

  return [`<tool_response ${attributes}>`, body, "</tool_response>"].join("\n");
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
  const args = parseJsonObject(call.arguments);
  logDebug("Running tool call", formatToolCallLog(call));
  const runner = FUNCTION_TOOL_RUNNERS[call.name];
  const reservedStickerSlot = call.name === "send_sticker";

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
    const message = `Tool ${call.name} failed: ${details}`;
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
          tool: call.name,
          details,
        }),
      ),
    };
  }

  if (result.report) {
    state.report = result.report;
  }

  if ("replyMessageId" in result) {
    state.replyMessageId = result.replyMessageId;
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
    toolOutput: createToolOutput(call, result.output, result.inputImages),
  };
}

const responseInputCache = new Map<string, ResponseInputItem[]>();

function cloneResponseInputItems(
  inputItems: ResponseInputItem[],
): ResponseInputItem[] {
  return JSON.parse(JSON.stringify(inputItems)) as ResponseInputItem[];
}

function getLocalResponseId(response: ApiResponse): string {
  return response.id || `resp-local-${crypto.randomUUID()}`;
}

async function saveFailedResponseInputCheckpoint(
  input: LlmApiInput,
  previousResponseId: string | undefined,
  state: LlmRequestState,
  options: LlmRequestOptions,
): Promise<string> {
  const responseId = `resp-local-${crypto.randomUUID()}`;
  const inputItems = closePendingToolCalls([
    ...state.inputItems,
    ...cloneResponseInputItems(input),
  ]);

  state.inputItems = inputItems;
  state.lastResponseId = responseId;
  await saveResponseInput(responseId, previousResponseId, inputItems, options);

  return responseId;
}

function createInterruptedToolOutput(
  toolCallId: string,
  toolName = "unknown",
): FunctionCallOutput {
  return {
    type: "function_call_output",
    call_id: toolCallId,
    output: formatToolResponseContent(
      toolName,
      JSON.stringify({
        error: "Tool execution interrupted",
        details:
          "Tool execution was interrupted before a result was available.",
      }),
    ),
  };
}

function createSkippedToolOutput(call: FunctionToolCall): FunctionCallOutput {
  return {
    type: "function_call_output",
    call_id: call.call_id,
    output: formatToolResponseContent(
      call.name,
      JSON.stringify({
        error: "Tool execution skipped",
        details:
          "Tool execution was skipped because the maximum tool round limit was reached. Produce the final answer from the available context and mention any important missing data.",
      }),
    ),
  };
}

function closePendingToolCalls(
  inputItems: ResponseInputItem[],
): ResponseInputItem[] {
  const pendingToolCalls = new Map<string, string>();

  for (const item of inputItems) {
    if (item.type === "function_call") {
      pendingToolCalls.set(item.call_id, item.name);
      continue;
    }

    if (item.type === "function_call_output") {
      pendingToolCalls.delete(item.call_id);
    }
  }

  if (pendingToolCalls.size === 0) {
    return inputItems;
  }

  return [
    ...inputItems,
    ...[...pendingToolCalls].map(([toolCallId, toolName]) =>
      createInterruptedToolOutput(toolCallId, toolName),
    ),
  ];
}

async function loadPreviousResponseInput(
  responseId: string | undefined,
  options: LlmRequestOptions,
): Promise<ResponseInputItem[]> {
  if (!responseId) {
    return [];
  }

  const cachedInput = responseInputCache.get(responseId);
  if (cachedInput) {
    return closePendingToolCalls(cloneResponseInputItems(cachedInput));
  }

  if (!options.database) {
    logDebug("No database available for response history", { responseId });
    return [];
  }

  const inputItems = await getLlmResponseInputItems(
    options.database,
    responseId,
  );

  if (!inputItems) {
    logDebug("No persisted response history found", { responseId });
    return [];
  }

  responseInputCache.set(responseId, cloneResponseInputItems(inputItems));
  return closePendingToolCalls(inputItems);
}

async function saveResponseInput(
  responseId: string,
  previousResponseId: string | undefined,
  inputItems: ResponseInputItem[],
  options: LlmRequestOptions,
): Promise<void> {
  const savedInput = cloneResponseInputItems(inputItems);
  responseInputCache.set(responseId, savedInput);

  if (!options.database) {
    return;
  }

  try {
    await saveLlmResponseInputItems(options.database, {
      responseId,
      previousResponseId,
      inputItems: savedInput,
    });
  } catch (error) {
    logError("Failed to save response history", { responseId, error });
  }
}

function getReplayableOutputItems(response: ApiResponse): ResponseInputItem[] {
  const inputItems: ResponseInputItem[] = [];

  for (const item of response.output) {
    if (
      item.type === "message" ||
      item.type === "reasoning" ||
      item.type === "function_call"
    ) {
      inputItems.push(item);
    }
  }

  return inputItems;
}

async function recordResponse(
  response: ApiResponse,
  input: LlmApiInput,
  state: LlmRequestState,
  previousResponseId: string | undefined,
  options: LlmRequestOptions,
): Promise<string> {
  const responseId = getLocalResponseId(response);
  const inputItems = [
    ...state.inputItems,
    ...input,
    ...getReplayableOutputItems(response),
  ];

  state.inputItems = inputItems;
  state.lastResponseId = responseId;
  await saveResponseInput(responseId, previousResponseId, inputItems, options);

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
  previousInput: ResponseInputItem[],
  model: AgentModel = normalAgent.MODEL,
  instructions = getSystemInstructions(),
  settings: LlmRuntimeSettings = {
    reasoning: getReasoningEffort(),
  },
  signal?: AbortSignal,
): Promise<ApiResponse> {
  throwIfAborted(signal);
  const toolDefinitions = getToolDefinitions(tools);

  return await client.responses.create(
    {
      model: getConfiguredDeploymentName(model),
      instructions,
      input: [
        ...previousInput.map(normalizeUserMessageForRequest),
        ...input.map(normalizeUserMessageForRequest),
      ],
      // temperature: APP_ENV.LLM_TEMPERATURE,
      tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
      tool_choice: toolDefinitions.length > 0 ? "auto" : undefined,
      store: false,
      ...(model.withReasoning
        ? { include: ["reasoning.encrypted_content"] as const }
        : {}),
      ...(model.withReasoning && settings.reasoning !== null
        ? { reasoning: { effort: settings.reasoning } }
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
  let currentInput = input;
  let currentResponseId = responseId;
  let retryAttempts = 0;
  let emptyResponseRetries = 0;
  let rateLimitRetries = 0;

  while (true) {
    throwIfAborted(options.signal);
    const immediate = !state.receivedResponse;

    try {
      const response = await createLlmResponse(
        client,
        currentInput,
        tools,
        state.inputItems,
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
      currentResponseId = await recordResponse(
        response,
        currentInput,
        state,
        currentResponseId,
        options,
      );

      return response;
    } catch (error) {
      lastError = error;
      const recoveredInput = recoverUnavailableReadImageInput(
        currentInput,
        state,
        error,
      );

      if (recoveredInput) {
        currentInput = recoveredInput;
        continue;
      }

      const rateLimited = isRateLimitError(error);
      const contentFiltered = isContentFilterError(error);
      const emptyResponse = isEmptyResponseError(error);
      const retryingRateLimit =
        rateLimited && rateLimitRetries < LLM_RATE_LIMIT_MAX_RETRIES;
      const retryingEmptyResponse =
        emptyResponse && emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES;
      const retryingModelError =
        !emptyResponse &&
        retryAttempts < MAX_LLM_RETRIES &&
        (!immediate || contentFiltered);
      const retrying =
        retryingRateLimit || retryingEmptyResponse || retryingModelError;

      logError("LLM response step failed", {
        retryAttempts,
        emptyResponseRetries,
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
        const checkpointResponseId = await saveFailedResponseInputCheckpoint(
          currentInput,
          currentResponseId,
          state,
          options,
        );
        throw new LlmRequestError(
          "LLM request failed immediately",
          getErrorDetail(error),
          "error",
          checkpointResponseId,
        );
      }

      if (emptyResponse) {
        if (emptyResponseRetries >= MAX_EMPTY_RESPONSE_RETRIES) {
          break;
        }

        emptyResponseRetries += 1;
        continue;
      }

      if (retryAttempts >= MAX_LLM_RETRIES) {
        break;
      }

      retryAttempts += 1;
    }
  }

  const checkpointResponseId = await saveFailedResponseInputCheckpoint(
    currentInput,
    currentResponseId,
    state,
    options,
  );

  throw new LlmRequestError(
    "LLM request failed after retries",
    getErrorDetail(lastError),
    "error",
    checkpointResponseId,
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
  instructions = getSystemInstructions(options.context?.chatId),
  model: AgentModel = normalAgent.MODEL,
): Promise<LlmResponse> {
  logDebug("Sending request to LLM", { tools, responseId, model });
  const client = getClient();
  const settings = await resolveRuntimeSettings(model, options);
  const runtimeInstructions = await withMemoMetadata(instructions, options);
  const previousInput = await loadPreviousResponseInput(
    responseId ?? undefined,
    options,
  );
  const state: LlmRequestState = {
    lastResponseId: responseId ?? undefined,
    inputItems: previousInput,
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
    response: responseText,
    replyMessageId: state.replyMessageId,
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
