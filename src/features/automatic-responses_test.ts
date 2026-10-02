import { deepStrictEqual, strictEqual } from "node:assert";
import { Api, Context as GrammyContext } from "grammy";
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
  EMBEDDING_MODEL: "test-embedding",
  QDRANT_URL: "https://qdrant.test",
})) {
  Deno.env.set(key, value);
}

const { safelyMaybeSendAutomaticResponse } = await import(
  "./automatic-responses.ts"
);
const { initDatabase } = await import("./database.ts");
const { getLlmDeployment, setLlmDeploymentName } = await import(
  "./llm-deployments.ts"
);
const { setTrollingEnabled, setTrollingInterval } = await import(
  "./trolling.ts"
);
const { setProactiveResponseEnabled, setProactiveResponseInterval } =
  await import("./proactive.ts");
const { consumeUsage, getUsageStatus } = await import("./usage.ts");

Deno.test("automatic responses choose one before generation and advance both counters", async (t) => {
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  const previousSmall = getLlmDeployment("small").deploymentName;
  const previousTroll = getLlmDeployment("openminded").deploymentName;
  const models: string[] = [];
  const sent: string[] = [];
  const draws: number[] = [];
  let verdict = '{"valid":true}';
  let messageId = 0;
  let contextReads = 0;
  const chat = { id: -100, type: "supergroup", title: "Test chat" } as const;
  const sender = { id: 2, is_bot: false, first_name: "User" };
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Bot",
    username: "test_bot",
  } as Context["me"];
  const api = new Api("test");
  api.sendMessage = async (_chatId, text) => {
    sent.push(text);
    return { message_id: messageId + 1000, date: 0, chat, from: bot, text };
  };
  api.sendRichMessage = async (_chatId, content) => {
    sent.push(content.markdown ?? "");
    return {
      message_id: messageId + 1000,
      date: 0,
      chat,
      from: bot,
      rich_message: {
        blocks: [{ type: "paragraph", text: "Proactive response." }],
      },
    };
  };
  api.sendChatAction = () => Promise.resolve(true);
  Math.random = () => {
    // Once generation starts, let SDK request IDs use their own randomness.
    if (contextReads > 0) return originalRandom();
    const draw = draws.shift();
    if (draw === undefined) throw new Error("Unexpected random draw");
    return draw;
  };
  globalThis.fetch = (async (url, init) => {
    const request = new Request(url, init);
    if (new URL(request.url).hostname === "qdrant.test") {
      if (request.url.endsWith("/points/scroll")) {
        contextReads++;
        return Response.json({
          result: {
            points: [
              {
                id: "last",
                payload: {
                  text: "A concrete chat message",
                  date: "2026-10-02",
                  date_timestamp: 1,
                  sender_name: "User",
                  sender_id: sender.id,
                  chat_id: chat.id,
                  message_id: messageId,
                },
              },
            ],
          },
        });
      }
      return Response.json({ result: { payload_schema: {} } });
    }
    const body = await request.json();
    models.push(body.model);
    const text =
      body.model === "gpt-61-sol"
        ? verdict
        : body.model === "test-troll"
          ? "Topical quip."
          : "Proactive response.";
    return Response.json({
      id: `resp_${models.length}`,
      object: "response",
      status: "completed",
      output: [
        {
          id: `msg_${models.length}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
    });
  }) as typeof fetch;
  const receive = async () => {
    const message = {
      message_id: ++messageId,
      date: 0,
      chat,
      from: sender,
      text: "A concrete chat message",
    };
    const ctx = new GrammyContext(
      { update_id: messageId, message },
      api,
      bot,
    ) as Context;
    ctx.database = database;
    ctx.telemetry = { event: () => {} } as Context["telemetry"];
    await safelyMaybeSendAutomaticResponse(ctx, message, sender, chat.id);
  };
  try {
    setLlmDeploymentName("small", "test-proactive");
    setLlmDeploymentName("openminded", "test-troll");
    for (const test of [
      {
        name: "both trigger, troll wins",
        draws: [0.1, 0.1],
        models: ["test-troll", "gpt-61-sol"],
        sent: ["Topical quip."],
      },
      {
        name: "both trigger, proactive wins",
        draws: [0.1, 0.9],
        models: ["test-proactive"],
        sent: ["Proactive response."],
      },
      {
        name: "rejected troll has no fallback",
        draws: [0.1, 0.1],
        verdict: '{"valid":false}',
        models: ["test-troll", "gpt-61-sol"],
        sent: [],
      },
      {
        name: "failed validation has no fallback",
        draws: [0.1, 0.1],
        verdict: "invalid JSON",
        models: ["test-troll", "gpt-61-sol"],
        sent: [],
      },
      {
        name: "only troll triggers",
        draws: [0.9],
        models: ["test-troll", "gpt-61-sol"],
        sent: ["Topical quip."],
      },
      {
        name: "only proactive triggers",
        trollDisabled: true,
        draws: [0.1],
        models: ["test-proactive"],
        sent: ["Proactive response."],
      },
      {
        name: "neither triggers",
        trollDisabled: true,
        draws: [0.9],
        models: [],
        sent: [],
      },
      {
        name: "both disabled",
        trollDisabled: true,
        proactiveDisabled: true,
        draws: [],
        models: [],
        sent: [],
      },
    ]) {
      await t.step(test.name, async () => {
        await setTrollingInterval(database, chat.id, 2);
        await setProactiveResponseInterval(database, chat.id, 2);
        if (test.trollDisabled)
          await setTrollingEnabled(database, chat.id, false);
        if (test.proactiveDisabled)
          await setProactiveResponseEnabled(database, chat.id, false);
        verdict = test.verdict ?? '{"valid":true}';
        models.length = 0;
        sent.length = 0;
        contextReads = 0;
        const before = (await getUsageStatus(database, chat.id)).used;
        // Neither interval is due on the first message.
        await receive();
        deepStrictEqual(models, []);
        strictEqual(contextReads, 0);
        draws.push(...test.draws);
        await receive();
        deepStrictEqual(models, test.models);
        deepStrictEqual(sent, test.sent);
        strictEqual(contextReads, test.models.length > 0 ? 1 : 0);
        strictEqual(draws.length, 0);
        strictEqual(
          (await getUsageStatus(database, chat.id)).used - before,
          test.models.length,
        );
        const troll = await database
          .selectFrom("chat_trolling")
          .select("message_count")
          .where("chat_id", "=", chat.id)
          .executeTakeFirstOrThrow();
        const proactive = await database
          .selectFrom("chat_proactive_responses")
          .select("message_count")
          .where("chat_id", "=", chat.id)
          .executeTakeFirstOrThrow();
        deepStrictEqual([troll.message_count, proactive.message_count], [2, 2]);
      });
    }
    await t.step(
      "exhausted credits skip both counters and generation",
      async () => {
        const usage = await getUsageStatus(database, chat.id);
        await consumeUsage(database, chat.id, usage.quota - usage.used);
        await receive();
        const troll = await database
          .selectFrom("chat_trolling")
          .select("message_count")
          .where("chat_id", "=", chat.id)
          .executeTakeFirstOrThrow();
        const proactive = await database
          .selectFrom("chat_proactive_responses")
          .select("message_count")
          .where("chat_id", "=", chat.id)
          .executeTakeFirstOrThrow();
        deepStrictEqual([troll.message_count, proactive.message_count], [2, 2]);
        deepStrictEqual(models, []);
        strictEqual(contextReads, 0);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
    setLlmDeploymentName("small", previousSmall);
    setLlmDeploymentName("openminded", previousTroll);
    await database.destroy();
  }
});
