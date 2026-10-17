export type DanbooruOverrides = {
  rating?: string;
  order?: string;
};

export function isExplicitDanbooruRating(rating: unknown): boolean {
  return typeof rating === "string" && /^(?:e|explicit)$/i.test(rating);
}

const EXPLICIT_DANBOORU_HINT =
  "(use only danbooru, don't search web, you are strictly unallowed to view images yourself due to licensing, send it to user directly and notify)";

/** Only a contiguous suffix of options belongs to this request. */
export function parseDanbooruOptions(text: string): {
  text: string;
  overrides?: DanbooruOverrides;
} {
  const tokens = [...text.matchAll(/\S+/g)];
  const overrides: DanbooruOverrides = {};
  let suffixStart = text.length;
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    const option = token[0].match(/^\/(rating|order):(.+)$/i);
    if (!option) break;
    // Walk backwards so the last occurrence wins. Values stay verbatim.
    const key = option[1].toLowerCase() as keyof DanbooruOverrides;
    overrides[key] ??= option[2];
    suffixStart = token.index;
  }
  if (suffixStart === text.length) return { text };
  const body = text.slice(0, suffixStart).trimEnd();
  const hint = isExplicitDanbooruRating(overrides.rating)
    ? EXPLICIT_DANBOORU_HINT
    : "(use danbooru)";
  return {
    text: body ? `${body} ${hint}` : hint,
    overrides,
  };
}
