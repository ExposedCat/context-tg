import { deepStrictEqual, strictEqual } from "node:assert";
import type { Api } from "grammy";

const TEST_ENV = {
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  MEDIA_CACHE_CHAT_ID: "-10042",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  LLM_IMAGE_BASE_URL: "https://images.test/v1",
  LLM_IMAGE_MODEL: "test-image",
  LLM_IMAGE_API_KEY: "test",
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

const [{ initDatabase }, { saveImageFileId }, { execute, executeReadImage }] =
  await Promise.all([
    import("../database.ts"),
    import("../images.ts"),
    import("./image-search.ts"),
  ]);

Deno.test("search_images queries all image engines and ignores failed engines", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    strictEqual(url.href.startsWith("http://searxng.test:8080/search?"), true);
    strictEqual(url.searchParams.get("q"), "orange cat");
    strictEqual(url.searchParams.get("format"), "json");
    strictEqual(url.searchParams.get("categories"), "images");
    strictEqual(
      url.searchParams.get("engines"),
      "google images,brave.images,bing images,duckduckgo images",
    );
    strictEqual(request.headers.get("accept"), "application/json");
    strictEqual(request.headers.get("x-real-ip"), "127.0.0.1");

    return new Response(
      JSON.stringify({
        unresponsive_engines: [
          ["google images", "HTTP error 403"],
          ["duckduckgo images", "CAPTCHA"],
        ],
        results: [
          {
            title: "Orange cat",
            content: "A cat on a chair",
            source: "example.com",
            url: "https://example.com/cat",
            img_src: "https://images.example.com/cat.jpg",
            thumbnail_src: "https://images.example.com/cat-thumb.jpg",
            resolution: "1200 x 800",
            engine: "bing images",
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

Deno.test("read_image resolves a saved image id into vision input", async () => {
  const database = await initDatabase()();
  const image = await saveImageFileId(database, "saved-telegram-photo");
  const originalFetch = globalThis.fetch;
  const api = {
    getFile: async (fileId: string) => {
      strictEqual(fileId, "saved-telegram-photo");
      return { file_path: "photos/saved.png" };
    },
  } as unknown as Api;

  globalThis.fetch = (async (input) => {
    const request = new Request(input);
    strictEqual(
      request.url,
      "https://api.telegram.org/file/bottest/photos/saved.png",
    );
    return new Response(new Uint8Array([0]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as typeof fetch;

  try {
    const result = await executeReadImage({ id: image.id }, undefined, {
      database,
      api,
    });

    deepStrictEqual(result, {
      output: JSON.stringify({ image_id: image.id, loaded: true }),
      inputImages: [
        {
          image_url: "data:image/png;base64,AA==",
          detail: "auto",
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});
