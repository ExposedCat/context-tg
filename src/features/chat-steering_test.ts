import { test } from "bun:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { Api, Context as GrammyContext } from "grammy";
import type { Context } from "../bot.ts";

for (const [name, value] of Object.entries({
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  LLM_STREAMING: "false",
  KEENABLE_API_KEY: "test",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test",
  QDRANT_URL: "https://qdrant.test",
}))
  Bun.env[name] = value;
const { chatComposer } = await import("./chat.ts");
const { initDatabase } = await import("./database.ts");
const { setLlmDeploymentName } = await import("./llm-deployments.ts");
const { getThread } = await import("./threads.ts");
type Message = NonNullable<Context["message"]>;
const bot = {
  id: 42,
  is_bot: true,
  first_name: "Bot",
  username: "test_bot",
} as Context["me"];
const alice = { id: 100, is_bot: false, first_name: "Alice" };
const bob = { id: 200, is_bot: false, first_name: "Bob" };
function message(
  id: number,
  kind: "group" | "private" = "group",
  topic?: number,
  from = alice,
): Message & { reply_to_message: undefined } {
  return {
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    from,
    text: "@test_bot original",
    reply_to_message: undefined,
    chat:
      kind === "private"
        ? { id: 100, type: "private", first_name: "Alice" }
        : { id: -100, type: "supergroup", title: "Group", is_forum: true },
    ...(topic === undefined
      ? {}
      : { message_thread_id: topic, is_topic_message: true }),
  };
}
function response(id: string, text: string) {
  return {
    id,
    object: "response",
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    output: [
      {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const database = await initDatabase()();
  const beforeFetch = globalThis.fetch;
  const first = deferred();
  const release = deferred();
  const requests: Array<{ input: unknown; instructions: string }> = [];
  const deliveries: string[] = [];
  const names: Array<{ chatId: number; topic: number; name: string }> = [];
  const api = new Api("test");
  api.config.use((_previous, method) =>
    Promise.reject(new Error(`Unexpected Telegram call: ${method}`)),
  );
  api.sendMessage = async (chatId, text) => ({
    message_id: 2000,
    date: 0,
    chat: { id: Number(chatId), type: "private", first_name: "Bot" },
    text,
  });
  api.sendChatAction = async () => true;
  api.setMessageReaction = async () => true;
  api.editForumTopic = async (chatId, topic, options) => {
    names.push({ chatId: Number(chatId), topic, name: options?.name ?? "" });
    return true;
  };
  api.sendRichMessage = async (chatId, rich) => {
    deliveries.push(rich.markdown ?? "");
    return {
      message_id: 1000 + deliveries.length,
      date: 0,
      chat: { id: Number(chatId), type: "private", first_name: "Bot" },
      from: bot,
      rich_message: {
        blocks: [{ type: "paragraph", text: rich.markdown ?? "" }],
      },
    };
  };
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.instructions === "")
      return Response.json(response("name", "Custom topic name"));
    requests.push(body);
    const index = requests.length;
    if (index === 1) {
      first.resolve();
      await release.promise;
    }
    return Response.json(
      response(
        `answer${index}`,
        index === 1 ? "Original answer" : "Updated answer",
      ),
    );
  }) as typeof fetch;
  setLlmDeploymentName("big", "test-model");
  return {
    database,
    first,
    release,
    requests,
    deliveries,
    names,
    async send(msg: Message) {
      const ctx = new GrammyContext(
        { update_id: msg.message_id, message: msg },
        api,
        bot,
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      let skipped = false;
      await chatComposer.middleware()(ctx, async () => {
        skipped = true;
      });
      return skipped;
    },
    async close() {
      release.resolve();
      globalThis.fetch = beforeFetch;
      await database.destroy();
    },
  };
}

test("an author's unaddressed replies steer the original task and link to its final checkpoint", async () => {
  const f = await fixture();
  const trigger = message(10);
  const running = f.send(trigger);
  try {
    await f.first.promise;
    const followup = {
      ...message(11),
      text: "Focus on authentication",
      reply_to_message: trigger,
    };
    strictEqual(await f.send(followup), false);
    strictEqual(
      await f.send({
        ...message(12),
        text: "Also include sessions",
        reply_to_message: trigger,
      }),
      false,
    );
    strictEqual(f.requests.length, 1);
    f.release.resolve();
    await running;
    strictEqual(f.requests.length, 2);
    const replay = JSON.stringify(f.requests[1].input);
    ok(replay.includes("Original answer"));
    ok(replay.includes("Focus on authentication"));
    ok(replay.includes("Also include sessions"));
    ok(replay.includes('sender_id=\\"100\\"'));
    const tasks = await f.database.selectFrom("tasks").selectAll().execute();
    strictEqual(tasks.length, 1);
    strictEqual(tasks[0].status, "finished");
    for (const id of [10, 11, 12])
      strictEqual(
        (await getThread(f.database, { chat_id: -100, message_id: id }))
          ?.response_id,
        "answer2",
      );
    strictEqual(f.deliveries.length, 1);
    ok(f.deliveries[0].includes("Updated answer"));
  } finally {
    f.release.resolve();
    await running;
    await f.close();
  }
});

test("another author, a reply to another message, and a group topic message cannot auto-steer", async () => {
  const f = await fixture();
  const trigger = message(20, "group", 7);
  const running = f.send(trigger);
  try {
    await f.first.promise;
    strictEqual(
      await f.send({
        ...message(21, "group", 7, bob),
        text: "Other author",
        reply_to_message: trigger,
      }),
      true,
    );
    strictEqual(
      await f.send({
        ...message(22, "group", 7),
        text: "Other target",
        reply_to_message: message(19, "group", 7),
      }),
      true,
    );
    strictEqual(
      await f.send({
        ...message(23, "group", 7),
        text: "Just another topic message",
      }),
      true,
    );
    strictEqual(
      await f.send({
        ...message(24, "group", 8),
        text: "Wrong topic",
        reply_to_message: trigger,
      }),
      true,
    );
    f.release.resolve();
    await running;
    strictEqual(f.requests.length, 1);
    strictEqual(f.names.length, 0);
  } finally {
    f.release.resolve();
    await running;
    await f.close();
  }
});

test("new messages in a named DM topic steer without replies and do not rename or duplicate its task", async () => {
  const f = await fixture();
  const trigger = message(30, "private", 9);
  const running = f.send(trigger);
  try {
    await f.first.promise;
    await f.send({
      ...message(31, "private", 9),
      text: "Keep the scope small",
    });
    await f.send({ ...message(32, "private", 9), text: "Two weeks maximum" });
    strictEqual(f.requests.length, 1);
    f.release.resolve();
    await running;
    strictEqual(f.requests.length, 2);
    const text = JSON.stringify(f.requests[1].input);
    ok(text.includes("Keep the scope small"));
    ok(text.includes("Two weeks maximum"));
    deepStrictEqual(f.names, [
      { chatId: 100, topic: 9, name: "Custom topic name" },
    ]);
    strictEqual(
      (await f.database.selectFrom("tasks").selectAll().execute()).length,
      1,
    );
    strictEqual(
      (await getThread(f.database, { chat_id: 100, message_id: 32 }))
        ?.response_id,
      "answer2",
    );
    // After completion, the next topic message starts a normal request with
    // the steered history, rather than being swallowed by a stale controller.
    await f.send({ ...message(33, "private", 9), text: "Now continue" });
    strictEqual(f.requests.length, 3);
    strictEqual(f.names.length, 1);
    ok(JSON.stringify(f.requests[2].input).includes("Two weeks maximum"));
  } finally {
    f.release.resolve();
    await running;
    await f.close();
  }
});

test("plain DMs, different DM topics, and group topics start separate tasks", async () => {
  for (const [kind, firstTopic, nextTopic] of [
    ["private", undefined, undefined],
    ["private", 7, 8],
    ["group", 7, 7],
  ] as const) {
    const f = await fixture();
    const running = f.send(message(40, kind, firstTopic));
    try {
      await f.first.promise;
      await f.send({
        ...message(41, kind, nextTopic),
        text: "@test_bot independent request",
      });
      strictEqual(f.requests.length, 2);
      ok(!JSON.stringify(f.requests[1].input).includes("Original answer"));
      f.release.resolve();
      await running;
      strictEqual(
        (await f.database.selectFrom("tasks").selectAll().execute()).length,
        2,
      );
    } finally {
      f.release.resolve();
      await running;
      await f.close();
    }
  }
});

test("steering never consumes commands or over-limit input", async () => {
  const f = await fixture();
  const trigger = message(50);
  const running = f.send(trigger);
  try {
    await f.first.promise;
    strictEqual(
      await f.send({
        ...message(51),
        text: "/tasks",
        reply_to_message: trigger,
      }),
      true,
    );
    await f.send({
      ...message(52),
      text: "word ".repeat(6000),
      reply_to_message: trigger,
    });
    f.release.resolve();
    await running;
    strictEqual(f.requests.length, 1);
    strictEqual(
      await getThread(f.database, { chat_id: -100, message_id: 52 }),
      undefined,
    );
  } finally {
    f.release.resolve();
    await running;
    await f.close();
  }
});
