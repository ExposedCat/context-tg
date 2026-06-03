import type {
  FunctionToolResult,
  FunctionToolRunner,
  LlmToolContext,
} from "./types.ts";

export type DeepResearchRequest = {
  task: string;
  focus: string[];
  instructions: string[];
  recentNewsQueries: string[];
  webSearchQueries: string[];
};

export type DeepResearchDelegate = (
  request: DeepResearchRequest,
  context?: LlmToolContext,
) => Promise<FunctionToolResult>;

export const USAGE_LABEL = "Delegating research...";

export const toolDefinition = {
  type: "function",
  name: "generate_deep_research",
  description:
    "Delegate a substantial research task to a researcher sub-agent. Use this when the user asks for deep research, extensive investigation, synthesis, or a rich report. Before calling this tool, design exactly 10 distinct recent-news queries and exactly 10 distinct web-search queries that would gather the needed information. Recent-news queries are searched automatically before delegation; the researcher receives those prepared results and must run web_search for each provided web-search query. After using this tool, provide a 2-3 sentence TL;DR of the attached report.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "A specific general task for the researcher to complete. State what should be investigated and what output is needed.",
      },
      focus: {
        type: "array",
        description:
          "Specific aspects, questions, entities, sources, tradeoffs, or angles the researcher should focus on.",
        items: {
          type: "string",
        },
      },
      instructions: {
        type: "array",
        description:
          "Additional instructions for the researcher, including constraints, audience, format preferences, time horizon, source standards, or decision criteria.",
        items: {
          type: "string",
        },
      },
      recent_news_queries: {
        type: "array",
        description:
          "Exactly 10 distinct recent-news queries for get_recent_news. Each query must contain at least two words and target fresh 24-hour news coverage from a different angle.",
        minItems: 10,
        maxItems: 10,
        items: {
          type: "string",
        },
      },
      web_search_queries: {
        type: "array",
        description:
          "Exactly 10 distinct web-search queries the delegated researcher must run with web_search. Cover different source types and angles such as primary sources, filings, analyst context, timeline, criticism, risks, market/sector context, and recent commentary.",
        minItems: 10,
        maxItems: 10,
        items: {
          type: "string",
        },
      },
    },
    required: [
      "task",
      "focus",
      "instructions",
      "recent_news_queries",
      "web_search_queries",
    ],
    additionalProperties: false,
  },
  strict: true,
} as const;

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getRequest(args: Record<string, unknown> | null): DeepResearchRequest {
  return {
    task: typeof args?.task === "string" ? args.task.trim() : "",
    focus: normalizeStringArray(args?.focus),
    instructions: normalizeStringArray(args?.instructions),
    recentNewsQueries: normalizeStringArray(args?.recent_news_queries),
    webSearchQueries: normalizeStringArray(args?.web_search_queries),
  };
}

function hasDistinctItems(values: string[]): boolean {
  return (
    new Set(values.map((value) => value.toLocaleLowerCase())).size ===
    values.length
  );
}

function hasAtLeastTwoWords(value: string): boolean {
  return value.split(/\s+/).filter(Boolean).length >= 2;
}

export function createRunner(
  delegate: DeepResearchDelegate,
): FunctionToolRunner {
  return async (args, context) => {
    const request = getRequest(args);

    if (!request.task) {
      return JSON.stringify({ error: "task must not be empty." });
    }

    if (
      request.recentNewsQueries.length !== 10 ||
      !hasDistinctItems(request.recentNewsQueries) ||
      !request.recentNewsQueries.every(hasAtLeastTwoWords)
    ) {
      return JSON.stringify({
        error:
          "recent_news_queries must contain exactly 10 distinct queries, each with at least two words.",
      });
    }

    if (
      request.webSearchQueries.length !== 10 ||
      !hasDistinctItems(request.webSearchQueries) ||
      !request.webSearchQueries.every(hasAtLeastTwoWords)
    ) {
      return JSON.stringify({
        error:
          "web_search_queries must contain exactly 10 distinct queries, each with at least two words.",
      });
    }

    const result = await delegate(request, context);

    return {
      output: result.output,
      htmlReport: result.htmlReport,
    };
  };
}
