import { deepStrictEqual, ok, strictEqual } from "node:assert";

const TEST_ENV = {
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  LLM_TEMPERATURE: "0.2",
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
  {
    buildGuestRichMessage,
    formatLlmToolError,
    getAzureDownMessage,
    getErrorRecoveryPrompt,
    isUnavailableRichMessagePhotoError,
  },
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

Deno.test("Azure upstream outages use a plain custom-emoji message", () => {
  deepStrictEqual(
    getAzureDownMessage(
      new Error(
        "status 503: server_error: no healthy upstream: 503 no healthy upstream",
      ),
    ),
    {
      text: "Azure is down 😔",
      entities: [
        {
          type: "custom_emoji",
          offset: 14,
          length: 2,
          custom_emoji_id: "5384549865625758405",
        },
      ],
    },
  );
});

Deno.test("other model failures do not use the Azure outage message", () => {
  strictEqual(
    getAzureDownMessage(new Error("status 503: another server error")),
    undefined,
  );
  strictEqual(
    getAzureDownMessage(new Error("status 502: no healthy upstream")),
    undefined,
  );
});

Deno.test("unavailable rich-message photos are retried without user diagnostics", () => {
  const error = new Error("400 Bad Request: RICH_MESSAGE_PHOTO_NO_MEDIA_FOUND");
  const prompt = getErrorRecoveryPrompt("Show me the result", error);

  strictEqual(isUnavailableRichMessagePhotoError(error), true);
  ok(prompt.includes("Some image in your previous response cannot be sent."));
  ok(prompt.includes("Retry the complete user-facing answer"));
  ok(prompt.includes("Show me the result"));
  ok(!prompt.includes("RICH_MESSAGE_PHOTO_NO_MEDIA_FOUND"));
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
