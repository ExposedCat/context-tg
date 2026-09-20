import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { Api, Context as GrammyContext } from "grammy";
import type { Context } from "../bot.ts";

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
    chatComposer,
    formatLlmToolError,
    getAzureDownMessage,
    getErrorRecoveryPrompt,
    getMessagesImageAttachments,
    isUnavailableRichMessagePhotoError,
  },
  { initDatabase },
  { saveImageFileId },
] = await Promise.all([
  import("./chat.ts"),
  import("./database.ts"),
  import("./images.ts"),
]);

Deno.test("messages dropped for missing mentions still emit analytics once", async () => {
  const ctx = new GrammyContext(
    {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        from: { id: 1, is_bot: false, first_name: "User" },
        chat: { id: -1, type: "supergroup", title: "Test" },
        text: "Just chatting without addressing the bot",
      },
    },
    new Api("test"),
    {
      id: 42,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  ) as Context;
  const events: unknown[] = [];
  ctx.telemetry = {
    event: (name, payload) => {
      events.push({ name, payload });
    },
  } as Context["telemetry"];
  let nextCalls = 0;

  await chatComposer.middleware()(ctx, () => {
    nextCalls++;
    return Promise.resolve();
  });

  deepStrictEqual(events, [
    {
      name: "message_checked",
      payload: { chat_type: "group", mode: "normal", mentioned: false },
    },
  ]);
  strictEqual(nextCalls, 1);
});

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

Deno.test("media-group input includes the largest photo from every message", () => {
  deepStrictEqual(
    getMessagesImageAttachments([
      {
        photo: [
          { file_id: "small-1", width: 100, height: 100 },
          { file_id: "large-1", width: 1200, height: 800 },
        ],
      },
      {
        photo: [
          { file_id: "small-2", width: 90, height: 90 },
          { file_id: "large-2", width: 800, height: 1200 },
        ],
      },
    ]),
    [
      { fileId: "large-1", mimeType: "image/jpeg" },
      { fileId: "large-2", mimeType: "image/jpeg" },
    ],
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

Deno.test("exhausted balances skip proactive and troll work before context lookup", async () => {
  const { maybeSendProactiveAgentResponse } = await import("./chat.ts");
  const { maybeSendPeriodicTroll } = await import("./trolling.ts");
  const { consumeUsage } = await import("./usage.ts");
  const database = await initDatabase()();
  try {
    await consumeUsage(database, -100, 50);
    const ctx = { database } as import("../bot.ts").Context;
    await maybeSendProactiveAgentResponse(ctx, { message_id: 1 }, -100);
    await maybeSendPeriodicTroll(
      ctx,
      { message_id: 1 },
      { id: 2, first_name: "Test" },
      -100,
    );
    strictEqual(
      (await database.selectFrom("chat_trolling").selectAll().execute()).length,
      0,
    );
    strictEqual(
      (
        await database
          .selectFrom("chat_proactive_responses")
          .selectAll()
          .execute()
      ).length,
      0,
    );
  } finally {
    await database.destroy();
  }
});
