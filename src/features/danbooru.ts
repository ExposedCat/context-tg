import { APP_ENV } from "./env.ts";

const API_URL = "https://danbooru.donmai.us";
const REQUEST_TIMEOUT_MS = 20_000;

async function request(
  path: string,
  parameters: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const url = new URL(path, API_URL);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "context-tg (Danbooru search)",
  };
  const apiKey = APP_ENV.DANBOORU_TOKEN ?? APP_ENV.DANBOORU_API_KEY;
  if (APP_ENV.DANBOORU_USERNAME || apiKey) {
    if (!APP_ENV.DANBOORU_USERNAME || !apiKey) {
      throw new Error(
        "Danbooru authentication requires DANBOORU_USERNAME and either DANBOORU_TOKEN or DANBOORU_API_KEY. Leave all unset for public searches.",
      );
    }
    headers.Authorization = `Basic ${btoa(`${APP_ENV.DANBOORU_USERNAME}:${apiKey}`)}`;
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const body = await response.text();
    let error: { error?: string; message?: unknown } | null = null;
    try {
      error = JSON.parse(body);
    } catch {
      // Preserve the original response when the API returns a non-JSON error.
    }
    if (
      response.status === 422 &&
      error?.error === "PostQuery::TagLimitError"
    ) {
      const message =
        typeof error.message === "string"
          ? error.message
          : "The query exceeds this account's search-term limit.";
      throw new Error(
        `Danbooru returned HTTP 422 (PostQuery::TagLimitError): ${message} Retry with fewer search terms. Tags, excluded tags, wildcards, and order: count toward the limit; rating: does not. Keep the user's rating/order overrides and simplify the other terms.`,
      );
    }
    throw new Error(
      `Danbooru returned HTTP ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Danbooru returned an unexpected response.");
  }
  return payload.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

export async function searchDanbooruPosts(
  tags: string,
  limit: number,
  page: number,
  signal?: AbortSignal,
) {
  const posts = await request(
    "/posts.json",
    {
      tags,
      limit: String(limit),
      page: String(page),
    },
    signal,
  );
  return posts.slice(0, limit).map((post) => ({
    id: post.id,
    source_url: `${API_URL}/posts/${post.id}`,
    image_url: post.large_file_url ?? post.file_url,
    file_url: post.file_url,
    thumbnail_url: post.preview_file_url,
    rating: post.rating,
    score: post.score,
    tags: post.tag_string,
    artist: post.tag_string_artist,
    characters: post.tag_string_character,
    copyright: post.tag_string_copyright,
    original_source: post.source,
    width: post.image_width,
    height: post.image_height,
    file_ext: post.file_ext,
  }));
}

export async function searchDanbooruTags(
  query: string,
  limit: number,
  signal?: AbortSignal,
) {
  const tags = await request(
    "/tags.json",
    {
      "search[name_matches]": query,
      "search[order]": "count",
      "search[hide_empty]": "yes",
      limit: String(limit),
    },
    signal,
  );
  return tags.slice(0, limit).map((tag) => ({
    name: tag.name,
    category: tag.category,
    post_count: tag.post_count,
    is_deprecated: tag.is_deprecated,
  }));
}
