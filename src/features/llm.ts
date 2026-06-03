import { createDebug } from "@grammyjs/debug";
import OpenAI from "@openai/openai";
import { APP_ENV } from "./env.ts";
import { MAX_LAST_MESSAGES_COUNT, readLastMessages } from "./last-messages.ts";
import { search as searchMessages } from "./messages.ts";
import { fetchTickerPrice, getMarketsState } from "./stocks.ts";

export const TOOL_DEFINITIONS = {
  web_search: {
    type: "web_search",
    search_context_size: "high",
  },
  fetch_ticker_price: {
    type: "function",
    name: "fetch_ticker_price",
    description:
      "Fetch the latest available price details for a Stooq ticker, including open, high, low, close, and volume. For example AAPL.US or VUAA.UK.",
    parameters: {
      type: "object",
      properties: {
        ticker: {
          type: "string",
          description: "Stooq ticker symbol, for example AAPL.US or VUAA.UK.",
        },
      },
      required: ["ticker"],
      additionalProperties: false,
    },
    strict: true,
  },
  get_markets_state: {
    type: "function",
    name: "get_markets_state",
    description:
      "Get precomputed UK and US market session state. Returns current Europe/Prague and Europe/Kyiv times, each exchange's current state, next state, time until next state, next-state time in Prague/Kyiv, and the full regular weekday schedule localized to both Prague and Kyiv.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  search_chat: {
    type: "function",
    name: "search_chat",
    description:
      "Search remembered text messages in the current Telegram chat. The sender_id and date filters are optional; only use them when the user explicitly needs a sender or date range filter. Prefer using only queries.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          description:
            "One or more semantic search queries. Prefer concise natural-language queries, and include a sender name in the query when searching by name.",
          items: {
            type: "string",
          },
        },
        from: {
          type: "string",
          description:
            "Optional inclusive ISO 8601 start date. Only use when the user explicitly asks for a date or time range.",
        },
        to: {
          type: "string",
          description:
            "Optional inclusive ISO 8601 end date. Only use when the user explicitly asks for a date or time range.",
        },
        sender_id: {
          type: "number",
          description:
            "Optional Telegram sender id. Only use when the user explicitly gives or requires a sender id filter.",
        },
      },
      required: ["queries"],
      additionalProperties: false,
    },
    strict: false,
  },
  read_last_messages: {
    type: "function",
    name: "read_last_messages",
    description:
      "Read recent remembered text messages from the current Telegram chat. Use this when the user asks about the latest or surrounding chat context rather than semantic search. The count is capped at 300. If the user message is a reply, messages are read back from the replied-to message id; otherwise, from the current message id.",
    parameters: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description:
            "How many message ids to look back from the anchor message. Maximum is 300.",
          minimum: 1,
          maximum: MAX_LAST_MESSAGES_COUNT,
        },
      },
      required: ["count"],
      additionalProperties: false,
    },
    strict: true,
  },
  send_html_report: {
    type: "function",
    name: "send_html_report",
    description:
      "Attach a long research report as an HTML file. Use this only for long research purposes when the report is too large or rich for a normal chat reply. Put the full report in html_string and provide a short, descriptive filename. After using this tool, the normal assistant response must be only a very short caption for the attached report.",
    parameters: {
      type: "object",
      properties: {
        html_string: {
          type: "string",
          description:
            "The complete HTML report content to attach as a document. Should contain nice <style> tag.",
        },
        filename: {
          type: "string",
          description:
            "A short filename for the report. The bot will normalize it and ensure it uses the .html extension.",
        },
      },
      required: ["html_string", "filename"],
      additionalProperties: false,
    },
    strict: true,
  },
} as const;

export type ToolName = keyof typeof TOOL_DEFINITIONS;
type FunctionToolName =
  | "fetch_ticker_price"
  | "get_markets_state"
  | "search_chat"
  | "read_last_messages"
  | "send_html_report";

export type LlmToolContext = {
  chatId: number;
  messageId: number;
  replyMessageId?: number;
};

export type LlmProgress = {
  toolCallCount: number;
};

export type LlmRequestOptions = {
  context?: LlmToolContext;
  onProgress?: (progress: LlmProgress) => void | Promise<void>;
  onWarning?: (details: string) => void | Promise<void>;
};

export type LlmCitation = {
  start_index: number;
  end_index: number;
  link: string;
};

export type LlmSource = {
  link: string;
};

export type LlmHtmlReport = {
  htmlString: string;
  filename: string;
};

export type LlmResponse = {
  response_id?: string;
  response?: string;
  html_report?: LlmHtmlReport;
  web_search: {
    used: boolean;
    citations: LlmCitation[];
    sources: LlmSource[];
  };
  tools: ToolName[];
};

type ToolDefinition = (typeof TOOL_DEFINITIONS)[ToolName];

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

const logDebug = createDebug("app:llm:debug");
const logError = createDebug("app:llm:error");
const MAX_LLM_RETRIES = 3;

type LlmRequestState = {
  lastResponseId?: string;
  receivedResponse: boolean;
  sentImmediateContentFilterWarning: boolean;
  htmlReport?: LlmHtmlReport;
};

function getSystemInstructions(): string {
  const names = APP_ENV.NAMES.map((name) => JSON.stringify(name)).join(", ");

  return `
# You
You are an assistant named ${names} with a goal to provide a meaningful context in a chat.

# Tools
You have various tools at your disposal, whenever you need to use them, you must use a tool by name properly, not write parameters in a response to user.

# Responding
Respond to user in a meaningful, but concise way.
Always try to fit response in a short, informative message: try to say least possible extra words, respond purely with information requested.
Your goal is to provide as much factual data as possible.
For long research reports, use send_html_report. Put the report itself in html_string, and make your normal response only a very short caption for the attached report.

# Formatting
Full Markdown and HTML are NOT supported, you can ONLY use following small subset only when needed:
This formatting limitation applies to normal chat responses and captions, not to send_html_report html_string.
- <b> for bold
- <code lang=""> for code snippets
- <code> for code snippets without language
- <a href=""> for links (not citations, send citations normally)
- <blockquote> for quoted passages. Use <blockquote expandable> for longer citations.
Do not nest blockquotes.
Use regular dashes for lists.`;
}

function getClient(): OpenAI {
  return new OpenAI({
    apiKey: APP_ENV.LLM_API_KEY,
    baseURL: APP_ENV.LLM_BASE_URL,
  });
}

function getToolDefinitions(tools: ToolName[]): ToolDefinition[] {
  return tools.map((tool) => TOOL_DEFINITIONS[tool]);
}

function getResponseInclude(tools: ToolName[]) {
  return tools.includes("web_search")
    ? ["web_search_call.action.sources" as const]
    : undefined;
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
  return (
    tool === "fetch_ticker_price" ||
    tool === "get_markets_state" ||
    tool === "search_chat" ||
    tool === "read_last_messages" ||
    tool === "send_html_report"
  );
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

function parseOptionalDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function parseCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.min(MAX_LAST_MESSAGES_COUNT, Math.floor(value)));
}

function normalizeReportFilename(value: unknown): string {
  const rawFilename = typeof value === "string" ? value.trim() : "";
  const safeFilename = rawFilename
    .replaceAll(/[\\/]/g, "-")
    .replaceAll(/[^a-z0-9._ -]/gi, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  const filename = safeFilename || "research-report.html";

  return /\.html?$/i.test(filename) ? filename : `${filename}.html`;
}

function formatMessageLine(message: {
  date: string;
  sender_name: string;
  text: string;
}): string {
  const content = message.text.replaceAll(/\s+/g, " ").trim();
  return `[${message.date}] ${message.sender_name}: ${JSON.stringify(content)}`;
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

async function runFunctionToolCall(
  call: FunctionToolCall,
  state: LlmRequestState,
  context?: LlmToolContext,
): Promise<FunctionCallOutput> {
  const args = parseJsonObject(call.arguments);
  logDebug("Running tool call", formatToolCallLog(call));

  if (call.name === "fetch_ticker_price") {
    const ticker = typeof args?.ticker === "string" ? args.ticker.trim() : "";
    const priceDetails = ticker ? await fetchTickerPrice(ticker) : null;

    return createToolOutput(call, JSON.stringify({ ticker, priceDetails }));
  }

  if (call.name === "get_markets_state") {
    return createToolOutput(call, JSON.stringify(getMarketsState()));
  }

  if (call.name === "search_chat") {
    if (!context) {
      return createToolOutput(
        call,
        "Cannot search chat: current chat context is unavailable.",
      );
    }

    const queries = Array.isArray(args?.queries)
      ? args.queries.filter(
          (query): query is string => typeof query === "string",
        )
      : [];
    const results = await searchMessages({
      queries,
      from: parseOptionalDate(args?.from),
      to: parseOptionalDate(args?.to),
      chatId: context.chatId,
      senderId: parseOptionalNumber(args?.sender_id),
      limit: 20,
    });

    return createToolOutput(
      call,
      results.length > 0
        ? results.map(formatMessageLine).join("\n")
        : "No matching chat messages found.",
    );
  }

  if (call.name === "read_last_messages") {
    if (!context) {
      return createToolOutput(
        call,
        "Cannot read last messages: current chat context is unavailable.",
      );
    }

    const anchorMessageId = context.replyMessageId ?? context.messageId;
    const messages = await readLastMessages(parseCount(args?.count), {
      chatId: context.chatId,
      messageId: anchorMessageId,
    });

    return createToolOutput(
      call,
      messages.length > 0
        ? messages.map(formatMessageLine).join("\n")
        : "No remembered text messages found in that message range.",
    );
  }

  if (call.name === "send_html_report") {
    const htmlString =
      typeof args?.html_string === "string" ? args.html_string : "";
    const filename = normalizeReportFilename(args?.filename);

    if (!htmlString.trim()) {
      return createToolOutput(
        call,
        JSON.stringify({ error: "html_string must not be empty." }),
      );
    }

    state.htmlReport = {
      htmlString,
      filename,
    };

    return createToolOutput(
      call,
      "HTML report accepted. Final response must be only a very short caption for the attached report.",
    );
  }

  return createToolOutput(
    call,
    JSON.stringify({ error: `Unknown tool: ${call.name}` }),
  );
}

async function createLlmResponse(
  client: OpenAI,
  input: string | FunctionCallOutput[],
  tools: ToolName[],
  responseId?: string | null,
): Promise<ApiResponse> {
  return await client.responses.create({
    model: APP_ENV.LLM_MODEL,
    input,
    instructions: getSystemInstructions(),
    // temperature: APP_ENV.LLM_TEMPERATURE,
    tools: getToolDefinitions(tools),
    tool_choice: "auto",
    include: getResponseInclude(tools),
    previous_response_id: responseId == null ? undefined : responseId,
    reasoning: {
      effort: "high",
    },
  });
}

async function createLlmResponseWithRetries(
  client: OpenAI,
  input: string | FunctionCallOutput[],
  tools: ToolName[],
  responseId: string | undefined,
  state: LlmRequestState,
  options: LlmRequestOptions = {},
): Promise<ApiResponse> {
  let lastError: unknown;
  let currentResponseId = responseId;

  for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt += 1) {
    const immediate = !state.receivedResponse;

    try {
      const response = await createLlmResponse(
        client,
        input,
        tools,
        currentResponseId,
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
      const contentFiltered = isContentFilterError(error);
      logError("LLM response step failed", {
        attempt,
        immediate,
        retrying: attempt < MAX_LLM_RETRIES && (!immediate || contentFiltered),
        responseId: currentResponseId,
        lastResponseId: state.lastResponseId,
        error,
      });

      if (immediate && contentFiltered) {
        if (!state.sentImmediateContentFilterWarning) {
          state.sentImmediateContentFilterWarning = true;
          await options.onWarning?.(getErrorDetail(error));
        }

        if (attempt >= MAX_LLM_RETRIES) {
          break;
        }

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

      if (attempt >= MAX_LLM_RETRIES) {
        break;
      }
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
): Promise<{
  response: ApiResponse;
  calledTools: ToolName[];
  lastResponseId?: string;
}> {
  const calledTools = new Set(getCalledTools(initialResponse));
  let toolCallCount = getToolCallCount(initialResponse);
  let response = initialResponse;
  await options.onProgress?.({ toolCallCount });

  for (let index = 0; index < 4; index += 1) {
    const functionCalls = getFunctionToolCalls(response);

    if (functionCalls.length === 0) {
      break;
    }

    const toolOutputs = await Promise.all(
      functionCalls.map((call) =>
        runFunctionToolCall(call, state, options.context),
      ),
    );

    response = await createLlmResponseWithRetries(
      client,
      toolOutputs,
      tools,
      response.id,
      state,
      options,
    );

    toolCallCount += getToolCallCount(response);
    await options.onProgress?.({ toolCallCount });

    for (const tool of getCalledTools(response)) {
      calledTools.add(tool);
    }
  }

  return {
    response,
    calledTools: [...calledTools],
    lastResponseId: state.lastResponseId,
  };
}

export async function requestLlm(
  request: string,
  tools: ToolName[],
  responseId?: string | null,
  options: LlmRequestOptions = {},
): Promise<LlmResponse> {
  logDebug("Sending request to LLM", { tools, responseId });
  const client = getClient();
  const state: LlmRequestState = {
    lastResponseId: responseId ?? undefined,
    receivedResponse: false,
    sentImmediateContentFilterWarning: false,
  };
  const initialResponse = await createLlmResponseWithRetries(
    client,
    request,
    tools,
    responseId ?? undefined,
    state,
    options,
  );

  const { response, calledTools, lastResponseId } =
    await resolveFunctionToolCalls(
      client,
      initialResponse,
      tools,
      options,
      state,
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
    response: responseText,
    html_report: state.htmlReport,
    web_search: {
      used: calledTools.includes("web_search"),
      citations,
      sources,
    },
    tools: calledTools,
  };
}
