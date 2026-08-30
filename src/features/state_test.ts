import { deepStrictEqual } from "node:assert";
import { Bot } from "grammy";
import type { Context } from "../bot.ts";

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

const { stateComposer } = await import("./state.ts");

Deno.test("floodoncelocal sends the static response in private and group chats", async () => {
  const calls: Array<{ method: string; chatId: number; text: string }> = [];
  const bot = new Bot<Context>("1:test", {
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });

  bot.api.config.use(async (_previous, method, payload) => {
    const sendMessagePayload = payload as {
      chat_id: number;
      text: string;
    };
    calls.push({
      method,
      chatId: sendMessagePayload.chat_id,
      text: sendMessagePayload.text,
    });

    return {
      ok: true,
      result: {
        message_id: 2,
        date: 1,
        chat: { id: sendMessagePayload.chat_id, type: "private" },
        text: sendMessagePayload.text,
      },
    } as never;
  });
  bot.use(stateComposer);

  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: 10, type: "private", first_name: "User" },
      from: { id: 10, is_bot: false, first_name: "User" },
      text: "/floodoncelocal",
      entities: [{ type: "bot_command", offset: 0, length: 15 }],
    },
  });
  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      date: 1,
      chat: { id: -100, type: "group", title: "Test" },
      from: { id: 10, is_bot: false, first_name: "User" },
      text: "/floodoncelocal@test_bot",
      entities: [{ type: "bot_command", offset: 0, length: 24 }],
    },
  });

  deepStrictEqual(calls, [
    {
      method: "sendMessage",
      chatId: 10,
      text: "Project is secure, owned and in complete control of the maintainer @ExposedCat",
    },
    {
      method: "sendMessage",
      chatId: -100,
      text: "Project is secure, owned and in complete control of the maintainer @ExposedCat",
    },
  ]);
});
