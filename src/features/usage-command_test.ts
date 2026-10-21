import { test } from "bun:test";
import { deepStrictEqual, match, strictEqual } from "node:assert";
import { I18n } from "@grammyjs/i18n";
import { Bot } from "grammy";
import type { Context } from "../bot.ts";

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
  EMBEDDING_MODEL: "test",
  QDRANT_URL: "https://qdrant.test",
}))
  Bun.env[key] = value;

const { stateComposer } = await import("./state.ts");
const { createPrivateTopicMiddleware } = await import("./private-topics.ts");
const { initDatabase } = await import("./database.ts");
const { getUsageStatus, handleUsageCommand } = await import("./usage.ts");

test("addressed usage adjustments respond with or without command entities and preserve ephemeral replies", async () => {
  const database = await initDatabase()();
  try {
    const bot = new Bot<Context>("123:test", {
      botInfo: {
        id: 123,
        is_bot: true,
        first_name: "Laylo",
        username: "LayloAI",
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
    });
    const calls: Array<{ method: string; payload: Record<string, unknown> }> =
      [];
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return Promise.resolve({ ok: true, result: true }) as ReturnType<
        typeof _prev
      >;
    });
    bot.use((ctx, next) => {
      ctx.database = database;
      return next();
    });
    bot.use(new I18n<Context>({ directory: "locales", defaultLocale: "en" }));
    bot.use(createPrivateTopicMiddleware());
    bot.use(stateComposer);
    let passedThrough = 0;
    bot.use(() => {
      passedThrough++;
    });
    let updateId = 0;
    const chat = { id: -100, type: "supergroup" as const, title: "Test" };
    const from = { id: 1, is_bot: false, first_name: "Admin" };
    const command = async (
      text: string,
      entities = false,
      ephemeral = false,
      user = from,
    ) => {
      calls.length = 0;
      await bot.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: ephemeral ? 0 : updateId,
          date: Math.floor(Date.now() / 1000),
          chat,
          from: user,
          text,
          ...(entities
            ? {
                entities: [
                  {
                    type: "bot_command" as const,
                    offset: 0,
                    length: text.split(/\s/)[0].length,
                  },
                ],
              }
            : {}),
          ...(ephemeral
            ? { ephemeral_message_id: 17, receiver_user: user }
            : {}),
        },
      });
    };
    await handleUsageCommand(database, chat.id, "+150", true, (key) => key);

    // The reported command must update the quota and reply even without entities.
    await command("/usage@LayloAI -100");
    strictEqual((await getUsageStatus(database, chat.id)).quota, 100);
    strictEqual(calls[0]?.method, "sendMessage");
    match(
      String(calls[0].payload.text).replace(/[\u2068\u2069]/g, ""),
      /Credits used: 0 \/ 100/,
    );
    strictEqual(passedThrough, 0);

    await command("/usage@LayloAI -10", true);
    strictEqual((await getUsageStatus(database, chat.id)).quota, 90);
    strictEqual(calls[0]?.method, "sendMessage");

    await command("/usage@LayloAI -5", true, true);
    strictEqual((await getUsageStatus(database, chat.id)).quota, 85);
    deepStrictEqual(calls[0].payload.ephemeral_message_parameters, {
      receiver_user_id: 1,
    });
    deepStrictEqual(calls[0].payload.reply_parameters, {
      ephemeral_message_id: 17,
    });

    await command("/usage@OtherBot -40");
    strictEqual((await getUsageStatus(database, chat.id)).quota, 85);
    strictEqual(calls.length, 0);
    strictEqual(passedThrough, 1);

    await command("/usage@LayloAI -40", false, false, { ...from, id: 2 });
    strictEqual((await getUsageStatus(database, chat.id)).quota, 85);
    match(String(calls[0].payload.text), /Only the bot admin/);

    const privateChat = {
      id: 1,
      type: "private" as const,
      first_name: "Admin",
    };
    await bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: 700,
        date: 100,
        chat: privateChat,
        from,
        message_thread_id: 2192419,
        forum_topic_created: {
          name: "/usage +unlimite...",
          icon_color: 7322096,
          is_name_implicit: true,
        },
      },
    });
    calls.length = 0;
    await bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: 701,
        date: 100,
        chat: privateChat,
        from,
        text: "/usage +unlimited",
      },
    });
    strictEqual(
      (await getUsageStatus(database, privateChat.id)).unlimited,
      true,
    );
    strictEqual(calls[0]?.method, "sendMessage");
    strictEqual(calls[0].payload.message_thread_id, 2192419);
    strictEqual((await getUsageStatus(database, chat.id)).quota, 85);
  } finally {
    await database.destroy();
  }
});
