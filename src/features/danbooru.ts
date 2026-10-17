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
  if (APP_ENV.DANBOORU_USERNAME || APP_ENV.DANBOORU_API_KEY) {
    if (!APP_ENV.DANBOORU_USERNAME || !APP_ENV.DANBOORU_API_KEY) {
      throw new Error(
        "Set both DANBOORU_USERNAME and DANBOORU_API_KEY, or neither.",
      );
    }
    headers.Authorization = `Basic ${btoa(`${APP_ENV.DANBOORU_USERNAME}:${APP_ENV.DANBOORU_API_KEY}`)}`;
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    throw new Error(
      `Danbooru returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
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
