import { createDebug } from "@grammyjs/debug";
import { APP_ENV } from "../env.ts";
import { downloadTelegramImageDataUrl, getImageById } from "../images.ts";
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
    "Load one image into vision so you can inspect its actual visual content. Pass either the direct image_url returned by search_images or the exact saved image ID from a tg://photo Markdown reference. Do not pass source_url or thumbnail_url.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The direct image_url returned by search_images.",
      },
      id: {
        type: "string",
        description:
          "The exact saved image ID from ![](tg://photo?id=IMAGE_ID).",
      },
    },
    anyOf: [{ required: ["url"] }, { required: ["id"] }],
    additionalProperties: false,
  },
  strict: false,
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

export const executeReadImage: FunctionToolRunner = async (
  args,
  _context,
  options,
) => {
  const rawUrl = getString(args?.url);
  const imageId = getString(args?.id);

  if (rawUrl && imageId) {
    return getJsonError(
      "Cannot read image: provide either url or id, not both.",
    );
  }

  const url = getHttpUrl(rawUrl);

  if (rawUrl && !url) {
    return getJsonError(
      "Cannot read image: url must be a direct HTTP(S) image URL from search_images.",
    );
  }

  if (url) {
    return {
      output: JSON.stringify({ image_url: url, loaded: true }),
      inputImages: [{ image_url: url, detail: "auto" }],
    };
  }

  if (!imageId) {
    return getJsonError(
      "Cannot read image: provide a direct HTTP(S) url or saved image id.",
    );
  }

  if (!options?.database || !options.api) {
    return getJsonError(
      "Cannot read saved image: database or Telegram API is unavailable.",
    );
  }

  const image = await getImageById(options.database, imageId);

  if (!image) {
    return getJsonError(
      `Cannot read image: unknown saved image id ${imageId}.`,
    );
  }

  const dataUrl = await downloadTelegramImageDataUrl(
    options.api,
    image.file_id,
    "image/jpeg",
    options.signal,
  );

  return {
    output: JSON.stringify({ image_id: image.id, loaded: true }),
    inputImages: [{ image_url: dataUrl, detail: "auto" }],
  };
};
