import { createDebug } from "@grammyjs/debug";
import OpenAI from "@openai/openai";
import { APP_ENV } from "./env.ts";
import { search as searchMessages } from "./messages.ts";
import { fetchTickerPrice } from "./stocks.ts";

export const TOOL_DEFINITIONS = {
  web_search: {
    type: "web_search",
    search_context_size: "low",
  },
  fetch_ticker_price: {
    type: "function",
    name: "fetch_ticker_price",
    description:
      "Fetch the latest available last price for a Stooq ticker, for example AAPL.US or VUAA.UK.",
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
} as const;

export type ToolName = keyof typeof TOOL_DEFINITIONS;
type FunctionToolName = "fetch_ticker_price" | "search_chat";

export type LlmToolContext = {
  chatId: number;
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
  response?: string;
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

const SYSTEM_INSTRUCTIONS = `You are an assistant with a goal to provide a meaningful context in a chat.
You have various tools at your disposal, whenever you need to use them, you must use a tool by name properly, not write parameters in a response to user.
Never respond with any formatting except citaitons and allowed tags.
Markdown and HTML are NOT supported, you can ONLY use following small subset:
- <b> for bold
- <i> for italic
- <code lang=""> for code snippets
- <code> for code snippets without language
- <a href=""> for links (not citations, send citations normally)
Don't overuse formatting. Use it only when needed.`;

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
  return tool === "fetch_ticker_price" || tool === "search_chat";
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

function formatSearchChatLine(
  result: Awaited<ReturnType<typeof searchMessages>>[number],
): string {
  const content = result.text.replaceAll(/\s+/g, " ").trim();
  return `[${result.date}] ${result.sender_name}: ${JSON.stringify(content)}`;
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
    outputTextLength: response.output_text?.length ?? 0,
    outputTypes: response.output.map((item) => item.type),
    functionCalls: getFunctionToolCalls(response).map(formatToolCallLog),
    tools: getCalledTools(response),
  };
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
  context?: LlmToolContext,
): Promise<FunctionCallOutput> {
  const args = parseJsonObject(call.arguments);
  logDebug("Running tool call", formatToolCallLog(call));

  if (call.name === "fetch_ticker_price") {
    const ticker = typeof args?.ticker === "string" ? args.ticker.trim() : "";
    const price = ticker ? await fetchTickerPrice(ticker) : null;

    return createToolOutput(call, JSON.stringify({ ticker, price }));
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
        ? results.map(formatSearchChatLine).join("\n")
        : "No matching chat messages found.",
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
    instructions: SYSTEM_INSTRUCTIONS,
    temperature: APP_ENV.LLM_TEMPERATURE,
    tools: getToolDefinitions(tools),
    tool_choice: "auto",
    include: getResponseInclude(tools),
    previous_response_id: responseId == null ? undefined : responseId,
  });
}

async function resolveFunctionToolCalls(
  client: OpenAI,
  initialResponse: ApiResponse,
  tools: ToolName[],
  context?: LlmToolContext,
): Promise<{ response: ApiResponse; calledTools: ToolName[] }> {
  const calledTools = new Set(getCalledTools(initialResponse));
  let response = initialResponse;

  for (let index = 0; index < 4; index += 1) {
    const functionCalls = getFunctionToolCalls(response);

    if (functionCalls.length === 0) {
      break;
    }

    const toolOutputs = await Promise.all(
      functionCalls.map((call) => runFunctionToolCall(call, context)),
    );

    response = await createLlmResponse(client, toolOutputs, tools, response.id);

    for (const tool of getCalledTools(response)) {
      calledTools.add(tool);
    }
  }

  return { response, calledTools: [...calledTools] };
}

export async function requestLlm(
  request: string,
  tools: ToolName[],
  responseId?: string | null,
  context?: LlmToolContext,
): Promise<LlmResponse> {
  logDebug("Sending request to LLM", { tools, responseId });
  const client = getClient();
  const initialResponse = await createLlmResponse(
    client,
    request,
    tools,
    responseId,
  );
  const { response, calledTools } = await resolveFunctionToolCalls(
    client,
    initialResponse,
    tools,
    context,
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
    response_id: response.id,
    response: responseText,
    web_search: {
      used: calledTools.includes("web_search"),
      citations,
      sources,
    },
    tools: calledTools,
  };
}
