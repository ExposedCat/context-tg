import { deepStrictEqual, match, rejects, strictEqual } from "node:assert";
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
  QDRANT_URL: "https://qdrant.test",
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Deno.env.set(name, value);
}

const [
  { initDatabase },
  {
    getImageById,
    getRichMessageImageIds,
    resolveRichMessageImageMedia,
    saveImage,
    saveImageFileId,
  },
] = await Promise.all([import("./database.ts"), import("./images.ts")]);

Deno.test("Telegram photo file ids receive stable saved image ids", async () => {
  const database = await initDatabase()();

  try {
    const first = await saveImageFileId(database, "telegram-photo-file");
    const reused = await saveImageFileId(database, "telegram-photo-file");

    match(first.id, /^image_[a-f0-9]{32}$/);
    strictEqual(reused.id, first.id);
    deepStrictEqual(await getImageById(database, first.id), first);
  } finally {
    await database.destroy();
  }
});

Deno.test("saved images are cached and resolved for rich Markdown", async () => {
  const database = await initDatabase()();
  const cachedInputs: unknown[] = [];
  let sendCount = 0;
  const api = {
    sendPhoto: async (chatId: number, input: unknown) => {
      strictEqual(chatId, -10042);
      cachedInputs.push(input);
      sendCount += 1;
      return {
        photo: [
          { file_id: `small-${sendCount}`, width: 90, height: 90 },
          { file_id: `large-${sendCount}`, width: 1024, height: 1024 },
        ],
      };
    },
  } as unknown as Api;

  try {
    const first = await saveImage(database, api, {
      dataUrl: "data:image/png;base64,AA==",
      mimeType: "image/png",
    });
    const second = await saveImage(database, api, {
      url: "https://images.example.com/generated.png",
    });

    match(first.id, /^image_[a-f0-9]{32}$/);
    match(second.id, /^image_[a-f0-9]{32}$/);
    strictEqual(cachedInputs.length, 2);
    strictEqual(cachedInputs[1], "https://images.example.com/generated.png");

    const markdown = [
      `![](tg://photo?id=${first.id})`,
      `![](tg://photo?id=${second.id})`,
      `![](tg://photo?id=${first.id})`,
    ].join("\n");

    deepStrictEqual(getRichMessageImageIds(markdown), [first.id, second.id]);
    deepStrictEqual(await resolveRichMessageImageMedia(database, markdown), [
      {
        id: first.id,
        media: { type: "photo", media: "large-1" },
      },
      {
        id: second.id,
        media: { type: "photo", media: "large-2" },
      },
    ]);
  } finally {
    await database.destroy();
  }
});

Deno.test("unknown rich Markdown image ids are rejected", async () => {
  const database = await initDatabase()();

  try {
    await rejects(
      () =>
        resolveRichMessageImageMedia(
          database,
          "![](tg://photo?id=image_missing)",
        ),
      /Unknown image id\(s\): image_missing/,
    );
  } finally {
    await database.destroy();
  }
});
