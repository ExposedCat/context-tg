import { test } from "bun:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { Api, Context as GrammyContext } from "grammy";
import type { Context } from "../bot.ts";

Bun.env.LLM_STREAMING = "false";
const { chatComposer } = await import("./chat.ts");
const { initDatabase } = await import("./database.ts");
const { setLlmDeploymentName } = await import("./llm-deployments.ts");
const { getGuestContentFingerprint } = await import("./guest-threads.ts");
const { migrateThreads, saveThread } = await import("./threads.ts");

type Message = NonNullable<Context["message"]>;
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
  id: -1001,
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
function reply(
  id: number,
  text: string,
  caller = alice,
): NonNullable<Message["reply_to_message"]> {
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

async function fixture() {
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const api = new Api("test");
  const requests: Array<{ input: unknown }> = [];
  const deliveries: Array<{
    message_thread_id?: number;
    reply_parameters?: { message_id?: number };
  }> = [];
  let answer = "Which **crowns** — [CZK](https://example.test/czk)?";
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
    get sentId() {
      return sentId;
    },
    async send(
      message: Message,
      previous: string | null,
      response: string,
      guest = true,
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
      ctx.answerGuestQuery = async () => ({
        inline_message_id: `inline-${requests.length}`,
      });
      const before = requests.length;
      await chatComposer.middleware()(ctx, async () => {
        throw new Error("Request was skipped");
      });
      strictEqual(requests.length, before + 1);
      const history = await database
        .selectFrom("llm_chat_responses")
        .selectAll()
        .where("response_id", "=", `resp_thread_${requests.length}`)
        .executeTakeFirstOrThrow();
      strictEqual(history.previous_response_id, previous);
      return `resp_thread_${requests.length}`;
    },
    async close() {
      globalThis.fetch = originalFetch;
      setLlmDeploymentName("small", "");
      await database.destroy();
    },
  };
}

test("guest DM reply branches survive alternating participants, different message IDs and restarts", async () => {
  const f = await fixture();
  try {
    const first = await f.send(
      { ...dm(100), text: "9.6 million crowns in euros" },
      null,
      "Which **crowns** — [CZK](https://example.test/czk)?",
    );
    // The reply has Bob's local ID, not Alice's. Rich blocks contain rendered text.
    const second = await f.send(
      {
        ...dm(900, bob, alice),
        text: "Czech",
        reply_to_message: {
          ...reply(899, "", alice),
          chat: dm(900, bob, alice).chat,
          rich_message: {
            blocks: [{ type: "paragraph", text: "Which crowns — CZK?" }],
          },
          text: undefined,
        },
      },
      first,
      "9.6 million Czech crowns in euros, understood.",
    );
    const third = await f.send(
      {
        ...dm(102),
        text: "yes, convert that",
        reply_to_message: {
          ...reply(101, "9.6 million Czech crowns in euros, understood.", bob),
          chat: dm(102).chat,
        },
      },
      second,
      "Conversion complete.",
    );
    const input = JSON.stringify(f.requests.at(-1)?.input);
    for (const text of [
      "9.6 million crowns in euros",
      "Czech",
      "yes, convert that",
    ])
      ok(input.includes(text), input);
    await migrateThreads(f.database);
    await migrateThreads(f.database);
    // Backfilled IDs continue to identify this older branch after a restart.
    await f.send(
      {
        ...dm(901, bob, alice),
        text: "another branch",
        reply_to_message: {
          ...reply(899, "Which crowns — CZK?", alice),
          chat: dm(901, bob, alice).chat,
        },
      },
      first,
      "Branch response.",
    );
    ok(
      !JSON.stringify(f.requests.at(-1)?.input).includes(
        "Conversion complete.",
      ),
    );
    strictEqual(
      (
        await f.database
          .selectFrom("guest_thread_links")
          .selectAll()
          .where("message_id", "=", 102)
          .executeTakeFirstOrThrow()
      ).thread_id,
      100,
    );
    ok(third);
  } finally {
    await f.close();
  }
});

test("guest DM links are isolated from direct bot chats, other participant pairs and human copies", async () => {
  const f = await fixture();
  try {
    // A colliding direct-chat message ID must not supply guest context.
    await saveThread(f.database, {
      chat_id: bob.id,
      message_id: 50,
      thread_id: 50,
      response_id: "private-secret",
      agent_id: "normal",
    });
    await f.send(
      {
        ...dm(100),
        reply_to_message: {
          ...reply(50, "Unrelated", alice),
          chat: dm(100).chat,
        },
      },
      null,
      "Known guest response.",
    );
    // Carol's DM with Bob has the same peer and local message ID but a different pair.
    await f.send(
      {
        ...dm(101, carol, bob),
        reply_to_message: {
          ...reply(50, "Known guest response.", alice),
          chat: dm(101, carol, bob).chat,
        },
      },
      null,
      "Other conversation.",
    );
    // A human quoting our response is not a response reference.
    await f.send(
      {
        ...dm(102),
        reply_to_message: {
          ...reply(51, "Known guest response.", alice),
          from: bob,
          chat: dm(102).chat,
        },
      },
      null,
      "Human quote.",
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

test("guest response matching uses caller and content and rejects ambiguous timestamps", async () => {
  const f = await fixture();
  try {
    const first = await f.send(dm(100), null, "Same answer.");
    await f.send(dm(900, bob, alice), null, "Same answer.");
    // Caller disambiguates identical simultaneous responses in one DM.
    await f.send(
      {
        ...dm(901, bob, alice),
        reply_to_message: {
          ...reply(800, "Same answer.", alice),
          chat: dm(901, bob, alice).chat,
        },
      },
      first,
      "Continued correct caller.",
    );
    // Different content at the same timestamp must never restore a thread.
    await f.send(
      {
        ...dm(102),
        reply_to_message: {
          ...reply(70, "A different response.", alice),
          chat: dm(102).chat,
        },
      },
      null,
      "Different answer.",
    );
    await f.send(dm(103), null, "Same answer.");
    // Identical responses by the same caller cannot be identified by proximity.
    await f.send(
      {
        ...dm(902, bob, alice),
        reply_to_message: {
          ...reply(801, "Same answer.", alice),
          chat: dm(902, bob, alice).chat,
        },
      },
      null,
      "Ambiguous answer.",
    );
  } finally {
    await f.close();
  }
});

test("forum topics continue independently while explicit replies branch from their own parent", async () => {
  const f = await fixture();
  try {
    const first = await f.send(
      groupMessage(10, 7),
      null,
      "Topic seven root.",
      false,
    );
    const rootReplyId = f.sentId;
    const second = await f.send(
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
          ...reply(rootReplyId, "Topic seven root."),
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
    // Unknown explicit parents start their own branch rather than silently
    // inheriting the latest topic conversation.
    await f.send(
      {
        ...groupMessage(15, 7),
        reply_to_message: {
          ...reply(6, "Untracked human message."),
          from: bob,
          message_thread_id: 7,
          is_topic_message: true,
        },
      },
      null,
      "New branch.",
      false,
    );
    // Telegram's implicit reply to the topic creation event is not a branch.
    await f.send(
      {
        ...groupMessage(16, 8),
        reply_to_message: {
          ...reply(8, "Topic service"),
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
    ok(second);
  } finally {
    await f.close();
  }
});

test("guest forum topics preserve topic history and resolve replies without timestamp guessing", async () => {
  const f = await fixture();
  try {
    const first = await f.send(groupMessage(10, 7), null, "Topic seven.");
    await f.send(groupMessage(11, 8), null, "Topic eight.");
    const continuation = await f.send(
      groupMessage(12, 7),
      first,
      "Topic seven continuation.",
    );
    await f.send(
      {
        ...groupMessage(13, 7),
        reply_to_message: {
          ...reply(500, "Topic seven.", alice),
          message_thread_id: 7,
          is_topic_message: true,
        },
      },
      first,
      "Reply to topic seven root.",
    );
    await f.send(
      {
        ...groupMessage(14, 8),
        reply_to_message: {
          ...reply(501, "Topic seven.", alice),
          message_thread_id: 8,
          is_topic_message: true,
        },
      },
      null,
      "No cross-topic match.",
    );
    ok(continuation);
  } finally {
    await f.close();
  }
});

test("ordinary group replies preserve separate artificial branches without treating reply IDs as topics", async () => {
  for (const guest of [false, true]) {
    const f = await fixture();
    try {
      const first = await f.send(
        { ...groupMessage(10), chat: { ...group, is_forum: undefined } },
        null,
        "Group root.",
        guest,
      );
      const firstReply = f.sentId;
      await f.send(groupMessage(11), null, "Independent group root.", guest);
      const second = await f.send(
        {
          ...groupMessage(12),
          text: "continue",
          message_thread_id: 10,
          reply_to_message: {
            ...reply(guest ? 500 : firstReply, "Group root."),
            ...(guest ? {} : { guest_bot_caller_user: undefined }),
            message_thread_id: 10,
          },
        },
        first,
        "Group continuation.",
        guest,
      );
      // Replies to the triggering human message also resume its saved history.
      await f.send(
        {
          ...groupMessage(13),
          reply_to_message: {
            ...reply(12, "continue"),
            from: alice,
            guest_bot_caller_user: undefined,
          },
        },
        second,
        "Human parent continuation.",
        guest,
      );
      strictEqual(
        (
          await f.database
            .selectFrom("threads")
            .selectAll()
            .where("message_id", "=", 13)
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

test("guest content fingerprints survive rendered Markdown and rich tables", () => {
  for (const [markdown, rendered] of [
    [
      "**9.6 million** in [euros](https://example.test)",
      "9.6 million in euros",
    ],
    ["A &amp; B", "A & B"],
    [
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
      "A | B\n1 | 2",
    ],
    ["| A | B |\n|---|---|\n|1|2|", "A | B\n1 | 2"],
    ["One\n\nTwo", "One\nTwo"],
  ])
    strictEqual(
      getGuestContentFingerprint(markdown),
      getGuestContentFingerprint(rendered),
      markdown,
    );
  strictEqual(
    getGuestContentFingerprint("![image](tg://photo?id=example)"),
    undefined,
  );
});

test("group histories continue when delivery switches between guest and member updates", async () => {
  const f = await fixture();
  try {
    const first = await f.send(groupMessage(10, 7), null, "Guest root.");
    // An ordinary mention must not reset history just because the earlier
    // response used the guest agent automatically.
    const second = await f.send(
      {
        ...groupMessage(11, 7),
        reply_to_message: {
          ...reply(500, "Guest root."),
          message_thread_id: 7,
          is_topic_message: true,
        },
      },
      first,
      "Member continuation.",
      false,
    );
    await f.send(
      {
        ...groupMessage(12, 7),
        reply_to_message: {
          ...reply(f.sentId, "Member continuation."),
          guest_bot_caller_user: undefined,
          message_thread_id: 7,
          is_topic_message: true,
        },
      },
      second,
      "Guest continuation.",
    );
  } finally {
    await f.close();
  }
});

test("thread migrations preserve legacy rows and can be safely rerun", async () => {
  const f = await fixture();
  try {
    await f.database.schema.dropIndex("guest_response_content_index").execute();
    for (const column of [
      "conversation_key",
      "caller_id",
      "content_fingerprint",
    ]) {
      await f.database.schema
        .alterTable("guest_response_threads")
        .dropColumn(column)
        .execute();
    }
    await f.database.schema.dropTable("guest_thread_links").execute();
    await f.database
      .insertInto("guest_response_threads")
      .values({
        chat_id: group.id,
        response_fingerprint: "legacy",
        trigger_message_id: 1,
        thread_id: 1,
        response_id: "legacy-response",
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      })
      .execute();
    await migrateThreads(f.database);
    await migrateThreads(f.database);
    const row = await f.database
      .selectFrom("guest_response_threads")
      .selectAll()
      .where("response_fingerprint", "=", "legacy")
      .executeTakeFirstOrThrow();
    strictEqual(row.response_id, "legacy-response");
    strictEqual(row.conversation_key, null);
    strictEqual(row.content_fingerprint, null);
    // Reassigning a message to a resolved branch must update its root as well.
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
