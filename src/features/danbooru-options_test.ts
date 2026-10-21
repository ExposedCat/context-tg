import { test } from "bun:test";
import { deepStrictEqual } from "node:assert";
import { parseDanbooruOptions } from "./danbooru-options.ts";

test("Danbooru suffix options produce one hint and preserve unvalidated values", () => {
  deepStrictEqual(
    parseDanbooruOptions(
      "Hey agent find me anime boy /rating:hot /order:score",
    ),
    {
      text: "Hey agent find me anime boy (use danbooru)",
      overrides: { rating: "hot", order: "score" },
    },
  );
  deepStrictEqual(
    parseDanbooruOptions("Hey agent find me a pigeon art /order:score"),
    {
      text: "Hey agent find me a pigeon art (use danbooru)",
      overrides: { order: "score" },
    },
  );
  deepStrictEqual(parseDanbooruOptions("art /RATING:Unknown:Value"), {
    text: "art (use danbooru)",
    overrides: { rating: "Unknown:Value" },
  });
});

test("Danbooru options accept either order, trailing whitespace, and repeated options", () => {
  deepStrictEqual(
    parseDanbooruOptions("art\n/order:random /rating:g /order:score \n"),
    {
      text: "art (use danbooru)",
      overrides: { order: "score", rating: "g" },
    },
  );
  deepStrictEqual(parseDanbooruOptions("/order:score"), {
    text: "(use danbooru)",
    overrides: { order: "score" },
  });
});

test("explicit rating aliases use the direct-send hint and preserve raw overrides", () => {
  const hint =
    "(use only danbooru, don't search web, you are strictly unallowed to view images yourself due to licensing, send it to user directly and notify)";
  for (const rating of ["explicit", "e", "EXPLICIT", "E"]) {
    deepStrictEqual(
      parseDanbooruOptions(`find art /rating:${rating} /order:score`),
      {
        text: `find art ${hint}`,
        overrides: { rating, order: "score" },
      },
    );
  }
  deepStrictEqual(parseDanbooruOptions("/rating:e"), {
    text: hint,
    overrides: { rating: "e" },
  });
  deepStrictEqual(parseDanbooruOptions("art /rating:e /rating:g"), {
    text: "art (use danbooru)",
    overrides: { rating: "g" },
  });
});

test("only trailing Danbooru options are replaced, and normalized text is idempotent", () => {
  for (const text of [
    "art /rating:g please",
    "art /order:",
    "art/rating:g",
    "art /rating:g /unknown:value",
    "art (use danbooru)",
    "ordinary text \n",
  ]) {
    deepStrictEqual(parseDanbooruOptions(text), { text });
  }
  deepStrictEqual(parseDanbooruOptions("explain /rating:g here /order:score"), {
    text: "explain /rating:g here (use danbooru)",
    overrides: { order: "score" },
  });
});
