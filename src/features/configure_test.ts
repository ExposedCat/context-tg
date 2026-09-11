import { match, ok, strictEqual } from "node:assert";
import { Bot } from "grammy";
import { I18n } from "grammy-i18n";
import type { Context } from "../bot.ts";

for (const [key, value] of Object.entries({
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  MEDIA_CACHE_CHAT_ID: "-10042",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  KEENABLE_API_KEY: "test",
  LLM_TEMPERATURE: "0.2",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test",
  QDRANT_URL: "https://qdrant.test",
}))
  Deno.env.set(key, value);

const { configureComposer } = await import("./configure.ts");
const { initDatabase } = await import("./database.ts");
const { getChatReasoningEffort, getChatDebugMode } = await import(
  "./llm-models.ts"
);
const { getTrollingSettings, setTrollingInterval } = await import(
  "./trolling.ts"
);
const { getProactiveResponseSettings, setProactiveResponseInterval } =
  await import("./proactive.ts");

Deno.test("rich configure navigation, persistence and authorization", async () => {
  const database = await initDatabase()();
  try {
    const bot = new Bot<Context>("123:test", {
      botInfo: {
        id: 123,
        is_bot: true,
        first_name: "test",
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
    });
    const calls: Array<{ method: string; payload: Record<string, unknown> }> =
      [];
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return Promise.resolve({
        ok: true,
        result: method === "getChatMember" ? { status: "administrator" } : true,
      }) as ReturnType<typeof _prev>;
    });
    bot.use((ctx, next) => {
      ctx.database = database;
      return next();
    });
    bot.use(
      new I18n<Context>({
        directory: "locales",
        defaultLocale: "en",
      }),
    );
    bot.use(configureComposer);
    const chat = { id: -100, type: "supergroup" as const, title: "test" };
    const from = (id: number) => ({ id, is_bot: false, first_name: "user" });
    let updateId = 0;
    const click = async (data: string, user = 1) => {
      calls.length = 0;
      await bot.handleUpdate({
        update_id: ++updateId,
        callback_query: {
          id: String(updateId),
          from: from(user),
          chat_instance: "test",
          data,
          message: { message_id: 42, date: 1, chat, text: "settings" },
        },
      });
    };
    const html = () =>
      (
        calls.find(
          (call) =>
            call.method === "editMessageText" ||
            call.method === "sendRichMessage",
        )?.payload.rich_message as { html: string }
      ).html;
    await bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: 1,
        date: 1,
        chat,
        from: from(1),
        text: "/settings",
        entities: [{ type: "bot_command", offset: 0, length: 9 }],
      },
    });
    ok(calls.some((call) => call.method === "sendRichMessage"));
    ok(calls.every((call) => !("reply_markup" in call.payload)));
    match(html(), /<p>Debug <tg-button[^>]+style="danger"/);
    await click("cfg:debug:on");
    strictEqual(await getChatDebugMode(database, chat.id), true);
    match(html(), /<p>Debug <tg-button[^>]+style="success"/);
    for (const page of ["emoji", "models", "trolling", "proactive", "effort"]) {
      await click(`cfg:${page}`);
      match(html(), /data="cfg:menu">Back/);
    }
    await click("cfg:models");
    match(html(), /<td>Fallback<\/td>/);
    match(html(), /<td>Image Small<\/td>/);
    match(html(), /<td>Image Big<\/td>/);
    await setTrollingInterval(database, chat.id, 137);
    await click("cfg:trolling:off");
    ok(!html().includes("<code>"));
    await click("cfg:trolling:on");
    match(html(), /Enabled<\/tg-button> · <code>\/trolling 137<\/code><\/p>/);
    strictEqual(
      (await getTrollingSettings(database, chat.id)).intervalMessageCount,
      137,
    );
    await setProactiveResponseInterval(database, chat.id, 83);
    await click("cfg:proactive:off");
    await click("cfg:proactive:on");
    strictEqual(
      (await getProactiveResponseSettings(database, chat.id))
        .intervalMessageCount,
      83,
    );
    await click("cfg:effort:big");
    match(html(), /<mark>big<\/mark>/);
    ok(html().indexOf("<tg-button-row>") > html().indexOf("</table>"));
    match(html(), />X High<\/tg-button>/);
    await click("cfg:set:big:high");
    strictEqual(await getChatReasoningEffort(database, chat.id, "big"), "high");
    await click("cfg:set:all:low");
    for (const kind of [
      "small",
      "big",
      "openminded",
      "image",
      "image_small",
      "image_big",
    ] as const) {
      strictEqual(await getChatReasoningEffort(database, chat.id, kind), "low");
    }
    await click("cfg:set:big:high", 2);
    strictEqual(await getChatReasoningEffort(database, chat.id, "big"), "low");
    ok(
      calls.some(
        (call) =>
          call.method === "answerCallbackQuery" && call.payload.show_alert,
      ),
    );
    await click("cfg:menu", 2);
    ok(!html().includes('data="cfg:models"'));
    ok(!html().includes('data="cfg:effort"'));
    const name = "a".repeat(128);
    await database
      .insertInto("emoji_packs")
      .values({ name, position: 0, created_at: "test" })
      .execute();
    await click("cfg:emoji");
    const removal = html().match(/data="(cfg:remove:[^"]+)"/)?.[1];
    ok(removal && new TextEncoder().encode(removal).length <= 64);
    await click(removal);
    strictEqual(
      (await database.selectFrom("emoji_packs").selectAll().execute()).length,
      0,
    );
    await click(removal);
    match(html(), /No emoji packs/);
  } finally {
    await database.destroy();
  }
});
