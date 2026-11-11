import { test } from "bun:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { Api, Context as GrammyContext } from "grammy";
import type { Context } from "../bot.ts";

for (const [key, value] of Object.entries({
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
  Bun.env[key] = value;

const { chatComposer } = await import("./chat.ts");
const { initDatabase } = await import("./database.ts");
const { LLM_DEPLOYMENTS, setLlmDeploymentName } = await import(
  "./llm-deployments.ts"
);
const { getChatRouterEnabled, persistChatRouterEnabled } = await import(
  "./llm-models.ts"
);
const { requestModelRoute } = await import("./llm.ts");
const { safelyMaybeSendAutomaticResponse } = await import(
  "./automatic-responses.ts"
);

function response(text: string, id: number, status = "completed") {
  return Response.json({
    id: `resp_router_${id}`,
    object: "response",
    created_at: 1,
    status,
    usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
    output: [
      {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  });
}

test("opt-in routes ordinary messages, preserves name triggers, and scopes three-message context", async () => {
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const previous = Object.fromEntries(
    Object.entries(LLM_DEPLOYMENTS).map(([key, value]) => [
      key,
      value.deploymentName,
    ]),
  );
  const chat = {
    id: -100 as number,
    type: "supergroup",
    title: "Test",
    is_forum: true,
  } as const;
  const sender = { id: 1, is_bot: false, first_name: "User" };
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Bot",
    username: "test_bot",
  } as Context["me"];
  const api = new Api("test");
  let sent = 0,
    passed = 0,
    serial = 0,
    route = "large",
    historyFails = false;
  const requests: Array<{
    model: string;
    reasoning?: unknown;
    input: Array<{ content: string }>;
  }> = [];
  const scrolls: Array<{
    limit: number;
    filter: { must: Array<{ is_empty?: { key: string } }> };
  }> = [];
  api.sendChatAction = async () => true;
  api.sendRichMessage = async () => ({
    message_id: 1000 + ++sent,
    date: 1,
    chat,
    from: bot,
    rich_message: { blocks: [{ type: "paragraph", text: "Answer" }] },
  });
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "qdrant.test") {
      if (request.url.endsWith("/points/scroll")) {
        if (historyFails) throw new Error("History unavailable");
        const body = await request.json();
        scrolls.push(body);
        return Response.json({
          result: {
            points: [9, 8].map((id) => ({
              id,
              payload: {
                chat_id: chat.id,
                message_id: id,
                thread_id: 7,
                text: `earlier ${id}`,
                sender_name: "Earlier User",
                sender_id: 2,
                date: "2026-11-11",
                date_timestamp: id,
              },
            })),
          },
        });
      }
      return Response.json({ result: { payload_schema: {} } });
    }
    strictEqual(request.url, "https://llm.test/v1/responses");
    const body = await request.json();
    requests.push(body);
    return response(
      body.model === "test-router"
        ? JSON.stringify({ model: route })
        : "Answer",
      requests.length,
    );
  }) as typeof fetch;
  const receive = async (text: string, otherChat = chat, topic = true) => {
    requests.length = 0;
    scrolls.length = 0;
    const ctx = new GrammyContext(
      {
        update_id: ++serial,
        message: {
          message_id: 20 + serial,
          date: 20 + serial,
          from: sender,
          chat: otherChat,
          text,
          ...(topic ? { is_topic_message: true, message_thread_id: 7 } : {}),
        },
      },
      api,
      bot,
    ) as Context;
    ctx.database = database;
    ctx.telemetry = { event: () => {} } as Context["telemetry"];
    await chatComposer.middleware()(ctx, async () => {
      passed++;
    });
    return ctx;
  };
  try {
    setLlmDeploymentName("router", "test-router");
    setLlmDeploymentName("small", "test-small");
    setLlmDeploymentName("big", "test-big");
    strictEqual(await getChatRouterEnabled(database, chat.id), false);
    await receive("ordinary chat");
    strictEqual(passed, 1);
    strictEqual(requests.length, 0);
    await persistChatRouterEnabled(database, chat.id, true);
    const ctx = await receive("please compare these");
    ok(ctx.message);
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-router", "test-big"],
    );
    deepStrictEqual(requests[0].reasoning, { effort: "none" });
    const messages = JSON.parse(requests[0].input[0].content);
    strictEqual(messages.length, 3);
    ok(messages[0].includes("earlier 8"));
    ok(messages[1].includes("earlier 9"));
    ok(messages[2].includes("please compare these"));
    strictEqual(scrolls[0].limit, 2);
    deepStrictEqual(scrolls[0].filter.must, [
      { key: "chat_id", match: { value: chat.id } },
      { key: "thread_id", match: { value: 7 } },
      { key: "message_id", range: { lte: ctx.message.message_id - 1 } },
    ]);
    const beforeAutomatic = sent;
    await safelyMaybeSendAutomaticResponse(ctx, ctx.message, sender, chat.id);
    strictEqual(sent, beforeAutomatic);
    route = "small";
    await receive("translate this");
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-router", "test-small"],
    );
    for (const text of [
      "laylo hello",
      "  ЛЕЙЛО: hello",
      "@test_bot hello",
      "tofu laylo hello",
    ]) {
      await receive(text);
      deepStrictEqual(
        requests.map((r) => r.model),
        ["test-small"],
      );
      strictEqual(scrolls.length, 0);
    }
    await receive("ordinary", { ...chat, id: -200 });
    strictEqual(requests.length, 0);
    await receive("/unknown");
    strictEqual(requests.length, 0);
    await receive("general topic", chat, false);
    ok(
      scrolls[0].filter.must.some(
        (condition) => condition.is_empty?.key === "thread_id",
      ),
    );
    route = "invalid";
    await receive("fallback");
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-router", "test-small"],
    );
    historyFails = true;
    await receive("history failed");
    strictEqual(requests.at(-1)?.model, "test-small");
    setLlmDeploymentName("router", "");
    await receive("not configured");
    strictEqual(requests.length, 0);
    setLlmDeploymentName("router", "test-router");
    await persistChatRouterEnabled(database, chat.id, false);
    await receive("disabled again");
    strictEqual(requests.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(LLM_DEPLOYMENTS))
      value.deploymentName = previous[key];
    await database.destroy();
  }
});

test("router enforces its verdict and reports tokens without exposing internal output", async () => {
  const originalFetch = globalThis.fetch;
  const previous = LLM_DEPLOYMENTS.router.deploymentName;
  let output = '{"model":"small"}',
    status = "completed",
    calls = 0;
  const events: Array<{
    status: string;
    input_tokens: number;
    output_tokens: number;
  }> = [];
  globalThis.fetch = (async (input, init) => {
    const body = await new Request(input, init).json();
    deepStrictEqual(JSON.parse(body.input[0].content), [
      "second",
      "third",
      "current",
    ]);
    strictEqual(body.model, "custom-router");
    deepStrictEqual(body.reasoning, { effort: "none" });
    strictEqual(body.tools, undefined);
    strictEqual(body.store, false);
    strictEqual(body.text.format.strict, true);
    return response(output, ++calls, status);
  }) as typeof fetch;
  const options = {
    telemetry: {
      chatType: "group" as const,
      mode: "normal" as const,
      emit: (event: (typeof events)[number]) => {
        events.push(event);
      },
    },
  };
  try {
    setLlmDeploymentName("router", "custom-router");
    strictEqual(
      await requestModelRoute(["first", "second", "third", "current"], options),
      "small",
    );
    output = '{"model":"large"}';
    strictEqual(
      await requestModelRoute(["second", "third", "current"], options),
      "large",
    );
    for (const invalid of [
      '{"model":"big"}',
      '{"model":"small","extra":1}',
      "{}",
      "[]",
      "null",
      "not JSON",
      "",
    ]) {
      output = invalid;
      await rejects(() =>
        requestModelRoute(["second", "third", "current"], options),
      );
    }
    output = '{"model":"small"}';
    status = "incomplete";
    await rejects(
      () => requestModelRoute(["second", "third", "current"], options),
      /routing failed/,
    );
    strictEqual(events[0].status, "success");
    strictEqual(events[0].input_tokens, 100);
    strictEqual(events[0].output_tokens, 5);
    strictEqual(events.at(-1)?.status, "failed");
    const before = calls;
    await rejects(() =>
      requestModelRoute(["current"], { signal: AbortSignal.abort() }),
    );
    strictEqual(calls, before);
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("router", previous);
  }
});
