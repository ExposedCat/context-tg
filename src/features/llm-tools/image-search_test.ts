import { deepStrictEqual, strictEqual } from "node:assert";

const TEST_ENV = {
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
  SEARXNG_URL: "http://searxng.test:8080",
  QDRANT_URL: "https://qdrant.test",
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Deno.env.set(name, value);
}

const { execute, executeReadImage, executeSendImage } = await import(
  "./image-search.ts"
);

Deno.test("search_images queries only Google Images JSON and normalizes results", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    strictEqual(url.href.startsWith("http://searxng.test:8080/search?"), true);
    strictEqual(url.searchParams.get("q"), "orange cat");
    strictEqual(url.searchParams.get("format"), "json");
    strictEqual(url.searchParams.get("categories"), "images");
    strictEqual(url.searchParams.get("engines"), "google images");

    return new Response(
      JSON.stringify({
        results: [
          {
            title: "Orange cat",
            content: "A cat on a chair",
            source: "example.com",
            url: "https://example.com/cat",
            img_src: "https://images.example.com/cat.jpg",
            thumbnail_src: "https://images.example.com/cat-thumb.jpg",
            resolution: "1200 x 800",
            engine: "google images",
            score: 1,
          },
          { title: "Missing image URL" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const output = await execute({ query: "orange cat" });
    strictEqual(typeof output, "string");
    deepStrictEqual(JSON.parse(output as string), [
      {
        title: "Orange cat",
        content: "A cat on a chair",
        source: "example.com",
        source_url: "https://example.com/cat",
        image_url: "https://images.example.com/cat.jpg",
        thumbnail_url: "https://images.example.com/cat-thumb.jpg",
        resolution: "1200 x 800",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("read_image returns native vision input for an image result", async () => {
  const result = await executeReadImage({
    url: "https://images.example.com/cat.jpg",
  });

  deepStrictEqual(result, {
    output: JSON.stringify({
      image_url: "https://images.example.com/cat.jpg",
      loaded: true,
    }),
    inputImages: [
      {
        image_url: "https://images.example.com/cat.jpg",
        detail: "auto",
      },
    ],
  });
});

Deno.test("read_image rejects non-HTTP URLs", async () => {
  const result = await executeReadImage({ url: "file:///etc/passwd" });
  strictEqual(
    result,
    JSON.stringify({
      error:
        "Cannot read image: url must be a direct HTTP(S) image URL from search_images.",
    }),
  );
});

Deno.test("send_image returns an existing URL as a Telegram image attachment", async () => {
  const result = await executeSendImage({
    url: "https://images.example.com/cat.jpg",
  });

  deepStrictEqual(result, {
    output: JSON.stringify({
      sent_image: {
        attached: true,
        url: "https://images.example.com/cat.jpg",
      },
    }),
    image: {
      prompt: "Existing image sent by URL.",
      url: "https://images.example.com/cat.jpg",
    },
  });
});

Deno.test("send_image rejects non-HTTP URLs", async () => {
  const result = await executeSendImage({ url: "data:image/png;base64,AA==" });
  strictEqual(
    result,
    JSON.stringify({
      error: "Cannot send image: url must be a direct HTTP(S) image URL.",
    }),
  );
});
