import { createDebug } from "@grammyjs/debug";
import OpenAI from "@openai/openai";
import { delay, throwIfAborted } from "../utils/async.ts";
import {
  type AgentId,
  type AgentModel,
  getCallableAgentById,
  normalAgent,
} from "./agents/index.ts";
import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";
import {
  getChatReasoningEffort,
  getChatWebSearchSetting,
  getReasoningEffort,
  getWebSearchSetting,
  isWebSearchEnabled,
  type ReasoningSetting,
  type WebSearchSetting,
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
import type { LlmReport } from "./llm-tools/reports.ts";
import * as reportsTool from "./llm-tools/reports.ts";
import * as scheduleTool from "./llm-tools/schedule.ts";
import type {
  FunctionToolResult,
  FunctionToolRunner,
  LlmGeneratedImage,
  LlmToolContext,
} from "./llm-tools/types.ts";
import * as webSearchTool from "./llm-tools/web-search.ts";
import * as youtubeTool from "./llm-tools/youtube.ts";

export type { LlmReport } from "./llm-tools/reports.ts";
export type { LlmGeneratedImage, LlmToolContext } from "./llm-tools/types.ts";

export const TOOL_DEFINITIONS = {
  get_markets_state: marketTool.toolDefinition,
  search_chat: searchChatToolDefinition,
  read_last_messages: readLastMessagesToolDefinition,
  get_recent_news: gdeltTool.toolDefinition,
  read_youtube_video: youtubeTool.toolDefinition,
  generate_image: imageTool.toolDefinition,
  send_report: reportsTool.toolDefinition,
  send_trading_report: reportsTool.tradingToolDefinition,
  call_agent: agentTool.toolDefinition,
  schedule_message: scheduleTool.scheduleMessageToolDefinition,
  cron_message: scheduleTool.cronMessageToolDefinition,
} as const;

export type ToolName = "web_search" | keyof typeof TOOL_DEFINITIONS;

const FUNCTION_TOOL_RUNNERS = {
  get_markets_state: marketTool.execute,
  search_chat: executeSearchChat,
  read_last_messages: executeReadLastMessages,
  get_recent_news: gdeltTool.execute,
  read_youtube_video: youtubeTool.execute,
  generate_image: imageTool.execute,
  send_report: reportsTool.execute,
  send_trading_report: reportsTool.executeTrading,
  call_agent: agentTool.createRunner(runAgent),
  schedule_message: scheduleTool.executeScheduleMessage,
  cron_message: scheduleTool.executeCronMessage,
} satisfies Record<string, FunctionToolRunner>;

type FunctionToolName = keyof typeof FUNCTION_TOOL_RUNNERS;

export const DEFAULT_LLM_TOOLS = [
  "web_search",
  ...Object.keys(TOOL_DEFINITIONS),
] as ToolName[];

export type LlmProgress = {
  toolCallCount: number;
  responseId?: string;
};

export type LlmRequestOptions = {
  database?: Database;
  context?: LlmToolContext;
  onProgress?: (progress: LlmProgress) => void | Promise<void>;
  onWarning?: (details: string) => void | Promise<void>;
  signal?: AbortSignal;
};

export type LlmImageInput = {
  image_url: string;
  detail?: "low" | "high" | "auto" | "original";
};

export type LlmRequestInput =
  | string
  | {
      text: string;
      images?: LlmImageInput[];
    };

export type LlmCitation = {
  start_index: number;
  end_index: number;
  link: string;
};

export type LlmSource = {
  link: string;
};

export type LlmResponse = {
  response_id?: string;
  handoff_agent_id?: AgentId;
  response?: string;
  report?: LlmReport;
  images: LlmGeneratedImage[];
  web_search: {
    used: boolean;
    citations: LlmCitation[];
    sources: LlmSource[];
  };
  tools: ToolName[];
  tool_call_count: number;
};

type ToolDefinition =
  | ReturnType<typeof webSearchTool.createToolDefinition>
  | (typeof TOOL_DEFINITIONS)[keyof typeof TOOL_DEFINITIONS];

type ApiResponse = {
  id?: string;
  output: ApiResponseOutputItem[];
  output_text?: string;
  status?: string;
  error?: {
    code?: string | null;
    message?: string | null;
  } | null;
  incomplete_details?: {
    reason?: string | null;
  } | null;
};

type ApiResponseOutputItem = {
  type: string;
  action?: unknown;
  content?: unknown;
  name?: unknown;
  arguments?: unknown;
  call_id?: unknown;
};

type WebSearchAction = {
  type: string;
  sources?: Array<{ url?: string | null }>;
  url?: string | null;
};

type OutputTextContent = {
  type: "output_text";
  annotations: Array<{
    type: string;
    start_index?: number;
    end_index?: number;
    url?: string;
  }>;
};

type FunctionToolCall = ApiResponseOutputItem & {
  type: "function_call";
  name: FunctionToolName;
  arguments: string;
  call_id: string;
};

type FunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

type InputTextContent = {
  type: "input_text";
  text: string;
};

type InputImageContent = {
  type: "input_image";
  image_url: string;
  detail: "low" | "high" | "auto" | "original";
};

type UserInputMessage = {
  type: "message";
  role: "user";
  content: Array<InputTextContent | InputImageContent>;
};

type LlmApiInput = string | UserInputMessage[] | FunctionCallOutput[];

type FunctionToolCallResult = {
  toolOutput: FunctionCallOutput;
  handoffAgentId?: AgentId;
};

type LlmRuntimeSettings = {
  reasoning: ReasoningSetting;
  webSearch: WebSearchSetting;
};

const logDebug = createDebug("app:llm:debug");
const logError = createDebug("app:llm:error");
const MAX_LLM_RETRIES = 3;
const LLM_RATE_LIMIT_RETRY_DELAY_MS = 3000;
const LLM_RATE_LIMIT_MAX_RETRIES = 5;
type LlmRequestState = {
  lastResponseId?: string;
  handoffAgentId?: AgentId;
  receivedResponse: boolean;
  sentImmediateContentFilterWarning: boolean;
  report?: LlmReport;
  images: LlmGeneratedImage[];
};

function getSystemInstructions(): string {
  return normalAgent.buildInstructions();
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
      webSearch: getWebSearchSetting(),
    };
  }

  const [reasoning, webSearch] = await Promise.all([
    getChatReasoningEffort(database, chatId, model.id),
    getChatWebSearchSetting(database, chatId, model.id),
  ]);

  return { reasoning, webSearch };
}

function getExposedTools(
  tools: ToolName[],
  settings: LlmRuntimeSettings,
): ToolName[] {
  return tools.filter((tool) => {
    if (tool === "web_search") {
      return isWebSearchEnabled(settings.webSearch);
    }

    if (tool === "generate_image") {
      return imageTool.isConfigured();
    }

    return true;
  });
}

function getToolDefinitions(
  tools: ToolName[],
  settings: LlmRuntimeSettings,
): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];

  for (const tool of getExposedTools(tools, settings)) {
    if (tool === "web_search") {
      definitions.push(webSearchTool.createToolDefinition(settings.webSearch));
      continue;
    }

    definitions.push(TOOL_DEFINITIONS[tool]);
  }

  return definitions;
}

function getResponseInclude(tools: ToolName[], settings: LlmRuntimeSettings) {
  return getExposedTools(tools, settings).includes("web_search")
    ? ["web_search_call.action.sources" as const]
    : undefined;
}

function withToolAvailabilityInstructions(
  instructions: string,
  tools: ToolName[],
  settings: LlmRuntimeSettings,
): string {
  const exposedTools = getExposedTools(tools, settings);
  const toolList = exposedTools.length > 0 ? exposedTools.join(", ") : "none";

  return `${instructions}

# Available Runtime Tools
The tool interface currently exposes exactly these tools: ${toolList}.
Only call tools that are exposed through the tool interface. If a tool is not exposed here, do not write its name, JSON arguments, or pseudo tool call syntax in a normal response; explain briefly that the tool is unavailable.`;
}

function isOutputText(content: unknown): content is OutputTextContent {
  return (
    typeof content === "object" &&
    content !== null &&
    "type" in content &&
    content.type === "output_text"
  );
}

function isMessageItem(
  item: ApiResponseOutputItem,
): item is ApiResponseOutputItem & { type: "message"; content: unknown[] } {
  return item.type === "message" && Array.isArray(item.content);
}

function isWebSearchAction(action: unknown): action is WebSearchAction {
  return typeof action === "object" && action !== null && "type" in action;
}

function isWebSearchCall(
  item: ApiResponseOutputItem,
): item is ApiResponseOutputItem & {
  type: "web_search_call";
  action: WebSearchAction;
} {
  return item.type === "web_search_call" && isWebSearchAction(item.action);
}

function isFunctionToolName(tool: string): tool is FunctionToolName {
  return tool in FUNCTION_TOOL_RUNNERS;
}

function isFunctionToolCall(
  item: ApiResponseOutputItem,
): item is FunctionToolCall {
  return (
    item.type === "function_call" &&
    typeof item.name === "string" &&
    isFunctionToolName(item.name) &&
    typeof item.arguments === "string" &&
    typeof item.call_id === "string"
  );
}

function pushUniqueLink(links: string[], link: string | null | undefined) {
  if (!link || links.includes(link)) {
    return;
  }

  links.push(link);
}

function getCitations(response: ApiResponse): LlmCitation[] {
  return response.output.flatMap((item) => {
    if (!isMessageItem(item)) {
      return [];
    }

    return item.content.flatMap((content) => {
      if (!isOutputText(content)) {
        return [];
      }

      return content.annotations
        .filter(
          (annotation) =>
            annotation.type === "url_citation" &&
            typeof annotation.start_index === "number" &&
            typeof annotation.end_index === "number" &&
            typeof annotation.url === "string",
        )
        .map((annotation) => ({
          start_index: annotation.start_index as number,
          end_index: annotation.end_index as number,
          link: annotation.url as string,
        }));
    });
  });
}

function getWebSearchSourceLinks(response: ApiResponse): string[] {
  const links: string[] = [];

  for (const item of response.output) {
    if (!isWebSearchCall(item)) {
      continue;
    }

    switch (item.action.type) {
      case "search":
        for (const source of item.action.sources ?? []) {
          pushUniqueLink(links, source.url);
        }
        break;
      case "open_page":
      case "find_in_page":
        pushUniqueLink(links, item.action.url);
        break;
    }
  }

  return links;
}

function getCalledTools(response: ApiResponse): ToolName[] {
  const calledTools = new Set<ToolName>();

  for (const item of response.output) {
    if (item.type === "web_search_call") {
      calledTools.add("web_search");
    } else if (isFunctionToolCall(item)) {
      calledTools.add(item.name);
    }
  }

  return [...calledTools];
}

function getToolCallCount(response: ApiResponse): number {
  return response.output.filter(
    (item) => item.type === "web_search_call" || isFunctionToolCall(item),
  ).length;
}

function createInputMessage(
  request: LlmRequestInput,
): string | UserInputMessage[] {
  if (typeof request === "string") {
    return request;
  }

  const images = request.images ?? [];
  if (images.length === 0) {
    return request.text;
  }

  return [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: request.text.trim() || "Please respond to the attached image.",
        },
        ...images.map((image) => ({
          type: "input_image" as const,
          image_url: image.image_url,
          detail: image.detail ?? "auto",
        })),
      ],
    },
  ];
}

function getFunctionToolCalls(response: ApiResponse): FunctionToolCall[] {
  return response.output.filter(isFunctionToolCall);
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
    outputTextLength: response.output_text?.length ?? 0,
    outputTypes: response.output.map((item) => item.type),
    functionCalls: getFunctionToolCalls(response).map(formatToolCallLog),
    tools: getCalledTools(response),
    error: response.error,
    incompleteDetails: response.incomplete_details,
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
  if (response.incomplete_details?.reason === "content_filter") {
    return new LlmRequestError(
      "LLM response was blocked by content filtering",
      "content_filter",
      "content_filter",
    );
  }

  if (response.status === "failed" && response.error) {
    const detail = [response.error.code, response.error.message]
      .filter(Boolean)
      .join(": ");
    return new LlmRequestError(
      "LLM response failed",
      detail || "response failed",
    );
  }

  if (!response.output_text && getFunctionToolCalls(response).length === 0) {
    return new LlmRequestError("LLM response was empty", "empty response");
  }

  return undefined;
}

function createToolOutput(
  call: FunctionToolCall,
  output: string,
): FunctionCallOutput {
  logDebug("Tool call response", {
    callId: call.call_id,
    name: call.name,
    output,
  });

  return {
    type: "function_call_output",
    call_id: call.call_id,
    output,
  };
}

function normalizeFunctionToolResult(
  result: FunctionToolResult | string,
): FunctionToolResult {
  return typeof result === "string" ? { output: result } : result;
}

async function runFunctionToolCall(
  call: FunctionToolCall,
  state: LlmRequestState,
  context?: LlmToolContext,
  database?: Database,
  signal?: AbortSignal,
): Promise<FunctionToolCallResult> {
  throwIfAborted(signal);
  const args = parseJsonObject(call.arguments);
  logDebug("Running tool call", formatToolCallLog(call));
  const runner = FUNCTION_TOOL_RUNNERS[call.name];
  const result = normalizeFunctionToolResult(
    await runner(args, context, { signal, database }),
  );
  throwIfAborted(signal);

  if (result.report) {
    state.report = result.report;
  }

  if (result.image) {
    state.images.push(result.image);
  }

  return {
    toolOutput: createToolOutput(call, result.output),
    handoffAgentId: result.handoffAgentId,
  };
}

async function createLlmResponse(
  client: OpenAI,
  input: LlmApiInput,
  tools: ToolName[],
  responseId?: string | null,
  model: AgentModel = normalAgent.MODEL,
  instructions = getSystemInstructions(),
  settings: LlmRuntimeSettings = {
    reasoning: getReasoningEffort(),
    webSearch: getWebSearchSetting(),
  },
  signal?: AbortSignal,
): Promise<ApiResponse> {
  throwIfAborted(signal);

  return await client.responses.create(
    {
      model: getConfiguredDeploymentName(model),
      input,
      instructions: withToolAvailabilityInstructions(
        instructions,
        tools,
        settings,
      ),
      // temperature: APP_ENV.LLM_TEMPERATURE,
      tools: getToolDefinitions(tools, settings),
      tool_choice: "auto",
      include: getResponseInclude(tools, settings),
      previous_response_id: responseId == null ? undefined : responseId,
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
    webSearch: getWebSearchSetting(),
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
        currentResponseId,
        model,
        instructions,
        settings,
        options.signal,
      );
      const responseError = getResponseError(response);
      state.lastResponseId = response.id ?? state.lastResponseId;
      state.receivedResponse = true;
      currentResponseId = response.id ?? currentResponseId;

      if (responseError) {
        throw responseError;
      }

      return response;
    } catch (error) {
      lastError = error;
      const rateLimited = isRateLimitError(error);
      const contentFiltered = isContentFilterError(error);
      const retryingRateLimit =
        rateLimited && rateLimitRetries < LLM_RATE_LIMIT_MAX_RETRIES;
      const retrying =
        retryingRateLimit ||
        (retryAttempts < MAX_LLM_RETRIES && (!immediate || contentFiltered));

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

        if (retryAttempts >= MAX_LLM_RETRIES) {
          break;
        }

        retryAttempts += 1;
        continue;
      }

      if (immediate) {
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
    webSearch: getWebSearchSetting(),
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
    responseId: response.id ?? state.lastResponseId,
  });

  for (let index = 0; index < 4; index += 1) {
    const functionCalls = getFunctionToolCalls(response);

    if (functionCalls.length === 0) {
      break;
    }

    const toolCallResults = await Promise.all(
      functionCalls.map((call) =>
        runFunctionToolCall(
          call,
          state,
          options.context,
          options.database,
          options.signal,
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
      responseId: response.id ?? state.lastResponseId,
    });

    response = await createLlmResponseWithRetries(
      client,
      toolCallResults.map((result) => result.toolOutput),
      tools,
      response.id,
      state,
      options,
      model,
      instructions,
      settings,
    );

    toolCallCount += getToolCallCount(response);
    await options.onProgress?.({
      toolCallCount,
      responseId: response.id ?? state.lastResponseId,
    });

    for (const tool of getCalledTools(response)) {
      calledTools.add(tool);
    }
  }

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
  const state: LlmRequestState = {
    lastResponseId: responseId ?? undefined,
    receivedResponse: false,
    sentImmediateContentFilterWarning: false,
    images: [],
  };
  const initialResponse = await createLlmResponseWithRetries(
    client,
    createInputMessage(request),
    tools,
    responseId ?? undefined,
    state,
    options,
    model,
    instructions,
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
      instructions,
      settings,
    );
  logDebug("Received response from LLM", formatResponseSummary(response));

  if (!response.output_text && getFunctionToolCalls(response).length > 0) {
    logDebug("LLM response still contains unresolved function calls", {
      response: formatResponseSummary(response),
    });
  }

  const citations = getCitations(response);
  const citationLinks = new Set(citations.map((citation) => citation.link));
  const sources = getWebSearchSourceLinks(response)
    .filter((link) => !citationLinks.has(link))
    .map((link) => ({ link }));
  const responseText = response.output_text || undefined;

  return {
    response_id: response.id ?? lastResponseId,
    handoff_agent_id: state.handoffAgentId,
    response: responseText,
    report: state.report,
    images: state.images,
    web_search: {
      used: calledTools.includes("web_search"),
      citations,
      sources,
    },
    tools: calledTools,
    tool_call_count: toolCallCount,
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
    { context, database, signal },
    agent.buildInstructions(),
    agent.MODEL,
  );

  const output = JSON.stringify({
    agent: agent.id,
    response: result.response ?? "",
    report_attached: Boolean(result.report),
    tools_used: result.tools,
    tool_call_count: result.tool_call_count,
    web_search: result.web_search.used,
  });

  if (result.report) {
    return {
      output,
      handoffAgentId: agent.id,
      report: result.report,
    };
  }

  return { output, handoffAgentId: agent.id };
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
