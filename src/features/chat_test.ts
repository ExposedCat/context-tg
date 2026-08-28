import { deepStrictEqual, strictEqual } from "node:assert";

const TEST_ENV = {
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  KEENABLE_API_KEY: "test",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test-embedding",
  QDRANT_URL: "https://qdrant.test",
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Deno.env.set(name, value);
}

const [
  { buildGuestRichMessage, formatLlmToolError },
  { initDatabase },
  { saveImageFileId },
] = await Promise.all([
  import("./chat.ts"),
  import("./database.ts"),
  import("./images.ts"),
]);

Deno.test("tool errors hide details unless debug is enabled", () => {
  const error = {
    tool: "generate_image",
    details: "MEDIA_CACHE_CHAT_ID is not set.",
  } as const;

  strictEqual(formatLlmToolError(error, false), "Tool generate_image failed.");
  strictEqual(
    formatLlmToolError(error, true),
    "Tool generate_image failed: MEDIA_CACHE_CHAT_ID is not set.",
  );
});

Deno.test("guest rich messages include saved image media mappings", async () => {
  const database = await initDatabase()();

  try {
    const image = await saveImageFileId(database, "guest-photo");
    deepStrictEqual(
      await buildGuestRichMessage(
        database,
        `Guest image\n\n![](tg://photo?id=${image.id})`,
      ),
      {
        markdown: `Guest image\n\n![](tg://photo?id=${image.id})`,
        media: [
          {
            id: image.id,
            media: { type: "photo", media: "guest-photo" },
          },
        ],
      },
    );
  } finally {
    await database.destroy();
  }
});
