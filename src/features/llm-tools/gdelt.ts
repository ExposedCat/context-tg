import { createDebug } from "@grammyjs/debug";
import type { FunctionToolRunner } from "./types.ts";

const API_URL = "https://api.gdeltproject.org/api/v2/context/context";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ARTICLES = 25;

type GdeltContextArticle = {
  context?: unknown;
  sentence?: unknown;
  title?: unknown;
  url?: unknown;
  seendate?: unknown;
};

const logError = createDebug("app:llm-tools:gdelt:error");

export const toolDefinition = {
  type: "function",
  name: "get_recent_news",
  description:
    "Get recent news article snippets from GDELT for the last 24 hours. The query must contain at least two words; use precise natural-language phrases rather than one-word terms.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'News search query with at least two words, for example "Tesla earnings", "Ukraine peace talks", or "OpenAI model release".',
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  strict: true,
} as const;

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getQueryWordCount(query: string): number {
  return query.split(/\s+/).filter(Boolean).length;
}

function compactArticle(article: GdeltContextArticle) {
  return {
    context: getString(article.context),
    sentence: getString(article.sentence),
    title: getString(article.title),
    url: getString(article.url),
    date: getString(article.seendate),
  };
}

function getArticles(response: unknown) {
  if (
    typeof response !== "object" ||
    response === null ||
    !("articles" in response) ||
    !Array.isArray(response.articles)
  ) {
    return [];
  }

  return response.articles
    .filter(
      (article): article is GdeltContextArticle =>
        typeof article === "object" && article !== null,
    )
    .slice(0, MAX_ARTICLES)
    .map(compactArticle);
}

async function fetchRecentNews(query: string) {
  const url = new URL(API_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("timespan", "24h");
  url.searchParams.set("maxrecords", String(MAX_ARTICLES));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`GDELT returned HTTP ${response.status}: ${text}`);
    }

    try {
      return getArticles(JSON.parse(text) as unknown);
    } catch {
      throw new Error(
        `GDELT returned non-JSON response: ${text.slice(0, 200)}`,
      );
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

export const execute: FunctionToolRunner = async (args) => {
  const query = getString(args?.query);
  if (getQueryWordCount(query) < 2) {
    return JSON.stringify([]);
  }

  try {
    return JSON.stringify(await fetchRecentNews(query));
  } catch (error) {
    logError("Failed to fetch recent news", {
      query,
      error,
    });

    return JSON.stringify([]);
  }
};
