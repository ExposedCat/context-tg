import { test } from "bun:test";
import { deepStrictEqual, match, strictEqual } from "node:assert";
import { I18n } from "@grammyjs/i18n";
import { Api, Context as GrammyContext } from "grammy";
import type { Context } from "../bot.ts";
import {
  areAutomaticResponsesBanished,
  banishAutomaticResponses,
  banishComposer,
  migrateBanishedAutomaticResponses,
} from "./banish.ts";
import { prepareProactiveAgentResponse } from "./chat.ts";
import { initDatabase } from "./database.ts";
import { setProactiveResponseInterval } from "./proactive.ts";
import { preparePeriodicTroll, setTrollingInterval } from "./trolling.ts";

const forum = {
  id: -100,
  type: "supergroup" as const,
  title: "Forum",
  is_forum: true as const,
};
const botInfo = {
  id: 42,
  is_bot: true,
  first_name: "Laylo",
  username: "LayloAI",
} as Context["me"];

test("banishment persists per forum topic, normalizes General, and covers non-forum chats", async () => {
  const database = await initDatabase()();
  const topic = { chat: forum, is_topic_message: true, message_thread_id: 7 };
  const banned = (
    chatId: number,
    message: Parameters<typeof areAutomaticResponsesBanished>[2],
  ) => areAutomaticResponsesBanished(database, chatId, message);
  try {
    strictEqual(await banned(forum.id, topic), false);
    await banishAutomaticResponses(database, forum.id, topic);
    await banishAutomaticResponses(database, forum.id, topic);
    await migrateBanishedAutomaticResponses(database);
    strictEqual(await banned(forum.id, topic), true);
    strictEqual(
      await banned(forum.id, { ...topic, message_thread_id: 8 }),
      false,
    );
    strictEqual(await banned(-200, topic), false);
    strictEqual(await banned(forum.id, { chat: forum }), false);
    await banishAutomaticResponses(database, forum.id, { chat: forum });
    strictEqual(
      await banned(forum.id, { chat: forum, message_thread_id: 1 }),
      true,
    );
    strictEqual(
      await banned(forum.id, { chat: forum, message_thread_id: 8 }),
      false,
    );

    const group = {
      chat: { type: "supergroup", is_forum: false },
      message_thread_id: 7,
    };
    await banishAutomaticResponses(database, -300, group);
    strictEqual(await banned(-300, { ...group, message_thread_id: 8 }), true);
    strictEqual(await banned(-300, { chat: group.chat }), true);
    const dm = { chat: { type: "private" }, message_thread_id: 10 };
    await banishAutomaticResponses(database, 2, dm);
    strictEqual(await banned(2, { ...dm, message_thread_id: 11 }), true);
  } finally {
    await database.destroy();
  }
});

test("banish commands use ephemeral replies, enforce permissions and consume only this bot's command", async () => {
  const database = await initDatabase()();
  const api = new Api("test");
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let admin = true;
  let deletionFails = false;
  api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "deleteMessage" && deletionFails) {
      return Promise.resolve({
        ok: false,
        error_code: 403,
        description: "Cannot delete",
      });
    }
    return Promise.resolve({
      ok: true,
      result:
        method === "getChatMember"
          ? { status: admin ? "administrator" : "member" }
          : true,
    }) as ReturnType<typeof _prev>;
  });
  const i18n = new I18n<Context>({ directory: "locales", defaultLocale: "en" });
  let passed = 0;
  let serial = 0;
  const command = async (
    text: string,
    topic = 7,
    ephemeral = false,
    chat: NonNullable<Context["message"]>["chat"] = forum,
  ) => {
    calls.length = 0;
    const from = { id: 2, is_bot: false, first_name: "User" };
    const message = {
      message_id: ephemeral ? 0 : ++serial,
      date: 0,
      chat: chat ?? forum,
      from,
      text,
      message_thread_id: topic,
      is_topic_message: chat?.type !== "private",
      ...(ephemeral ? { ephemeral_message_id: 17, receiver_user: from } : {}),
    };
    const ctx = new GrammyContext(
      { update_id: serial, message },
      api,
      botInfo,
    ) as Context;
    ctx.database = database;
    await i18n.middleware()(ctx, async () => {
      await banishComposer.middleware()(ctx, async () => {
        passed++;
      });
    });
    return message;
  };
  try {
    const message = await command("/banish@layloai");
    strictEqual(passed, 0);
    strictEqual(calls[0].method, "deleteMessage");
    strictEqual(
      await areAutomaticResponsesBanished(database, forum.id, message),
      true,
    );
    const confirmation = calls.at(-1);
    strictEqual(confirmation?.method, "sendMessage");
    deepStrictEqual(confirmation?.payload.ephemeral_message_parameters, {
      receiver_user_id: 2,
    });
    strictEqual(confirmation?.payload.message_thread_id, 7);
    match(String(confirmation?.payload.text), /banished/);

    await command("/banish", 8, true);
    strictEqual(
      calls.some((call) => call.method === "deleteMessage"),
      false,
    );
    deepStrictEqual(calls.at(-1)?.payload.reply_parameters, {
      ephemeral_message_id: 17,
    });
    deepStrictEqual(calls.at(-1)?.payload.ephemeral_message_parameters, {
      receiver_user_id: 2,
    });

    const otherBotMessage = await command("/banish@OtherBot", 9);
    strictEqual(passed, 1);
    strictEqual(calls.length, 0);
    strictEqual(
      await areAutomaticResponsesBanished(database, forum.id, otherBotMessage),
      false,
    );
    admin = false;
    const denied = await command("/banish", 9);
    strictEqual(
      await areAutomaticResponsesBanished(database, forum.id, denied),
      false,
    );
    match(String(calls.at(-1)?.payload.text), /admin/);
    deepStrictEqual(calls.at(-1)?.payload.ephemeral_message_parameters, {
      receiver_user_id: 2,
    });

    const dm = await command("/banish", 10, false, {
      id: 2,
      type: "private",
      first_name: "User",
    });
    strictEqual(await areAutomaticResponsesBanished(database, 2, dm), true);
    strictEqual(
      calls.some((call) => call.method === "getChatMember"),
      false,
    );

    admin = true;
    deletionFails = true;
    const undeletable = await command("/banish", 11);
    strictEqual(
      await areAutomaticResponsesBanished(database, forum.id, undeletable),
      true,
    );
    deepStrictEqual(calls.at(-1)?.payload.ephemeral_message_parameters, {
      receiver_user_id: 2,
    });
  } finally {
    await database.destroy();
  }
});

test("banished topics skip proactive and troll work and invalidate prepared automatic replies", async () => {
  const database = await initDatabase()();
  const originalRandom = Math.random;
  const api = new Api("test");
  const from = { id: 2, is_bot: false, first_name: "User" };
  const message = {
    chat: forum,
    from,
    text: "Hello",
    message_id: 5,
    date: 0,
    is_topic_message: true,
    message_thread_id: 7,
  };
  const ctx = new GrammyContext(
    { update_id: 1, message },
    api,
    botInfo,
  ) as Context;
  ctx.database = database;
  try {
    Math.random = () => 0;
    await setProactiveResponseInterval(database, forum.id, 1);
    await setTrollingInterval(database, forum.id, 1);
    const proactive = await prepareProactiveAgentResponse(
      ctx,
      message,
      forum.id,
    );
    const troll = await preparePeriodicTroll(ctx, message, from, forum.id);
    strictEqual(typeof proactive, "function");
    strictEqual(typeof troll, "function");
    await banishAutomaticResponses(database, forum.id, message);
    // These would perform unmocked context/model requests if not suppressed.
    await proactive?.();
    await troll?.();
    strictEqual(
      await prepareProactiveAgentResponse(ctx, message, forum.id),
      undefined,
    );
    strictEqual(
      await preparePeriodicTroll(ctx, message, from, forum.id),
      undefined,
    );
    const proactiveState = await database
      .selectFrom("chat_proactive_responses")
      .selectAll()
      .executeTakeFirstOrThrow();
    const trollState = await database
      .selectFrom("chat_trolling")
      .selectAll()
      .executeTakeFirstOrThrow();
    deepStrictEqual(
      [proactiveState.message_count, trollState.message_count],
      [1, 1],
    );
    strictEqual(
      typeof (await prepareProactiveAgentResponse(
        ctx,
        { ...message, message_thread_id: 8 },
        forum.id,
      )),
      "function",
    );
    strictEqual(
      typeof (await preparePeriodicTroll(
        ctx,
        { ...message, message_thread_id: 8 },
        from,
        forum.id,
      )),
      "function",
    );
  } finally {
    Math.random = originalRandom;
    await database.destroy();
  }
});
