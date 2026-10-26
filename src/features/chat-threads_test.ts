import { test } from "bun:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { Api, Context as GrammyContext } from "grammy";
import type { Context } from "../bot.ts";

Bun.env.LLM_STREAMING = "false";
const { chatComposer } = await import("./chat.ts");
const { initDatabase } = await import("./database.ts");
const { setLlmDeploymentName } = await import("./llm-deployments.ts");
const { migrateThreads, saveThread } = await import("./threads.ts");

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
        strictEqual(
          result.reply_markup,
          undefined,
          "Guest answers must not add UI controls",
        );
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

test("forum topics start fresh without explicit replies and preserve reply checkpoints", async () => {
  const f = await fixture();
  try {
    const first = await f.send(
      groupMessage(10, 7),
      null,
      "Topic seven root.",
      false,
    );
    const rootReplyId = f.sentId;
    await f.send(groupMessage(11, 7), null, "New topic seven request.", false);
    ok(!JSON.stringify(f.requests.at(-1)?.input).includes("Topic seven root."));
    await f.send(groupMessage(12, 8), null, "Topic eight root.", false);
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
    ok(JSON.stringify(f.requests.at(-1)?.input).includes("Topic seven root."));
    await f.send(groupMessage(14, 8), null, "New topic eight request.", false);
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
      null,
      "Implicit topic reply starts fresh.",
      false,
    );
    ok(!JSON.stringify(f.requests.at(-1)?.input).includes("Topic eight root."));
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

test("guest forum messages start fresh without explicit replies and preserve reply branches", async () => {
  const f = await fixture();
  try {
    const first = await f.send(groupMessage(10, 7), null, "Topic seven root.");
    await f.send(groupMessage(12, 8), null);
    await migrateThreads(f.database);
    await f.send({ ...groupMessage(14, 7), from: bob }, null);
    ok(!JSON.stringify(f.requests.at(-1)?.input).includes("Topic seven root."));
    await f.send(
      {
        ...groupMessage(16, 7),
        reply_to_message: {
          ...parent(11),
          message_thread_id: 7,
          is_topic_message: true,
        },
      },
      first,
    );
    ok(JSON.stringify(f.requests.at(-1)?.input).includes("Topic seven root."));
    await f.send(
      {
        ...groupMessage(18, 7),
        reply_to_message: {
          ...parent(7, "Topic service"),
          from: bob,
          message_thread_id: 7,
          is_topic_message: true,
          forum_topic_created: { name: "Seven", icon_color: 1 },
        },
      },
      null,
    );
    ok(!JSON.stringify(f.requests.at(-1)?.input).includes("Topic seven root."));
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
        reply_to_message: { ...parent(800) },
      },
      null,
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

test("duplicate guest answers resume exact parents and old branches after restart", async () => {
  const f = await fixture();
  try {
    const first = await f.send(
      { ...dm(100), text: "first root" },
      null,
      "Same answer.",
      true,
      153,
    );
    const second = await f.send(
      { ...dm(160), text: "second root" },
      null,
      "Same answer.",
      true,
      199,
    );
    await f.send(
      { ...dm(210), reply_to_message: parent(153, "Edited text") },
      first,
    );
    await migrateThreads(f.database);
    await migrateThreads(f.database);
    await f.send({ ...dm(220), reply_to_message: parent(199) }, second);
    await f.send({ ...dm(230), reply_to_message: parent(153) }, first);
    ok(!JSON.stringify(f.requests.at(-1)?.input).includes("second root"));
  } finally {
    await f.close();
  }
});

test("the 560 reply chain keeps full history without dates or additional controls", async () => {
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
    const last = {
      ...dm(2199082),
      text: "какое первое сообщение я тебе написал",
      reply_to_message: parent(2199081, "4 🙂"),
    };
    Reflect.deleteProperty(last, "date");
    Reflect.deleteProperty(last.reply_to_message, "date");
    await f.send(last, second, "число 560");
    const input = JSON.stringify(f.requests.at(-1)?.input);
    for (const text of ["число 560", "2+2", "какое первое сообщение"])
      ok(input.includes(text));
  } finally {
    await f.close();
  }
});

test("a unique answer binds the other DM participant's ID without crossing conversations", async () => {
  const f = await fixture();
  try {
    const first = await f.send(dm(100), null, "560", true, 153);
    // Bob sees a different ID. Unique content and the original caller identify
    // the response; the resolved numeric ID is persisted for subsequent replies.
    await f.send(
      { ...dm(900, bob, alice), reply_to_message: parent(899, "560") },
      first,
    );
    // Another participant's conversation with the same peer must stay isolated.
    await f.send(
      { ...dm(160, carol, bob), reply_to_message: parent(153, "560") },
      null,
    );
    await saveThread(f.database, {
      chat_id: bob.id,
      message_id: 50,
      thread_id: 50,
      response_id: "private-secret",
      agent_id: "normal",
    });
    await f.send({ ...dm(180), reply_to_message: parent(50) }, null);
  } finally {
    await f.close();
  }
});

test("alternating DM participants retain the original currency request without controls or time windows", async () => {
  const f = await fixture();
  try {
    const first = await f.send(
      { ...dm(100), text: "9.6 million crowns in euros" },
      null,
      "Which **crowns** — [CZK](https://example.test/czk)?",
    );
    const second = await f.send(
      {
        ...dm(900, bob, alice),
        text: "Czech",
        reply_to_message: {
          ...parent(899),
          text: undefined,
          rich_message: {
            blocks: [{ type: "paragraph", text: "Which crowns — CZK?" }],
          },
        },
      },
      first,
      "9.6 million Czech crowns in euros, understood.",
    );
    // The age of either message cannot influence content recovery.
    await f.database
      .updateTable("guest_response_threads")
      .set({
        created_at: "1999-01-01T00:00:00.000Z",
        updated_at: "1999-01-01T00:00:00.000Z",
      })
      .execute();
    const last = {
      ...dm(104),
      text: "convert that",
      reply_to_message: parent(
        103,
        "9.6 million Czech crowns in euros, understood.",
        bob,
      ),
    };
    Reflect.deleteProperty(last, "date");
    Reflect.deleteProperty(last.reply_to_message, "date");
    await f.send(last, second, "Conversion complete.");
    const input = JSON.stringify(f.requests.at(-1)?.input);
    for (const text of ["9.6 million crowns in euros", "Czech", "convert that"])
      ok(input.includes(text));
    await migrateThreads(f.database);
    // The alias survives restart, formatting changes and later duplicates.
    await f.send(
      dm(110),
      null,
      "Which **crowns** — [CZK](https://example.test/czk)?",
    );
    await f.send(
      { ...dm(904, bob, alice), reply_to_message: parent(899, "Edited text") },
      first,
    );
  } finally {
    await f.close();
  }
});

test("content recovery never chooses among identical answers by their age or delivery order", async () => {
  const f = await fixture();
  try {
    const first = await f.send(dm(100), null, "Same answer.");
    // Recover an alias while the content is unique.
    await f.send(
      { ...dm(900, bob, alice), reply_to_message: parent(899) },
      first,
      "Bob's separate answer.",
    );
    const second = await f.send(dm(110), null, "Same answer.");
    await f.database
      .updateTable("guest_response_threads")
      .set({ created_at: "1900-01-01T00:00:00.000Z" })
      .where("response_id", "=", first)
      .execute();
    await f.send(
      { ...dm(904, bob, alice), reply_to_message: parent(898) },
      null,
      "Cannot disambiguate.",
    );
    // Exact aliases and the original account's native IDs still win.
    await f.send(
      { ...dm(906, bob, alice), reply_to_message: parent(899) },
      first,
      "Alias retained.",
    );
    await f.send(
      { ...dm(120), reply_to_message: parent(111) },
      second,
      "Native ID retained.",
    );
  } finally {
    await f.close();
  }
});

test("content recovery verifies the bot author and the original caller", async () => {
  const f = await fixture();
  try {
    const first = await f.send(dm(100), null, "4");
    const second = await f.send(dm(900, bob, alice), null, "4");
    await f.send(
      { ...dm(904, bob, alice), reply_to_message: parent(899, "4", alice) },
      first,
      "Alice's branch.",
    );
    await f.send(
      { ...dm(104), reply_to_message: parent(103, "4", bob) },
      second,
      "Bob's branch.",
    );
    await f.send(
      {
        ...dm(906, bob, alice),
        reply_to_message: { ...parent(898, "4", alice), from: alice },
      },
      null,
      "Human copy.",
    );
    const missingCaller = {
      ...parent(897, "4"),
      guest_bot_caller_user: undefined,
    };
    await f.send(
      { ...dm(908, bob, alice), reply_to_message: missingCaller },
      null,
      "No caller.",
    );
  } finally {
    await f.close();
  }
});
