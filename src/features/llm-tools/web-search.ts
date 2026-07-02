import { createDebug } from "@grammyjs/debug";
import { APP_ENV } from "../env.ts";
import type { FunctionToolRunner } from "./types.ts";
import { asRecord, getString } from "./utils.ts";

const API_URL = "https://api.keenable.ai/v1/search";
const REQUEST_TIMEOUT_MS = 5_000;

const logError = createDebug("app:llm-tools:web-search:error");

export const toolDefinition = {
  type: "function",
  name: "web_search",
  description:
    "Search the web for current facts, recent information, source links, and verification. Returns a JSON array of search result objects.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The web search query.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  strict: true,
} as const;

function getSearchResults(payload: unknown): Record<string, unknown>[] {
  const response = asRecord(payload);
  const results = response?.results;

  if (!Array.isArray(results)) {
    return [];
  }

  return results.flatMap((result) => {
    const item = asRecord(result);

    if (!item) {
      return [];
    }

    const { acquired_at: _acquiredAt, ...searchResult } = item;
    return [searchResult];
  });
}

async function searchWeb(
  query: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeoutId = setTimeout(abort, REQUEST_TIMEOUT_MS);

  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "X-API-Key": APP_ENV.KEENABLE_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(
        `Keenable search returned non-JSON response: ${text.slice(0, 200)}`,
      );
    }

    if (!response.ok) {
      const payloadRecord = asRecord(payload);
      const errorRecord = asRecord(payloadRecord?.error);
      const message =
        getString(payloadRecord?.error) ||
        getString(errorRecord?.message) ||
        text.slice(0, 200);

      throw new Error(
        `Keenable search returned HTTP ${response.status}: ${message}`,
      );
    }

    return getSearchResults(payload);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abort);
  }
}

export const execute: FunctionToolRunner = async (args, _context, options) => {
  const query = getString(args?.query);

  if (!query) {
    return JSON.stringify([], null, 2);
  }

  try {
    const results = await searchWeb(query, options?.signal);
    return JSON.stringify(results, null, 2);
  } catch (error) {
    if (options?.signal?.aborted) {
      throw error;
    }

    logError("Failed to search web", { query, error });
    return JSON.stringify([], null, 2);
  }
};
