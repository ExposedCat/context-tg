import { createDebug } from "@grammyjs/debug";
import { APP_ENV } from "../env.ts";
import type { FunctionToolRunner } from "./types.ts";
import { asRecord, getJsonError, getString } from "./utils.ts";

const SEARCH_REQUEST_TIMEOUT_MS = 20_000;
const MAX_IMAGE_SEARCH_RESULTS = 10;
const IMAGE_SEARCH_ENGINES = [
  "google images",
  "brave.images",
  "bing images",
  "duckduckgo images",
] as const;
const logError = createDebug("app:llm-tools:image-search:error");

export const toolDefinition = {
  type: "function",
  name: "search_images",
  description:
    "Search multiple image search providers for relevant images. Returns successful results as a JSON array with direct image_url values and their source pages; failed providers are ignored. Always inspect a relevant result with read_image before making claims about what the image contains.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The image search query. Prefer a focused query in English.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  strict: true,
} as const;

export const readImageToolDefinition = {
  type: "function",
  name: "read_image",
  description:
    "Load one image result into vision so you can inspect its actual visual content. Use the image_url returned by search_images, not the source_url or thumbnail_url.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The direct image_url returned by search_images.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  strict: true,
} as const;

export const sendImageToolDefinition = {
  type: "function",
  name: "send_image",
  description:
    "Send one existing image to the chat by its direct HTTP(S) URL. Use this when the user asks to see or receive an existing image. For search results, use an image_url from search_images and inspect it with read_image first.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "The direct HTTP(S) URL of the existing image to attach. For image search results, use image_url rather than source_url or thumbnail_url.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  strict: true,
} as const;

function getSearchApiUrl(): URL {
  return new URL(`${APP_ENV.SEARXNG_URL.replace(/\/+$/, "")}/search`);
}

function getHttpUrl(value: unknown): string | undefined {
  const text = getString(value);

  if (!text) {
    return undefined;
  }

  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function getOptionalField(value: unknown): string | undefined {
  return getString(value) || undefined;
}

function getImageSearchResults(payload: unknown): Record<string, unknown>[] {
  const results = asRecord(payload)?.results;

  if (!Array.isArray(results)) {
    return [];
  }

  return results
    .flatMap((result) => {
      const item = asRecord(result);
      const imageUrl = getHttpUrl(item?.img_src);

      if (!item || !imageUrl) {
        return [];
      }

      return [
        {
          title: getOptionalField(item.title),
          content: getOptionalField(item.content),
          source: getOptionalField(item.source),
          source_url: getHttpUrl(item.url),
          image_url: imageUrl,
          thumbnail_url: getHttpUrl(item.thumbnail_src),
          resolution: getOptionalField(item.resolution),
          author: getOptionalField(item.author),
        },
      ];
    })
    .slice(0, MAX_IMAGE_SEARCH_RESULTS);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function searchImages(
  query: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const apiUrl = getSearchApiUrl();
  apiUrl.searchParams.set("q", query);
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("categories", "images");
  apiUrl.searchParams.set("engines", IMAGE_SEARCH_ENGINES.join(","));

  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeoutId = setTimeout(abort, SEARCH_REQUEST_TIMEOUT_MS);

  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  try {
    const response = await fetch(apiUrl, {
      headers: {
        Accept: "application/json",
        "X-Real-IP": "127.0.0.1",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(
        `SearXNG returned a non-JSON response: ${text.slice(0, 200)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `SearXNG returned HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    return getImageSearchResults(payload);
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
    const results = await searchImages(query, options?.signal);
    return JSON.stringify(results, null, 2);
  } catch (error) {
    if (options?.signal?.aborted) {
      throw error;
    }

    if (isAbortError(error)) {
      return JSON.stringify([], null, 2);
    }

    logError("Failed to search images", { query, error });
    return JSON.stringify([], null, 2);
  }
};

export const executeReadImage: FunctionToolRunner = (args) => {
  const url = getHttpUrl(args?.url);

  if (!url) {
    return getJsonError(
      "Cannot read image: url must be a direct HTTP(S) image URL from search_images.",
    );
  }

  return {
    output: JSON.stringify({ image_url: url, loaded: true }),
    inputImages: [{ image_url: url, detail: "auto" }],
  };
};

export const executeSendImage: FunctionToolRunner = (args) => {
  const url = getHttpUrl(args?.url);

  if (!url) {
    return getJsonError(
      "Cannot send image: url must be a direct HTTP(S) image URL.",
    );
  }

  return {
    output: JSON.stringify({
      sent_image: { attached: true, url },
    }),
    image: {
      prompt: "Existing image sent by URL.",
      url,
    },
  };
};
