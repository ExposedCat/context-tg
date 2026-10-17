import { searchDanbooruPosts, searchDanbooruTags } from "../danbooru.ts";
import { isExplicitDanbooruRating } from "../danbooru-options.ts";
import type { FunctionToolRunner } from "./types.ts";
import { getJsonError, getString } from "./utils.ts";

export const toolDefinition = {
  type: "function",
  name: "search_danbooru",
  description:
    "Search Danbooru for anime, manga, fan art, and other tagged illustrations. Always prefer Danbooru for anime image searches. Use when the user asks for Danbooru or says '(use danbooru)'. Basic usage: tags='1boy', rating='g', order='score'. Tags are space-separated, multiword tags use underscores (blue_hair), and -tag excludes a tag. Use search_danbooru_tags to discover exact tag names. Ratings: general (g), sensitive (s), questionable (q), explicit (e); order examples: score, rank, id, random. Omitted rating keeps any rating metatag in tags, otherwise uses Danbooru defaults. If the final query has no ordering, order:score is added automatically; explicit ordering in tags or parameters is preserved. User-supplied suffix options are applied by the application and override your rating/order, including metatags in tags. Returns post URLs, direct image_url values, ratings, scores, and tags. For explicit-rated results (e or explicit), do not call read_image or view the images yourself: send them directly and notify the user that you have not viewed them. For other ratings, inspect a selected image with read_image before describing it. Display images using ![](image_url). You must provide the corresponding source_url link for every image you send, including every image in a collage or slideshow.",
  parameters: {
    type: "object",
    properties: {
      tags: {
        type: "string",
        description:
          "Danbooru tag query, e.g. 'pigeon'. Use tags rather than a natural-language sentence.",
      },
      rating: {
        type: "string",
        description:
          "Optional rating metatag value, passed to Danbooru unchanged, e.g. 'g' or 's'.",
      },
      order: {
        type: "string",
        description:
          "Optional order metatag value, passed to Danbooru unchanged, e.g. 'score' (highest first), 'rank', 'id' (newest), or 'random'. Defaults to score when no ordering appears in the final query.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Number of posts, default 10, maximum 20.",
      },
      page: {
        type: "integer",
        minimum: 1,
        description: "Results page, default 1.",
      },
    },
    required: ["tags"],
    additionalProperties: false,
  },
  strict: false,
} as const;

export const tagsToolDefinition = {
  type: "function",
  name: "search_danbooru_tags",
  description:
    "Look up Danbooru tag names before searching posts. Basic usage: query='*pigeon*' or 'blue_hair'; * matches any text, and multiword tags use underscores. Returns matching names ordered by post count, plus category (0 general, 1 artist, 3 copyright, 4 character, 5 metadata). Use the returned exact names with search_danbooru.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Tag name or wildcard pattern, e.g. '*pigeon*'.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Number of tags, default 10, maximum 20.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  strict: false,
} as const;

function getInteger(
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(1, Math.min(max, value))
    : fallback;
}

export const execute: FunctionToolRunner = async (args, context, options) => {
  let tags = getString(args?.tags);
  if (!tags) return getJsonError("Provide a Danbooru tag query.");

  const rating = context?.danbooru?.rating ?? getString(args?.rating);
  const order = context?.danbooru?.order ?? getString(args?.order);
  if (rating) {
    tags = tags.replace(/(^|\s)[-~]?rating:\S+/gi, "$1");
    tags += ` rating:${rating}`;
  }
  if (order) {
    tags = tags.replace(
      /(^|\s)[-~]?(?:order|ordfav|ordvote|ordfavgroup|ordpool):\S+/gi,
      "$1",
    );
    tags += ` order:${order}`;
  } else if (
    !/(?:^|\s)(?:order|ordfav|ordvote|ordfavgroup|ordpool):\S+/i.test(tags)
  ) {
    tags += " order:score";
  }
  tags = tags.trim().replace(/\s+/g, " ");
  const limit = getInteger(args?.limit, 10, 20);
  const page = getInteger(args?.page, 1);
  const posts = await searchDanbooruPosts(tags, limit, page, options?.signal);
  const explicitQuery = [...tags.matchAll(/(?:^|\s)rating:(\S+)/gi)].some(
    (match) => isExplicitDanbooruRating(match[1]),
  );
  const skipImageInspection =
    explicitQuery ||
    posts.some((post) => isExplicitDanbooruRating(post.rating));
  return JSON.stringify({
    tags: explicitQuery ? "" : tags,
    page,
    posts: posts.map((post) =>
      explicitQuery || isExplicitDanbooruRating(post.rating)
        ? { ...post, tags: "", rating: "g", copyright: "" }
        : post,
    ),
    ...(skipImageInspection
      ? {
          skip_image_inspection: true,
          instructions:
            "Do not view or inspect these images yourself. Send them directly to the user with their source links and notify the user that you have not viewed them.",
        }
      : {}),
  });
};

export const executeTags: FunctionToolRunner = async (
  args,
  _context,
  options,
) => {
  const query = getString(args?.query);
  if (!query)
    return getJsonError("Provide a Danbooru tag name or wildcard pattern.");
  return JSON.stringify(
    await searchDanbooruTags(
      query,
      getInteger(args?.limit, 10, 20),
      options?.signal,
    ),
  );
};
