import { test } from "bun:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { Api, Context as GrammyContext } from "grammy";
import type { Context } from "../bot.ts";

Bun.env.LLM_STREAMING = "false";
const { chatComposer } = await import("./chat.ts");
const { initDatabase } = await import("./database.ts");
const { setLlmDeploymentName } = await import("./llm-deployments.ts");
const { getGuestThreadReference } = await import("./guest-threads.ts");
const { getGuestResponseThread, migrateThreads, saveThread } = await import(
  "./threads.ts"
);

type Message = NonNullable<Context["message"]>;
type Reply = NonNullable<Message["reply_to_message"]>;
const bot = {
  id: 42,
  is_bot: true,
  first_name: "Laylo",
  username: "test_bot",
} as Context["me"];
const alice = { id: 100, is_bot: false, first_name: "Alice" };
const bob = { id: 200, is_bot: false, first_name: "Bob" };
const carol = { id: 300, is_bot: false, first_name: "Carol" };
const group = {
  id: -1000000001001,
  type: "supergroup",
  title: "Forum",
  is_forum: true,
} as const;
const date = Math.floor(Date.now() / 1000);
function dm(id: number, from = alice, peer = bob): Message {
  return {
    message_id: id,
    date,
    from,
    chat: { id: peer.id, type: "private", first_name: peer.first_name },
    text: "@test_bot hello",
  };
}
function groupMessage(id: number, topic?: number): Message {
  return {
    message_id: id,
    date,
    from: alice,
    chat: group,
    text: "@test_bot hello",
    ...(topic === undefined
      ? {}
      : { message_thread_id: topic, is_topic_message: true }),
  };
}
function parent(id: number, text = "Same answer.", caller = alice): Reply {
  return {
    message_id: id,
    date,
    chat: group,
    from: bot,
    guest_bot_caller_user: caller,
    text,
    reply_to_message: undefined,
  };
}
function inlineId(owner: number, id: number): string {
  const bytes = Buffer.alloc(24);
  bytes.writeInt32LE(2, 0);
  bytes.writeBigInt64LE(BigInt(owner), 4);
  bytes.writeInt32LE(id, 12);
  bytes.writeBigInt64LE(123456789n, 16);
  return bytes.toString("base64url");
}

async function fixture() {
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const api = new Api("test");
  const requests: Array<{ input: unknown }> = [];
  const deliveries: Array<{
    message_thread_id?: number;
    reply_parameters?: { message_id?: number };
  }> = [];
  const markups = new Map<string, NonNullable<Message["reply_markup"]>>();
  let answer = "Done.";
  let sentId = 1000;
  let current: Message = groupMessage(1);
  api.config.use((_previous, method) =>
    Promise.reject(new Error(`Unexpected Telegram call: ${method}`)),
  );
  api.sendChatAction = async () => true;
  api.sendRichMessage = async (_chatId, _rich, options) => {
    deliveries.push(options ?? {});
    return {
      message_id: ++sentId,
      date,
      chat: current.chat,
      from: bot,
      rich_message: { blocks: [{ type: "paragraph", text: answer }] },
    };
  };
  globalThis.fetch = (async (url, init) => {
    strictEqual(String(url), `${Bun.env.LLM_BASE_URL}/responses`);
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({
      id: `resp_thread_${requests.length}`,
      object: "response",
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: answer, annotations: [] }],
        },
      ],
    });
  }) as typeof fetch;
  setLlmDeploymentName("small", "test-model");
  return {
    database,
    requests,
    deliveries,
    api,
    get sentId() {
      return sentId;
    },
    markup(responseId: string) {
      const markup = markups.get(responseId);
      ok(markup, `No actual delivered reference for ${responseId}`);
      return markup;
    },
    async send(
      message: Message,
      previous: string | null,
      response = "Same answer.",
      guest = true,
      outgoingId = message.message_id + 1,
    ) {
      current = message;
      answer = response;
      const ctx = new GrammyContext(
        {
          update_id: message.message_id,
          ...(guest ? { guest_message: message } : { message }),
        },
        api,
        bot,
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      ctx.answerGuestQuery = async (result) => {
        ok(result.reply_markup);
        const referenceId = getGuestThreadReference(result.reply_markup);
        ok(referenceId);
        const row = await getGuestResponseThread(database, {
          conversationKey:
            message.chat.type === "private"
              ? `dm:${[message.chat.id, message.from?.id].sort((a, b) => Number(a) - Number(b)).join(":")}:0`
              : `chat:${message.chat.id}:${message.message_thread_id ?? 0}`,
          referenceId,
        });
        ok(row, "The reference must be durable before Telegram can deliver it");
        markups.set(`resp_thread_${requests.length}`, result.reply_markup);
        const owner =
          message.chat.type === "supergroup"
            ? message.chat.id + 1_000_000_000_000
            : message.from?.id;
        ok(owner);
        return { inline_message_id: inlineId(owner, outgoingId) };
      };
      const before = requests.length;
      await chatComposer.middleware()(ctx, async () => {
        throw new Error("Request was skipped");
      });
      strictEqual(requests.length, before + 1);
      const responseId = `resp_thread_${requests.length}`;
      const history = await database
        .selectFrom("llm_chat_responses")
        .selectAll()
        .where("response_id", "=", responseId)
        .executeTakeFirstOrThrow();
      strictEqual(history.previous_response_id, previous);
      return responseId;
    },
    async close() {
      globalThis.fetch = originalFetch;
      setLlmDeploymentName("small", "");
      await database.destroy();
    },
  };
}

test("guest DM replies follow delivered references across participant views and restarts", async () => {
  const f = await fixture();
  try {
    const first = await f.send(
      { ...dm(100), text: "9.6 million crowns in euros" },
      null,
    );
    const second = await f.send(
      {
        ...dm(900, bob, alice),
        text: "Czech",
        reply_to_message: { ...parent(899), reply_markup: f.markup(first) },
      },
      first,
    );
    const third = await f.send(
      {
        ...dm(104),
        text: "convert that",
        reply_to_message: {
          ...parent(103, "Same answer.", bob),
          reply_markup: f.markup(second),
        },
      },
      second,
    );
    for (const text of ["9.6 million crowns in euros", "Czech", "convert that"])
      ok(JSON.stringify(f.requests.at(-1)?.input).includes(text));
    await migrateThreads(f.database);
    await migrateThreads(f.database);
    await f.send(
      {
        ...dm(904, bob, alice),
        text: "old branch",
        reply_to_message: { ...parent(899), reply_markup: f.markup(first) },
      },
      first,
    );
    ok(!JSON.stringify(f.requests.at(-1)?.input).includes("convert that"));
    strictEqual(
      (
        await f.database
          .selectFrom("guest_thread_links")
          .selectAll()
          .where("message_id", "=", 104)
          .executeTakeFirstOrThrow()
      ).thread_id,
      100,
    );
    ok(third);
  } finally {
    await f.close();
  }
});

test("guest replies use exact IDs even when content is edited and delivery IDs are non-adjacent", async () => {
  const f = await fixture();
  try {
    const first = await f.send(dm(100), null, "560", true, 153);
    await f.send(
      {
        ...dm(160),
        reply_to_message: parent(153, "Edited to completely different text"),
      },
      first,
    );
    // No incrementing of a trigger ID or matching the identical answer text.
    await f.send({ ...dm(170), reply_to_message: parent(101, "560") }, null);
  } finally {
    await f.close();
  }
});

test("identical guest answers stay separate by reference and keep old explicit branches", async () => {
  const f = await fixture();
  try {
    const first = await f.send(dm(100), null);
    const second = await f.send(dm(110), null);
    await f.send(
      {
        ...dm(900, bob, alice),
        reply_to_message: { ...parent(899), reply_markup: f.markup(first) },
      },
      first,
    );
    await f.send(
      {
        ...dm(902, bob, alice),
        reply_to_message: { ...parent(898), reply_markup: f.markup(second) },
      },
      second,
    );
    // No stable identifier means no inference from content or delivery order.
    await f.send(
      { ...dm(904, bob, alice), reply_to_message: parent(897) },
      null,
    );
  } finally {
    await f.close();
  }
});

test("delivered references still work if a future inline ID encoding cannot be decoded", async () => {
  const f = await fixture();
  try {
    // A zero native message ID is rejected by the decoder. The delivered
    // reference remains authoritative without any timestamp/content recovery.
    const first = await f.send(dm(100), null, "Same answer.", true, 0);
    await f.send(
      {
        ...dm(900, bob, alice),
        reply_to_message: { ...parent(899), reply_markup: f.markup(first) },
      },
      first,
    );
  } finally {
    await f.close();
  }
});

test("guest response identity is independent of delivery dates, reply dates and missing dates", async () => {
  const f = await fixture();
  try {
    const first = await f.send(
      { ...dm(100), text: "@test_bot число 560", date: 1792753502 },
      null,
      "560",
      true,
      2199079,
    );
    await f.database
      .updateTable("guest_response_threads")
      .set({
        created_at: "1999-01-01T00:00:00.000Z",
        updated_at: "1999-01-01T00:00:00.000Z",
      })
      .execute();
    const second = await f.send(
      {
        ...dm(2199080),
        date: 1792753526,
        text: "как думаешь 2+2 сколько будет",
        reply_to_message: { ...parent(2199079, "560"), date: 1792753514 },
      },
      first,
      "4 🙂",
      true,
      2199081,
    );
    await f.send(
      {
        ...dm(2199082),
        date: 1,
        text: "какое первое сообщение я тебе написал",
        reply_to_message: { ...parent(2199081, "4 🙂"), date: 2 },
      },
      second,
      "число 560",
    );
    ok(JSON.stringify(f.requests.at(-1)?.input).includes("число 560"));
    // Both views can resume the original answer with no date fields available.
    const missingDates = {
      ...dm(900, bob, alice),
      reply_to_message: { ...parent(899), reply_markup: f.markup(first) },
    };
    Reflect.deleteProperty(missingDates, "date");
    Reflect.deleteProperty(missingDates.reply_to_message, "date");
    await f.send(missingDates, first);
  } finally {
    await f.close();
  }
});

test("references cannot cross DM participants, forum topics or direct bot chat storage", async () => {
  const f = await fixture();
  try {
    await saveThread(f.database, {
      chat_id: bob.id,
      message_id: 50,
      thread_id: 50,
      response_id: "private-secret",
      agent_id: "normal",
    });
    const first = await f.send(dm(100), null);
    await f.send({ ...dm(110), reply_to_message: parent(50) }, null);
    await f.send(
      {
        ...dm(120, carol, bob),
        reply_to_message: { ...parent(101), reply_markup: f.markup(first) },
      },
      null,
    );
    await f.send(
      {
        ...dm(130),
        reply_to_message: {
          ...parent(101),
          from: bob,
          reply_markup: f.markup(first),
        },
      },
      null,
    );
    const topic = await f.send(groupMessage(10, 7), null);
    await f.send(
      {
        ...groupMessage(12, 8),
        reply_to_message: {
          ...parent(11),
          reply_markup: f.markup(topic),
          message_thread_id: 8,
          is_topic_message: true,
        },
      },
      null,
    );
    strictEqual(
      (
        await f.database
          .selectFrom("threads")
          .selectAll()
          .where("chat_id", "=", bob.id)
          .where("message_id", "=", 50)
          .executeTakeFirstOrThrow()
      ).response_id,
      "private-secret",
    );
  } finally {
    await f.close();
  }
});

test("forum topics continue independently and explicit replies resume their own checkpoint", async () => {
  const f = await fixture();
  try {
    const first = await f.send(
      groupMessage(10, 7),
      null,
      "Topic seven root.",
      false,
    );
    const rootReplyId = f.sentId;
    await f.send(
      groupMessage(11, 7),
      first,
      "Topic seven continuation.",
      false,
    );
    const other = await f.send(
      groupMessage(12, 8),
      null,
      "Topic eight root.",
      false,
    );
    await f.send(
      {
        ...groupMessage(13, 7),
        text: "branch",
        reply_to_message: {
          ...parent(rootReplyId),
          guest_bot_caller_user: undefined,
          message_thread_id: 7,
          is_topic_message: true,
        },
      },
      first,
      "Old branch.",
      false,
    );
    await f.send(
      groupMessage(14, 8),
      other,
      "Topic eight continuation.",
      false,
    );
    await f.send(
      {
        ...groupMessage(15, 7),
        reply_to_message: {
          ...parent(6, "Untracked human message."),
          from: bob,
          message_thread_id: 7,
          is_topic_message: true,
        },
      },
      null,
      "New branch.",
      false,
    );
    await f.send(
      {
        ...groupMessage(16, 8),
        reply_to_message: {
          ...parent(8, "Topic service"),
          from: bob,
          message_thread_id: 8,
          is_topic_message: true,
          forum_topic_created: { name: "Eight", icon_color: 1 },
        },
      },
      "resp_thread_5",
      "Implicit topic continuation.",
      false,
    );
    deepStrictEqual(
      f.deliveries.map((delivery) => delivery.message_thread_id),
      [7, 7, 8, 7, 8, 7, 8],
    );
    deepStrictEqual(
      f.deliveries.map((delivery) => delivery.reply_parameters?.message_id),
      [10, 11, 12, 13, 14, 15, 16],
    );
  } finally {
    await f.close();
  }
});

test("guest forum messages retain topic history and explicit reply branches", async () => {
  const f = await fixture();
  try {
    const first = await f.send(groupMessage(10, 7), null);
    await f.send(groupMessage(12, 8), null);
    await f.send(groupMessage(14, 7), first);
    await f.send(
      {
        ...groupMessage(16, 7),
        reply_to_message: {
          ...parent(11),
          message_thread_id: 7,
          is_topic_message: true,
          reply_markup: f.markup(first),
        },
      },
      first,
    );
  } finally {
    await f.close();
  }
});

test("ordinary group reply chains remain separate from topics in both delivery modes", async () => {
  for (const guest of [false, true]) {
    const f = await fixture();
    try {
      const first = await f.send(groupMessage(10), null, "Root.", guest);
      const outputId = guest ? 11 : f.sentId;
      await f.send(groupMessage(12), null, "Other root.", guest);
      const second = await f.send(
        {
          ...groupMessage(14),
          text: "continue",
          message_thread_id: 10,
          reply_to_message: {
            ...parent(outputId, "Root."),
            guest_bot_caller_user: guest ? alice : undefined,
            message_thread_id: 10,
          },
        },
        first,
        "Continued.",
        guest,
      );
      await f.send(
        {
          ...groupMessage(16),
          reply_to_message: {
            ...parent(14, "continue"),
            from: alice,
            guest_bot_caller_user: undefined,
          },
        },
        second,
        "Human parent.",
        guest,
      );
      strictEqual(
        (
          await f.database
            .selectFrom("threads")
            .selectAll()
            .where("message_id", "=", 16)
            .executeTakeFirstOrThrow()
        ).thread_id,
        10,
      );
      if (!guest)
        ok(
          f.deliveries.every(
            (delivery) => delivery.message_thread_id === undefined,
          ),
        );
    } finally {
      await f.close();
    }
  }
});

test("basic group guest IDs are scoped to each caller's account", async () => {
  const f = await fixture();
  const chat = { id: -123, type: "group", title: "Basic group" } as const;
  try {
    const first = await f.send({ ...groupMessage(10), chat }, null);
    const second = await f.send({ ...groupMessage(10), chat, from: bob }, null);
    await f.send(
      { ...groupMessage(12), chat, reply_to_message: parent(11) },
      first,
    );
    await f.send(
      {
        ...groupMessage(12),
        chat,
        from: bob,
        reply_to_message: parent(11, "Same answer.", bob),
      },
      second,
    );
    await f.send(
      {
        ...groupMessage(14),
        chat,
        from: carol,
        reply_to_message: { ...parent(800), reply_markup: f.markup(first) },
      },
      first,
    );
  } finally {
    await f.close();
  }
});

test("group history survives guest-to-member and member-to-guest replies", async () => {
  const f = await fixture();
  try {
    const first = await f.send(groupMessage(10, 7), null);
    const second = await f.send(
      {
        ...groupMessage(12, 7),
        reply_to_message: {
          ...parent(11),
          message_thread_id: 7,
          is_topic_message: true,
          reply_markup: f.markup(first),
        },
      },
      first,
      "Member.",
      false,
    );
    await f.send(
      {
        ...groupMessage(14, 7),
        reply_to_message: {
          ...parent(f.sentId),
          guest_bot_caller_user: undefined,
          message_thread_id: 7,
          is_topic_message: true,
        },
      },
      second,
    );
  } finally {
    await f.close();
  }
});

test("migration restores exact legacy inline IDs without restoring content or time guesses", async () => {
  const f = await fixture();
  try {
    await f.database
      .insertInto("guest_response_threads")
      .values({
        chat_id: bob.id,
        conversation_key: `dm:${alice.id}:${bob.id}:0`,
        caller_id: alice.id,
        response_fingerprint: "legacy",
        trigger_message_id: 90,
        thread_id: 90,
        response_id: "legacy-response",
        inline_message_id: inlineId(alice.id, 99),
        content_fingerprint: "old-content-guess",
        created_at: "1999-01-01T00:00:00.000Z",
        updated_at: "1999-01-01T00:00:00.000Z",
      })
      .execute();
    await migrateThreads(f.database);
    await migrateThreads(f.database);
    await f.send(
      { ...dm(100), reply_to_message: parent(99, "Different text") },
      "legacy-response",
    );
    const legacy = await f.database
      .selectFrom("guest_response_threads")
      .selectAll()
      .where("response_fingerprint", "=", "legacy")
      .executeTakeFirstOrThrow();
    strictEqual(legacy.response_id, "legacy-response");
    // Updating an existing numeric link must update its artificial root too.
    await saveThread(f.database, {
      chat_id: group.id,
      message_id: 5,
      thread_id: 5,
      response_id: "old",
    });
    await saveThread(f.database, {
      chat_id: group.id,
      message_id: 5,
      thread_id: 7,
      response_id: "new",
    });
    strictEqual(
      (
        await f.database
          .selectFrom("threads")
          .selectAll()
          .where("message_id", "=", 5)
          .executeTakeFirstOrThrow()
      ).thread_id,
      7,
    );
  } finally {
    await f.close();
  }
});

test("Reply button answers with a hint and does not generate another model request", async () => {
  const f = await fixture();
  try {
    const first = await f.send(dm(100), null);
    const callbackData = f.markup(first).inline_keyboard[0][0];
    ok("callback_data" in callbackData && callbackData.callback_data);
    const hints: string[] = [];
    const ctx = new GrammyContext(
      {
        update_id: 1,
        callback_query: {
          id: "query",
          from: bob,
          chat_instance: "test",
          inline_message_id: "inline",
          data: callbackData.callback_data,
        },
      },
      f.api,
      bot,
    ) as Context;
    ctx.answerCallbackQuery = async (options) => {
      hints.push(typeof options === "string" ? options : (options?.text ?? ""));
      return true;
    };
    await chatComposer.middleware()(ctx, async () => {
      throw new Error("Button was skipped");
    });
    deepStrictEqual(hints, [
      "Reply to this message to continue this conversation.",
    ]);
    strictEqual(f.requests.length, 1);
  } finally {
    await f.close();
  }
});
