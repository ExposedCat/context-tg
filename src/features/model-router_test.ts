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
const { banishAutomaticResponses } = await import("./banish.ts");
const { initDatabase } = await import("./database.ts");
const { LLM_DEPLOYMENTS, setLlmDeploymentName } = await import(
  "./llm-deployments.ts"
);
const { getChatRouterEnabled, persistChatRouterEnabled } = await import(
  "./llm-models.ts"
);
const { requestModelRoute } = await import("./llm.ts");
const { trollAgent } = await import("./agents/index.ts");
const { getUsageStatus } = await import("./usage.ts");
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

test("direct invocations bypass Smart replies while other mentions and forwards are filtered", async () => {
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
    responseSerial = 0,
    route = "large",
    shouldRespond = true;
  const requests: Array<{
    model: string;
    instructions: string;
    tools?: Array<{ name: string }>;
    reasoning?: unknown;
    input: Array<{ content: string }>;
  }> = [];
  const scrolls: Array<{
    limit: number;
    filter: { must: Array<{ is_empty?: { key: string } }> };
  }> = [];
  const replyTargets: Array<number | undefined> = [];
  api.sendChatAction = async () => true;
  api.sendRichMessage = async (_chatId, _richMessage, options) => {
    replyTargets.push(options?.reply_parameters?.message_id);
    return {
      message_id: 1000 + ++sent,
      date: 1,
      chat,
      from: bot,
      rich_message: { blocks: [{ type: "paragraph", text: "Answer" }] },
    };
  };
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "qdrant.test") {
      if (request.url.endsWith("/points/scroll")) {
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
                ...(id === 9 ? { reply_to_message_id: 8 } : {}),
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
        ? JSON.stringify({
            respond: shouldRespond,
            model: shouldRespond ? route : null,
          })
        : "Answer",
      ++responseSerial,
    );
  }) as typeof fetch;
  const receive = async (
    text: string | undefined,
    otherChat: NonNullable<Context["message"]>["chat"] = chat,
    topic = true,
    overrides: Record<string, unknown> = {},
  ) => {
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
          ...overrides,
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
    setLlmDeploymentName("openminded", "test-troll");
    strictEqual(await getChatRouterEnabled(database, chat.id), false);
    await receive("ordinary chat");
    strictEqual(passed, 1);
    strictEqual(requests.length, 0);
    await persistChatRouterEnabled(database, chat.id, true);
    const ctx = await receive("please compare these, laylo");
    ok(ctx.message);
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-router", "test-big"],
    );
    deepStrictEqual(requests[0].reasoning, { effort: "none" });
    const messages = JSON.parse(requests[0].input[0].content);
    strictEqual(messages.length, 1);
    ok(messages[0].includes("please compare these, laylo"));
    ok(
      requests[1].instructions.includes(
        `The sole current request and response target is message ${ctx.message.message_id}`,
      ),
    );
    ok(
      !requests[1].tools?.some((tool) => tool.name === "set_reply_message_id"),
    );
    strictEqual(replyTargets.at(-1), ctx.message.message_id);
    strictEqual(scrolls.length, 0);
    const beforeAutomatic = sent;
    await safelyMaybeSendAutomaticResponse(ctx, ctx.message, sender, chat.id);
    strictEqual(sent, beforeAutomatic);
    shouldRespond = false;
    const usageBefore = await getUsageStatus(database, chat.id);
    const tasksBefore = await database
      .selectFrom("tasks")
      .selectAll()
      .execute();
    for (const text of [
      "I mentioned laylo yesterday",
      "как думаете лейло умный или нет",
      "думаю лейло бы точно смог ответить",
    ]) {
      await receive(text);
      deepStrictEqual(
        requests.map((r) => r.model),
        ["test-router"],
      );
      strictEqual(sent, beforeAutomatic);
    }
    deepStrictEqual(await getUsageStatus(database, chat.id), usageBefore);
    deepStrictEqual(
      await database.selectFrom("tasks").selectAll().execute(),
      tasksBefore,
    );
    // No name in the latest message: do not ask the model, even if it would
    // approve a reply or earlier context contains an agent request.
    shouldRespond = true;
    for (const text of [
      "ordinary conversation",
      "я не шучу",
      "тест",
      "I see things which you do not",
      "братаны кто знает это правда что сега спасла нвидию",
    ]) {
      await receive(text, chat, true, {
        reply_to_message: {
          message_id: 10,
          date: 1,
          from: { id: 3, is_bot: false, first_name: "Daniel" },
          chat,
          text: "laylo, answer this older question",
        },
      });
      strictEqual(requests.length, 0);
      strictEqual(scrolls.length, 0);
      strictEqual(sent, beforeAutomatic);
    }
    // An unaddressed group photo is not an additional Smart replies trigger.
    await receive(undefined, chat, true, {
      photo: [{ file_id: "photo", width: 10, height: 10 }],
    });
    strictEqual(requests.length, 0);
    strictEqual(scrolls.length, 0);
    strictEqual(sent, beforeAutomatic);
    deepStrictEqual(await getUsageStatus(database, chat.id), usageBefore);
    deepStrictEqual(
      await database.selectFrom("tasks").selectAll().execute(),
      tasksBefore,
    );
    // Direct prefixes must answer even when the router would decline or fail.
    shouldRespond = false;
    route = "invalid";
    for (const [text, model] of [
      ["лейло грабзука или слингшот в коркипере", "test-small"],
      ["laylo hello", "test-small"],
      ["  ЛЕЙЛО: hello", "test-small"],
      ["@test_bot hello", "test-small"],
      ["tofu laylo hello", "test-small"],
      ["laylo was mentioned yesterday", "test-small"],
      ["@test_bot was offline yesterday", "test-small"],
      ["лейло бы точно смог ответить", "test-small"],
      [`${trollAgent.name[0]} hello`, "test-troll"],
    ]) {
      const sentBeforeDirect = sent;
      const direct = await receive(text);
      ok(direct.message);
      deepStrictEqual(
        requests.map((r) => r.model),
        [model],
      );
      strictEqual(sent, sentBeforeDirect + 1);
      strictEqual(replyTargets.at(-1), direct.message?.message_id);
      strictEqual(
        (
          await database
            .selectFrom("tasks")
            .select("status")
            .where("chat_id", "=", chat.id)
            .where("message_id", "=", direct.message.message_id)
            .executeTakeFirstOrThrow()
        ).status,
        "finished",
      );
    }
    // The reported follow-up must continue the saved normal conversation,
    // even when the Smart replies router would decline or return invalid JSON.
    const root = await receive(
      "лейло можно в коркипере шаман сет собрать или только шапка",
    );
    ok(root.message);
    const rootThread = await database
      .selectFrom("threads")
      .selectAll()
      .where("chat_id", "=", chat.id)
      .where("message_id", "=", root.message.message_id)
      .executeTakeFirstOrThrow();
    const followup = await receive("a waypoints можно крафтить", chat, true, {
      reply_to_message: {
        message_id: 1000 + sent,
        date: 1,
        chat,
        from: bot,
        text: "Только шапка — череп шамана (Shaman Skull).",
      },
    });
    ok(followup.message);
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-small"],
    );
    strictEqual(replyTargets.at(-1), followup.message.message_id);
    const followupThread = await database
      .selectFrom("threads")
      .selectAll()
      .where("chat_id", "=", chat.id)
      .where("message_id", "=", followup.message.message_id)
      .executeTakeFirstOrThrow();
    strictEqual(followupThread.thread_id, rootThread.thread_id);
    strictEqual(followupThread.agent_name, "лейло");
    const history = await database
      .selectFrom("llm_chat_responses")
      .selectAll()
      .where("response_id", "=", followupThread.response_id)
      .executeTakeFirstOrThrow();
    strictEqual(history.previous_response_id, rootThread.response_id);
    ok(JSON.stringify(requests[0].input).includes("шаман сет собрать"));
    ok(
      JSON.stringify(requests[0].input).includes("a waypoints можно крафтить"),
    );
    shouldRespond = true;
    route = "large";
    await receive(`${trollAgent.name[0]}, explain this`);
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-troll"],
    );
    route = "small";
    await receive("translate this, laylo");
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-router", "test-small"],
    );
    await receive("ordinary", { ...chat, id: -200 });
    strictEqual(requests.length, 0);
    await receive("/unknown");
    strictEqual(requests.length, 0);
    await receive("laylo, explain this general topic", chat, false);
    strictEqual(scrolls.length, 0);
    route = "invalid";
    const sentBeforeInvalid = sent;
    await receive("fallback, laylo");
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-router"],
    );
    strictEqual(sent, sentBeforeInvalid);
    route = "small";
    await receive("explain this, laylo");
    strictEqual(requests.at(-1)?.model, "test-small");
    strictEqual(JSON.parse(requests[0].input[0].content).length, 1);
    await receive("Переведи этот текст", chat, true, {
      reply_to_message: {
        message_id: 12,
        date: 1,
        chat,
        from: bot,
        text: "Text to translate",
      },
    });
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-small"],
    );
    await receive("переведи этот текст, laylo", chat, true, {
      reply_to_message: {
        message_id: 12,
        date: 1,
        chat,
        from: bot,
        text: "Text to translate",
      },
    });
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-small"],
    );
    const replyInput = JSON.stringify(requests[0].input);
    ok(replyInput.includes('in_reply_to_message id=\\"12\\"'));
    ok(replyInput.includes('sender_id=\\"42\\"'));
    ok(replyInput.includes("Text to translate"));
    await persistChatRouterEnabled(database, 1, true);
    await receive(
      "Напиши функцию сортировки на Python",
      {
        id: 1,
        type: "private",
        first_name: "User",
      },
      false,
    );
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-small"],
    );

    // Every forward is eligible without a name, but only one router attempt
    // may run for a chat's burst, even across topics and when it is declined.
    for (const allow of [false, true]) {
      const forwardChat = { ...chat, id: allow ? -301 : -300 };
      await persistChatRouterEnabled(database, forwardChat.id, true);
      shouldRespond = allow;
      const sentBeforeBurst = sent;
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          receive(
            index === 1 ? "explain this post, laylo" : "A forwarded post",
            forwardChat,
            true,
            {
              message_thread_id: 7 + index,
              forward_origin: {
                type: "channel",
                chat: { id: -900, type: "channel", title: "News" },
                message_id: index + 1,
                date: 1,
              },
            },
          ),
        ),
      );
      strictEqual(
        requests.filter((request) => request.model === "test-router").length,
        1,
      );
      strictEqual(sent - sentBeforeBurst, allow ? 1 : 0);
      ok(requests[0].instructions.includes("forwarded_post=true"));
      // Quoted forwards and the word 'forwarded' are not forward metadata.
      await receive("forwarded post", forwardChat, true, {
        reply_to_message: {
          message_id: 10,
          chat: forwardChat,
          date: 1,
          from: sender,
          forward_origin: {
            type: "hidden_user",
            sender_user_name: "Hidden",
            date: 1,
          },
        },
      });
      strictEqual(requests.length, 0);
      // Ordinary name mentions are independent of the forward cooldown.
      shouldRespond = true;
      await receive("laylo, answer this", forwardChat);
      deepStrictEqual(
        requests.map((request) => request.model),
        ["test-small"],
      );
      // Automatic forward replies remain blocked by the cooldown.
      await receive("explain this post, laylo", forwardChat, true, {
        forward_origin: {
          type: "hidden_user",
          sender_user_name: "Hidden",
          date: 1,
        },
      });
      strictEqual(requests.length, 0);
      // An explicit prefix still invokes the agent during that cooldown.
      const sentBeforeDirect = sent;
      await receive("laylo, explain this post", forwardChat, true, {
        forward_origin: {
          type: "hidden_user",
          sender_user_name: "Hidden",
          date: 1,
        },
      });
      deepStrictEqual(
        requests.map((r) => r.model),
        ["test-small"],
      );
      strictEqual(sent, sentBeforeDirect + 1);
    }
    const imageForwardChat = { ...chat, id: -302 };
    await persistChatRouterEnabled(database, imageForwardChat.id, true);
    shouldRespond = false;
    await receive(undefined, imageForwardChat, true, {
      forward_origin: {
        type: "hidden_user",
        sender_user_name: "Hidden",
        date: 1,
      },
      photo: [{ file_id: "forwarded-photo", width: 10, height: 10 }],
    });
    strictEqual(requests.length, 1);
    ok(requests[0].instructions.includes("forwarded_post=true"));
    ok(
      JSON.parse(requests[0].input[0].content)[0].includes(
        "<content></content>",
      ),
    );
    await receive("Another forwarded post", imageForwardChat, true, {
      forward_origin: {
        type: "hidden_user",
        sender_user_name: "Hidden",
        date: 1,
      },
    });
    strictEqual(requests.length, 0);
    shouldRespond = true;
    const albumForwardChat = { ...chat, id: -303 };
    await persistChatRouterEnabled(database, albumForwardChat.id, true);
    shouldRespond = false;
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        receive(undefined, albumForwardChat, true, {
          media_group_id: "forwarded-album",
          ...(index === 9 ? { caption: "Caption of the forwarded post" } : {}),
          forward_origin: {
            type: "hidden_user",
            sender_user_name: "Hidden",
            date: 1,
          },
          photo: [{ file_id: `album-${index}`, width: 10, height: 10 }],
        }),
      ),
    );
    strictEqual(requests.length, 1);
    ok(
      JSON.parse(requests[0].input[0].content)[0].includes(
        "Caption of the forwarded post",
      ),
    );
    shouldRespond = true;
    setLlmDeploymentName("router", "");
    await receive("not configured");
    strictEqual(requests.length, 0);
    setLlmDeploymentName("router", "test-router");
    await persistChatRouterEnabled(database, chat.id, false);
    await receive("disabled again");
    strictEqual(requests.length, 0);

    await persistChatRouterEnabled(database, chat.id, true);
    await banishAutomaticResponses(database, chat.id, {
      chat,
      is_topic_message: true,
      message_thread_id: 7,
    });
    await receive("unsolicited reply in a banished topic");
    strictEqual(requests.length, 0);
    strictEqual(scrolls.length, 0);
    await receive("laylo hello");
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-small"],
    );
    await receive(`${trollAgent.name[0]} hello`);
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-troll"],
    );
    await receive("laylo, explain this", chat, false);
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-small"],
    );
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
  let output = '{"respond":true,"model":"small"}',
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
    ok(body.instructions.includes('agent named "laylo", "лейло", "@test_bot"'));
    ok(body.instructions.includes("Default to respond=false"));
    ok(
      body.instructions.includes(
        "explicit request or question directed to the agent",
      ),
    );
    ok(body.instructions.includes("sole possible trigger and response target"));
    ok(body.instructions.includes("When uncertain whether to intervene"));
    ok(!body.instructions.includes("No explanation or additional fields"));
    ok(!body.instructions.includes("Respond with JSON exactly"));
    deepStrictEqual(body.text.format.schema.required, ["respond", "model"]);
    strictEqual(body.text.format.schema.additionalProperties, false);
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
  const names = ["laylo", "лейло", "@test_bot"];
  try {
    setLlmDeploymentName("router", "custom-router");
    deepStrictEqual(
      await requestModelRoute(
        ["first", "second", "third", "current"],
        names,
        options,
      ),
      { respond: true, model: "small" },
    );
    output = '{"respond":true,"model":"large"}';
    deepStrictEqual(
      await requestModelRoute(["second", "third", "current"], names, options),
      { respond: true, model: "large" },
    );
    output = '{"respond":false,"model":null}';
    deepStrictEqual(
      await requestModelRoute(["second", "third", "current"], names, options),
      { respond: false, model: null },
    );
    for (const invalid of [
      '{"model":"big"}',
      '{"model":"small","extra":1}',
      '{"respond":false,"model":"small"}',
      '{"respond":true,"model":null}',
      '{"respond":"false","model":null}',
      '{"respond":true,"model":"big"}',
      '{"respond":true,"model":"small","extra":1}',
      "{}",
      "[]",
      "null",
      "not JSON",
      "",
    ]) {
      output = invalid;
      await rejects(() =>
        requestModelRoute(["second", "third", "current"], names, options),
      );
    }
    output = '{"respond":true,"model":"small"}';
    status = "incomplete";
    await rejects(
      () => requestModelRoute(["second", "third", "current"], names, options),
      /routing failed/,
    );
    strictEqual(events[0].status, "success");
    strictEqual(events[0].input_tokens, 100);
    strictEqual(events[0].output_tokens, 5);
    strictEqual(events.at(-1)?.status, "failed");
    const before = calls;
    await rejects(() =>
      requestModelRoute(["current"], names, { signal: AbortSignal.abort() }),
    );
    strictEqual(calls, before);
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("router", previous);
  }
});
