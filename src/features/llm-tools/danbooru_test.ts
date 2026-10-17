import { deepStrictEqual, rejects, strictEqual } from "node:assert";

for (const [key, value] of Object.entries({
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  KEENABLE_API_KEY: "test",
  LLM_TEMPERATURE: "0.2",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test-embedding",
  QDRANT_URL: "https://qdrant.test",
  DANBOORU_USERNAME: "test-user",
  DANBOORU_API_KEY: "test-key",
}))
  Deno.env.set(key, value);

const { execute, executeTags } = await import("./danbooru.ts");

Deno.test("Danbooru post search applies request overrides over arguments and embedded metatags", async () => {
  const originalFetch = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    strictEqual(
      url.origin + url.pathname,
      "https://danbooru.donmai.us/posts.json",
    );
    strictEqual(url.searchParams.get("limit"), "10");
    strictEqual(url.searchParams.get("page"), "1");
    strictEqual(
      request.headers.get("authorization"),
      `Basic ${btoa("test-user:test-key")}`,
    );
    queries.push(url.searchParams.get("tags") ?? "");
    return Response.json([
      {
        id: 42,
        rating: "g",
        score: 123,
        tag_string: "pigeon solo",
        large_file_url: "https://cdn.test/pigeon.jpg",
        file_url: "https://cdn.test/original.png",
        tag_string_artist: "artist_name",
      },
    ]);
  }) as typeof fetch;
  try {
    const context = {
      chatId: 1,
      messageId: 2,
      danbooru: { rating: "hot", order: "score" },
    };
    const output = JSON.parse(
      (await execute(
        {
          tags: "pigeon rating:g -rating:e order:random",
          rating: "s",
          order: "id",
        },
        context,
      )) as string,
    );
    deepStrictEqual(queries, ["pigeon rating:hot order:score"]);
    deepStrictEqual(output.posts, [
      {
        id: 42,
        source_url: "https://danbooru.donmai.us/posts/42",
        image_url: "https://cdn.test/pigeon.jpg",
        file_url: "https://cdn.test/original.png",
        rating: "g",
        score: 123,
        tags: "pigeon solo",
        artist: "artist_name",
      },
    ]);
    await execute(
      { tags: "pigeon rating:g order:random", rating: "s" },
      {
        chatId: 1,
        messageId: 3,
        danbooru: { order: "Anything:goes" },
      },
    );
    await execute(
      { tags: "pigeon rating:g order:random" },
      { chatId: 1, messageId: 4 },
    );
    deepStrictEqual(queries, [
      "pigeon rating:hot order:score",
      "pigeon rating:s order:Anything:goes",
      "pigeon rating:g order:random",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Danbooru tag lookup sends wildcard search and bounds result counts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(new Request(input, init).url);
    strictEqual(url.pathname, "/tags.json");
    strictEqual(url.searchParams.get("search[name_matches]"), "*pigeon*");
    strictEqual(url.searchParams.get("search[order]"), "count");
    strictEqual(url.searchParams.get("limit"), "20");
    return Response.json([
      { name: "pigeon", category: 0, post_count: 450, is_deprecated: false },
    ]);
  }) as typeof fetch;
  try {
    deepStrictEqual(
      JSON.parse(
        (await executeTags({ query: "*pigeon*", limit: 100 })) as string,
      ),
      [{ name: "pigeon", category: 0, post_count: 450, is_deprecated: false }],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Danbooru failures and cancellation propagate through the tool error path", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("Too many tags", { status: 422 })) as typeof fetch;
    await rejects(
      () => Promise.resolve(execute({ tags: "pigeon" })),
      /HTTP 422: Too many tags/,
    );
    globalThis.fetch = (async () =>
      Response.json({ success: false })) as typeof fetch;
    await rejects(
      () => Promise.resolve(execute({ tags: "pigeon" })),
      /unexpected response/,
    );
    globalThis.fetch = (async (_input, init) => {
      init?.signal?.throwIfAborted();
      throw new Error("Expected an aborted request");
    }) as typeof fetch;
    await rejects(
      () =>
        Promise.resolve(
          execute({ tags: "pigeon" }, undefined, {
            signal: AbortSignal.abort(new Error("cancelled")),
          }),
        ),
      /cancelled/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
