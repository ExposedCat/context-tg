import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { type Api, InputFile } from "grammy";

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
  QDRANT_URL: "https://qdrant.test",
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Deno.env.set(name, value);
}

const [{ initDatabase }, { saveImageFileId }, { execute, toolDefinition }] =
  await Promise.all([
    import("../database.ts"),
    import("../images.ts"),
    import("./image.ts"),
  ]);

Deno.test("generate_image exposes ordered saved ids or URLs as inputs", () => {
  deepStrictEqual(toolDefinition.parameters.required, ["prompt"]);
  strictEqual(toolDefinition.strict, false);
  deepStrictEqual(toolDefinition.parameters.properties.images, {
    type: "array",
    description:
      "Optional ordered input images to reference, transform, or combine. Each item must be either a direct HTTP(S) image URL or the exact saved image ID from a tg://photo or tg://document reference.",
    items: { type: "string" },
  });
});

Deno.test("generate_image resolves saved ids and uploads all image inputs", async () => {
  const database = await initDatabase()();
  const savedImage = await saveImageFileId(database, "saved-telegram-photo");
  const originalFetch = globalThis.fetch;
  let cachedPhotoInput: unknown;
  let editRequestCount = 0;
  const api = {
    getFile: async (fileId: string) => {
      strictEqual(fileId, "saved-telegram-photo");
      return { file_path: "photos/saved.png" };
    },
    sendPhoto: async (chatId: number, input: unknown) => {
      strictEqual(chatId, -10042);
      cachedPhotoInput = input;
      return {
        photo: [{ file_id: "generated-large", width: 1024, height: 1024 }],
      };
    },
  } as unknown as Api;

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);

    if (request.url.startsWith("data:")) {
      return await originalFetch(input, init);
    }

    if (
      request.url === "https://api.telegram.org/file/bottest/photos/saved.png"
    ) {
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    if (request.url === "https://images.example.com/reference.jpg") {
      return new Response(new Uint8Array([2]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }

    strictEqual(request.url, "https://images.test/v1/images/edits");
    strictEqual(request.method, "POST");
    strictEqual(request.headers.get("authorization"), "Bearer test");
    ok(request.headers.get("content-type")?.startsWith("multipart/form-data"));
    editRequestCount += 1;

    const form = await request.formData();
    strictEqual(form.get("model"), "test-image");
    strictEqual(form.get("prompt"), "Combine both references");
    strictEqual(form.get("n"), "1");
    const files = form.getAll("image[]");
    strictEqual(files.length, 2);
    ok(files[0] instanceof File);
    ok(files[1] instanceof File);
    strictEqual(files[0].name, "input-1.png");
    strictEqual(files[0].type, "image/png");
    strictEqual(files[1].name, "input-2.jpg");
    strictEqual(files[1].type, "image/jpeg");
    deepStrictEqual(
      new Uint8Array(await files[0].arrayBuffer()),
      new Uint8Array([1]),
    );
    deepStrictEqual(
      new Uint8Array(await files[1].arrayBuffer()),
      new Uint8Array([2]),
    );

    return new Response(JSON.stringify({ data: [{ b64_json: "Aw==" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await execute(
      {
        prompt: "Combine both references",
        images: [savedImage.id, "https://images.example.com/reference.jpg"],
      },
      undefined,
      { database, api },
    );

    ok(typeof result === "object");
    strictEqual(editRequestCount, 1);
    ok(cachedPhotoInput instanceof InputFile);
    match(result.generatedImageId ?? "", /^image_[a-f0-9]{32}$/);
    const output = JSON.parse(result.output) as {
      generated_image: { id: string; markdown: string; prompt: string };
    };
    strictEqual(output.generated_image.id, result.generatedImageId);
    strictEqual(
      output.generated_image.markdown,
      `![](tg://photo?id=${result.generatedImageId})`,
    );
    strictEqual(output.generated_image.prompt, "Combine both references");
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

Deno.test("generate_image rejects an unknown saved input id", async () => {
  const database = await initDatabase()();
  let requested = false;
  const originalFetch = globalThis.fetch;
  const api = {
    sendPhoto: () => {
      throw new Error("unexpected sendPhoto");
    },
  } as unknown as Api;

  globalThis.fetch = (() => {
    requested = true;
    throw new Error("unexpected fetch");
  }) as typeof fetch;

  try {
    const result = await execute(
      { prompt: "Use this reference", images: ["image_missing"] },
      undefined,
      { database, api },
    );

    strictEqual(
      result,
      JSON.stringify({ error: "Unknown input image id: image_missing" }),
    );
    strictEqual(requested, false);
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});
