import { jest, test } from "bun:test";
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

const { chatComposer, isSmartForwardUpdate } = await import("./chat.ts");
const { banishAutomaticResponses } = await import("./banish.ts");
const { initDatabase } = await import("./database.ts");
const { LLM_DEPLOYMENTS, setLlmDeploymentName } = await import(
  "./llm-deployments.ts"
);
const { getChatRouterEnabled, persistChatRouterEnabled } = await import(
  "./llm-models.ts"
);
const { requestModelRoute } = await import("./llm.ts");
const { normalAgent, trollAgent } = await import("./agents/index.ts");
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

const realSetImmediate = setImmediate;

async function receiveForwardBatch<T>(
  receive: () => T | Promise<T>,
): Promise<T> {
  jest.useFakeTimers();
  try {
    const pending = receive();
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    jest.advanceTimersByTime(2_000); // Flush any Telegram album first.
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    jest.advanceTimersByTime(2_000);
    return await pending;
  } finally {
    jest.useRealTimers();
  }
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
    goal = "answer",
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
            goal,
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
    strictEqual(
      requests[1].instructions,
      normalAgent.buildInstructions(chat.id),
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
      ["лейло грабзука или слингшот в коркипере", "test-big"],
      ["laylo hello", "test-big"],
      ["  ЛЕЙЛО: hello", "test-big"],
      ["@test_bot hello", "test-big"],
      ["laylo was mentioned yesterday", "test-big"],
      ["@test_bot was offline yesterday", "test-big"],
      ["лейло бы точно смог ответить", "test-big"],
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
      ["test-big"],
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
      ["test-big"],
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
      ["test-big"],
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
      ["test-big"],
    );

    for (const count of [10, 11, 13]) {
      const forwardChat = { ...chat, id: -300 - count };
      await persistChatRouterEnabled(database, forwardChat.id, true);
      shouldRespond = true;
      const sentBeforeBurst = sent;
      const usageBeforeBurst = await getUsageStatus(database, forwardChat.id);
      const forwards = await receiveForwardBatch(() =>
        Promise.all(
          Array.from({ length: count }, (_, index) =>
            receive(
              count === 11 && index === 10
                ? undefined
                : `Forwarded post #${index + 1}`,
              forwardChat,
              true,
              {
                forward_origin: {
                  type: "channel",
                  chat: { id: -900, type: "channel", title: "News" },
                  message_id: index + 1,
                  date: 1,
                },
              },
            ),
          ),
        ),
      );
      ok(
        (
          await Promise.all(
            forwards.map((ctx) => isSmartForwardUpdate(ctx, database)),
          )
        ).every(Boolean),
      );
      const routeRequests = requests.filter((r) => r.model === "test-router");
      deepStrictEqual(
        routeRequests.map((r) => JSON.parse(r.input[0].content).length),
        count === 10 ? [10] : [],
      );
      ok(
        routeRequests.every((r) =>
          r.instructions.includes("forwarded_batch=true"),
        ),
      );
      strictEqual(sent - sentBeforeBurst, count === 10 ? 1 : 0);
      if (count === 10) {
        const routedPosts: string[] = JSON.parse(
          routeRequests[0].input[0].content,
        );
        ok(
          routedPosts.every((post) =>
            post.includes('<forwarded_from sender="News" sender_id="-900"'),
          ),
        );
        const batchInput = JSON.stringify(requests[1].input);
        ok(!batchInput.includes("Fact-check the following post(s);"));
        ok(
          requests[1].input.some(({ content }) =>
            content.includes('<forwarded_from sender="News" sender_id="-900"'),
          ),
        );
        for (let i = 1; i <= count; i++) {
          ok(batchInput.includes(`Forwarded post #${i}</content>`));
        }
        strictEqual(replyTargets.at(-1), forwards[0].message?.message_id);
      } else {
        strictEqual(requests.length, 0);
        deepStrictEqual(
          await getUsageStatus(database, forwardChat.id),
          usageBeforeBurst,
        );
      }
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
      // Ordinary name mentions still get the direct reply path.
      shouldRespond = true;
      await receive("laylo, answer this", forwardChat);
      deepStrictEqual(
        requests.map((request) => request.model),
        ["test-big"],
      );
      // An explicit prefix still invokes the agent without batching.
      const sentBeforeDirect = sent;
      const directForward = await receive(
        "laylo, explain this post",
        forwardChat,
        true,
        {
          forward_origin: {
            type: "hidden_user",
            sender_user_name: "Hidden",
            date: 1,
          },
        },
      );
      strictEqual(await isSmartForwardUpdate(directForward, database), false);
      deepStrictEqual(
        requests.map((r) => r.model),
        ["test-big"],
      );
      strictEqual(sent, sentBeforeDirect + 1);
    }
    await receive("laylo, translate this quote", chat, true, {
      reply_to_message: {
        message_id: 10,
        chat,
        date: 1,
        from: sender,
        forward_sender_name: 'Alice & "Bob"',
        forward_date: 1,
        text: "Full original post",
      },
      quote: { text: "Original <excerpt>" },
    });
    const quotedForward = requests[0].input.find(({ content }) =>
      content.includes('<in_reply_to_message id="10"'),
    )?.content;
    ok(quotedForward);
    ok(
      quotedForward.includes(
        '    <forwarded_from sender="Alice &amp; &quot;Bob&quot;" date="',
      ),
    );
    ok(
      quotedForward.includes("    <excerpt>Original &lt;excerpt&gt;</excerpt>"),
    );
    ok(!quotedForward.includes("Full original post"));
    const topicChat = { ...chat, id: -304 };
    await persistChatRouterEnabled(database, topicChat.id, true);
    shouldRespond = false;
    await receiveForwardBatch(() =>
      Promise.all(
        [7, 8, 7].map((topic, index) =>
          receive(`Forward ${index + 1} in topic ${topic}`, topicChat, true, {
            message_thread_id: topic,
            forward_origin: {
              type: "hidden_user",
              sender_user_name: "Hidden",
              date: 1,
            },
          }),
        ),
      ),
    );
    const groupedByTopic = requests
      .map((request) => JSON.parse(request.input[0].content) as string[])
      .sort((left, right) => right.length - left.length);
    deepStrictEqual(
      groupedByTopic.map((posts) => posts.length),
      [2, 1],
    );
    ok(groupedByTopic[0].every((post) => post.includes("in topic 7")));
    ok(groupedByTopic[1][0].includes("in topic 8"));

    const imageForwardChat = { ...chat, id: -302 };
    await persistChatRouterEnabled(database, imageForwardChat.id, true);
    for (const origin of [
      { forward_origin: { type: "user", sender_user: sender, date: 1 } },
      { forward_origin: { type: "user", sender_user: bot, date: 1 } },
      { forward_from: sender, forward_date: 1 },
    ]) {
      const selfForward = await receiveForwardBatch(() =>
        receive(
          "A forwarded post that mentions laylo",
          imageForwardChat,
          true,
          origin,
        ),
      );
      strictEqual(await isSmartForwardUpdate(selfForward, database), false);
      strictEqual(requests.length, 0);
    }

    const xBot = { ...sender, id: 6361268755, is_bot: true };
    const xLink = "https://x.com/news/status/123";
    const richPost = (url: string) => ({
      blocks: [
        {
          type: "paragraph",
          text: [
            "A claim appeared today. ",
            { type: "url", text: "Source", url },
          ],
        },
      ],
    });
    for (const overrides of [
      { from: { ...xBot, id: 6361268756 }, rich_message: richPost(xLink) },
      { from: xBot, text: xLink },
      {
        from: xBot,
        rich_message: richPost("https://x.com.example.com/status/123"),
      },
      {
        from: xBot,
        rich_message: richPost(xLink),
        forward_origin: { type: "user", sender_user: xBot, date: 1 },
      },
    ]) {
      await receive(undefined, imageForwardChat, true, overrides);
      strictEqual(requests.length, 0);
    }
    const sentBeforeBotPost = sent;
    const botPost = { from: xBot, rich_message: richPost(xLink) };
    shouldRespond = false;
    await receive(undefined, imageForwardChat, true, botPost);
    deepStrictEqual(
      requests.map((request) => request.model),
      ["test-router"],
    );
    ok(requests[0].instructions.includes("forwarded_post=false"));
    ok(requests[0].instructions.includes("linked_bot_post=true"));
    ok(JSON.stringify(requests[0].input).includes(xLink));
    strictEqual(sent, sentBeforeBotPost);
    shouldRespond = true;
    await receive(undefined, imageForwardChat, true, botPost);
    deepStrictEqual(
      requests.map((request) => request.model),
      ["test-router"],
    );
    strictEqual(sent, sentBeforeBotPost);
    goal = "factcheck";
    await receive(undefined, imageForwardChat, true, botPost);
    deepStrictEqual(
      requests.map((request) => request.model),
      ["test-router", "test-small"],
    );
    ok(
      JSON.stringify(requests[1].input).includes(
        "Fact-check the following post(s);",
      ),
    );
    ok(JSON.stringify(requests[1].input).includes(xLink));
    strictEqual(sent, sentBeforeBotPost + 1);
    goal = "answer";
    shouldRespond = false;
    await receiveForwardBatch(() =>
      receive(undefined, imageForwardChat, true, {
        forward_origin: {
          type: "hidden_user",
          sender_user_name: "Hidden",
          date: 1,
        },
        photo: [{ file_id: "forwarded-photo", width: 10, height: 10 }],
      }),
    );
    strictEqual(requests.length, 1);
    ok(requests[0].instructions.includes("forwarded_post=true"));
    ok(
      JSON.parse(requests[0].input[0].content)[0].includes(
        "<content></content>",
      ),
    );
    await receiveForwardBatch(() =>
      receive("Another forwarded post", imageForwardChat, true, {
        forward_origin: {
          type: "hidden_user",
          sender_user_name: "Hidden",
          date: 1,
        },
      }),
    );
    strictEqual(requests.length, 1);
    shouldRespond = true;
    const albumForwardChat = { ...chat, id: -303 };
    await persistChatRouterEnabled(database, albumForwardChat.id, true);
    shouldRespond = false;
    await receiveForwardBatch(() =>
      Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          receive(undefined, albumForwardChat, true, {
            media_group_id: "forwarded-album",
            ...(index === 9
              ? { caption: "Caption of the forwarded post" }
              : {}),
            forward_origin: {
              type: "hidden_user",
              sender_user_name: "Hidden",
              date: 1,
            },
            photo: [{ file_id: `album-${index}`, width: 10, height: 10 }],
          }),
        ),
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
      ["test-big"],
    );
    await receive(`${trollAgent.name[0]} hello`);
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-troll"],
    );
    await receive("laylo, explain this", chat, false);
    deepStrictEqual(
      requests.map((r) => r.model),
      ["test-big"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(LLM_DEPLOYMENTS))
      value.deploymentName = previous[key];
    await database.destroy();
  }
});

test("routing goals preserve ordinary answers and prepend the exact fact-check request before posts", async () => {
  const { saveThread } = await import("./threads.ts");
  const { saveLlmResponseInputItems } = await import("./llm-chat-responses.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const previous = {
    small: LLM_DEPLOYMENTS.small.deploymentName,
    router: LLM_DEPLOYMENTS.router.deploymentName,
  };
  const factcheckText = "Fact-check the following post(s)";
  const sender = {
    id: 1,
    is_bot: false,
    first_name: "Forwarder",
    username: "caller",
  };
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Bot",
    username: "test_bot",
  } as Context["me"];
  const api = new Api("test");
  let goal: "answer" | "factcheck" = "answer";
  let respond = true,
    serial = 0,
    sent = 0,
    downloads = 0;
  let batchReplyTarget: number | undefined;
  const requests: Array<{
    model: string;
    instructions: string;
    input: Array<{
      role: string;
      content:
        | string
        | Array<{ type: string; text?: string; image_url?: string }>;
    }>;
  }> = [];
  api.sendChatAction = async () => true;
  api.sendRichMessage = async (chatId, _content, options) => {
    strictEqual(
      options?.reply_parameters?.message_id,
      batchReplyTarget ?? 100 + serial,
    );
    return {
      message_id: 1000 + ++sent,
      date: 1,
      from: bot,
      chat: { id: Number(chatId), type: "supergroup", title: "Test" },
      rich_message: { blocks: [] },
    };
  };
  api.getFile = async (fileId) => ({
    file_id: fileId,
    file_unique_id: fileId,
    file_path: "photos/post.jpg",
  });
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "api.telegram.org") {
      downloads++;
      return new Response(new Uint8Array([0]), {
        headers: { "content-type": "image/jpeg" },
      });
    }
    strictEqual(request.url, "https://llm.test/v1/responses");
    const body = await request.json();
    requests.push(body);
    return response(
      body.model === "goal-router"
        ? JSON.stringify({ respond, model: respond ? "small" : null, goal })
        : "Done",
      2000 + requests.length + serial * 10,
    );
  }) as typeof fetch;
  try {
    setLlmDeploymentName("router", "goal-router");
    setLlmDeploymentName("small", "goal-answer");
    for (const selectedGoal of ["answer", "factcheck"] as const) {
      goal = selectedGoal;
      for (const continuing of [false, true]) {
        for (const image of [false, true]) {
          serial++;
          requests.length = 0;
          downloads = 0;
          const chat = {
            id: -1000 - serial,
            type: "supergroup",
            title: "Test",
          } as const;
          await persistChatRouterEnabled(database, chat.id, true);
          const parent = {
            message_id: 10,
            date: 1,
            chat,
            reply_to_message: undefined,
            from: { id: 3, is_bot: false, first_name: "Participant" },
            text: "Earlier background",
          };
          if (continuing) {
            await saveLlmResponseInputItems(database, {
              responseId: `previous_${serial}`,
              inputItems: [
                { type: "message", role: "user", content: "Saved background" },
              ],
            });
            await saveThread(database, {
              chat_id: chat.id,
              message_id: 10,
              thread_id: 10,
              agent_id: "normal",
              agent_name: normalAgent.name[0],
              response_id: `previous_${serial}`,
            });
          }
          const message = {
            message_id: 100 + serial,
            date: 1700000000,
            chat,
            from: sender,
            forward_origin: {
              type: "channel" as const,
              date: 1,
              chat: {
                id: -9999,
                type: "channel" as const,
                title: "Original author",
              },
              message_id: 1,
            },
            ...(image
              ? {
                  caption: "Forwarded content",
                  photo: [
                    {
                      file_id: `post_${serial}`,
                      file_unique_id: `post_${serial}`,
                      width: 10,
                      height: 10,
                    },
                  ],
                }
              : { text: "Forwarded content" }),
            ...(continuing ? { reply_to_message: parent } : {}),
          };
          const ctx = new GrammyContext(
            { update_id: serial, message },
            api,
            bot,
          ) as Context;
          ctx.database = database;
          ctx.telemetry = { event: () => {} } as Context["telemetry"];
          await receiveForwardBatch(() =>
            chatComposer.middleware()(ctx, async () => {
              throw new Error("Forward should be handled");
            }),
          );
          deepStrictEqual(
            requests.map((request) => request.model),
            ["goal-router", "goal-answer"],
          );
          const answer = requests[1];
          strictEqual(
            answer.instructions,
            normalAgent.buildInstructions(chat.id, normalAgent.name[0]),
          );
          const userMessages = answer.input.filter(
            (item) => item.role === "user",
          );
          const textOf = (item: (typeof userMessages)[number]) =>
            typeof item.content === "string"
              ? item.content
              : item.content
                  .filter((part) => part.type === "input_text")
                  .map((part) => part.text)
                  .join("\n");
          const postMessage = userMessages.at(-1);
          ok(postMessage);
          const post = textOf(postMessage);
          ok(post.includes("Forwarded content"));
          const injected = userMessages.filter((item) =>
            textOf(item).includes(factcheckText),
          );
          strictEqual(injected.length, goal === "factcheck" ? 1 : 0);
          if (goal === "factcheck") {
            const instructionMessage = userMessages.at(-2);
            ok(instructionMessage);
            const instruction = textOf(instructionMessage);
            ok(
              instruction
                .match(/<content>([\s\S]*?)<\/content>/)?.[1]
                ?.startsWith(factcheckText),
            );
            strictEqual(
              instruction.match(/<message\b[^>]*>/)?.[0],
              post.match(/<message\b[^>]*>/)?.[0],
            );
            ok(instruction.includes(`id="${message.message_id}"`));
            ok(
              instruction.includes(
                'sender="Forwarder (@caller)" sender_id="1"',
              ),
            );
            ok(!instruction.includes("Original author"));
          }
          const imageParts = userMessages
            .flatMap((item) =>
              typeof item.content === "string" ? [] : item.content,
            )
            .filter((part) => part.type === "input_image");
          strictEqual(imageParts.length, image ? 1 : 0);
          strictEqual(downloads, image ? 1 : 0);
          const checkpoint = await database
            .selectFrom("llm_chat_responses")
            .select("messages")
            .where(
              "response_id",
              "=",
              `resp_router_${2000 + requests.length + serial * 10}`,
            )
            .executeTakeFirstOrThrow();
          strictEqual(
            checkpoint.messages.split(factcheckText).length - 1,
            goal === "factcheck" ? 1 : 0,
          );
        }
      }
    }
    // A declined factcheck verdict must not invoke the answering agent.
    respond = false;
    goal = "factcheck";
    serial++;
    requests.length = 0;
    const chat = {
      id: -1000 - serial,
      type: "supergroup",
      title: "Test",
    } as const;
    await persistChatRouterEnabled(database, chat.id, true);
    const ctx = new GrammyContext(
      {
        update_id: serial,
        message: {
          message_id: 100 + serial,
          date: 1,
          chat,
          from: sender,
          text: "Forwarded content",
          forward_origin: {
            type: "hidden_user",
            sender_user_name: "Hidden",
            date: 1,
          },
        },
      },
      api,
      bot,
    ) as Context;
    ctx.database = database;
    ctx.telemetry = { event: () => {} } as Context["telemetry"];
    await receiveForwardBatch(() =>
      chatComposer.middleware()(ctx, async () => {}),
    );
    strictEqual(requests.length, 1);
    strictEqual(sent, 8);

    respond = true;
    goal = "factcheck";
    requests.length = 0;
    downloads = 0;
    batchReplyTarget = 202;
    await receiveForwardBatch(() =>
      Promise.all(
        [false, true, false].map(async (textOnly, index) => {
          const messageId = 201 + index;
          const ctx = new GrammyContext(
            {
              update_id: messageId,
              message: {
                chat,
                message_id: messageId,
                date: 1,
                from: { ...sender, id: index + 1 },
                forward_origin: {
                  type: "hidden_user",
                  sender_user_name: "Hidden",
                  date: 1,
                },
                ...(textOnly
                  ? { text: `post ${messageId}` }
                  : {
                      caption: `post ${messageId}`,
                      photo: [
                        {
                          file_id: `photo-${messageId}`,
                          file_unique_id: `unique-photo-${messageId}`,
                          width: 10,
                          height: 10,
                        },
                      ],
                    }),
              },
            },
            api,
            bot,
          ) as Context;
          ctx.database = database;
          ctx.telemetry = { event: () => {} } as Context["telemetry"];
          await chatComposer.middleware()(ctx, async () => {
            throw new Error("Forward should be handled");
          });
        }),
      ),
    );
    strictEqual(sent, 9);
    strictEqual(downloads, 2);
    strictEqual(requests.length, 2);
    const userMessages = requests[1].input.filter(
      (item) => item.role === "user",
    );
    const [instruction, ...posts] = userMessages.slice(-4);
    ok(typeof instruction.content === "string");
    ok(
      instruction.content
        .match(/<content>([\s\S]*?)<\/content>/)?.[1]
        ?.startsWith(factcheckText),
    );
    deepStrictEqual(
      posts.map((post) =>
        typeof post.content === "string"
          ? 0
          : post.content.filter((part) => part.type === "input_image").length,
      ),
      [1, 0, 1],
    );
    for (const [index, post] of posts.entries()) {
      ok(JSON.stringify(post.content).includes(`post ${201 + index}`));
    }
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("router", previous.router);
    setLlmDeploymentName("small", previous.small);
    await database.destroy();
  }
});

test("ignore ends the turn and preserves a like even if thinking is in flight", async () => {
  const { getLlmResponseInputItems } = await import("./llm-chat-responses.ts");
  const { getTask } = await import("./tasks.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const previousBig = LLM_DEPLOYMENTS.big.deploymentName;
  const api = new Api("test");
  const chat = { id: -100, type: "supergroup", title: "Test" } as const;
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Bot",
    username: "test_bot",
  } as Context["me"];
  const reactions: Array<[number, unknown]> = [];
  let thinking = Promise.withResolvers<true>();
  let modelCalls = 0;
  let sentMessages = 0;
  api.sendChatAction = async () => true;
  api.setMessageReaction = async (chatId, messageId, reaction) => {
    strictEqual(chatId, chat.id);
    reactions.push([messageId, reaction]);
    return reaction?.[0]?.type === "emoji" && reaction[0].emoji === "🤔"
      ? thinking.promise
      : true;
  };
  api.sendRichMessage = async () => {
    sentMessages++;
    return {
      message_id: 1000,
      date: 1,
      chat,
      from: bot,
      rich_message: { blocks: [] },
    };
  };

  jest.useFakeTimers();
  try {
    setLlmDeploymentName("big", "ignore-answer");
    for (const [messageId, mode, like] of [
      [1, "fast", false],
      [2, "slow", false],
      [3, "guest", false],
      [4, "slow", true],
      [5, "guest", true],
    ] as const) {
      thinking = Promise.withResolvers<true>();
      const requested = Promise.withResolvers<void>();
      const finishModel = Promise.withResolvers<void>();
      globalThis.fetch = (async (input, init) => {
        const request = new Request(input, init);
        strictEqual(request.url, "https://llm.test/v1/responses");
        strictEqual(++modelCalls, messageId);
        const body = await request.json();
        ok(body.tools.some((tool: { name: string }) => tool.name === "ignore"));
        ok(body.tools.some((tool: { name: string }) => tool.name === "like"));
        ok(body.instructions.includes("call like together with ignore"));
        requested.resolve();
        await finishModel.promise;
        const result = await response(
          "Do not send this text",
          3000 + messageId,
        ).json();
        for (const name of like ? ["ignore", "like"] : ["ignore"]) {
          result.output.push({
            type: "function_call",
            name,
            call_id: `call_${name}_${messageId}`,
            arguments: "{}",
            status: "completed",
          });
        }
        return Response.json(result);
      }) as typeof fetch;
      const message = {
        message_id: messageId,
        date: 1,
        chat,
        from: { id: 1, is_bot: false, first_name: "User" },
        text: like ? "laylo, just like this" : "laylo, don't respond",
      };
      const ctx = new GrammyContext(
        mode === "guest"
          ? { update_id: messageId, guest_message: message }
          : { update_id: messageId, message },
        api,
        bot,
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      ctx.answerGuestQuery = async () => {
        sentMessages++;
        return { inline_message_id: "test" };
      };
      const pending = chatComposer.middleware()(ctx, async () => {
        throw new Error("The invocation should be handled");
      });
      await requested.promise;
      if (mode === "slow") {
        jest.advanceTimersByTime(5_000);
        deepStrictEqual(reactions.splice(0), [
          [messageId, [{ type: "emoji", emoji: "🤔" }]],
        ]);
      }
      finishModel.resolve();
      if (mode === "slow") {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
        deepStrictEqual(reactions, []);
        thinking.resolve(true);
      }
      await pending;
      deepStrictEqual(reactions.splice(0), [
        [messageId, [{ type: "emoji", emoji: like ? "👍" : "👌" }]],
      ]);
      if (mode !== "guest") {
        const task = await getTask(database, {
          chat_id: chat.id,
          message_id: messageId,
        });
        strictEqual(task?.status, "finished");
      }
      const history = await getLlmResponseInputItems(
        database,
        `resp_router_${3000 + messageId}`,
      );
      ok(
        history?.some(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === `call_ignore_${messageId}` &&
            String(item.output).includes('"ignored"'),
        ),
      );
      ok(!JSON.stringify(history).includes("Do not send this text"));
      if (like) {
        ok(
          history?.some(
            (item) =>
              item.type === "function_call_output" &&
              item.call_id === `call_like_${messageId}` &&
              String(item.output).includes('"liked":true'),
          ),
        );
      }
    }
    strictEqual(sentMessages, 0);
    strictEqual(modelCalls, 5);
  } finally {
    thinking.resolve(true);
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("big", previousBig);
    await database.destroy();
  }
});

test("router enforces its verdict and reports tokens without exposing internal output", async () => {
  const originalFetch = globalThis.fetch;
  const previous = LLM_DEPLOYMENTS.router.deploymentName;
  let output = '{"respond":true,"model":"small","goal":"answer"}',
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
    deepStrictEqual(body.text.format.schema.required, [
      "respond",
      "model",
      "goal",
    ]);
    strictEqual(body.text.format.schema.additionalProperties, false);
    deepStrictEqual(body.text.format.schema.properties.goal, {
      type: "string",
      enum: ["answer", "factcheck"],
    });
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
      { respond: true, model: "small", goal: "answer" },
    );
    output = '{"respond":true,"model":"large","goal":"factcheck"}';
    deepStrictEqual(
      await requestModelRoute(["second", "third", "current"], names, options),
      { respond: true, model: "large", goal: "factcheck" },
    );
    output = '{"respond":false,"model":null,"goal":"answer"}';
    deepStrictEqual(
      await requestModelRoute(["second", "third", "current"], names, options),
      { respond: false, model: null, goal: "answer" },
    );
    for (const invalid of [
      '{"model":"big"}',
      '{"model":"small","extra":1}',
      '{"respond":false,"model":"small","goal":"answer"}',
      '{"respond":true,"model":null,"goal":"answer"}',
      '{"respond":"false","model":null,"goal":"answer"}',
      '{"respond":true,"model":"big","goal":"answer"}',
      '{"respond":true,"model":"small","goal":"answer","extra":1}',
      '{"respond":true,"model":"small"}',
      '{"respond":true,"model":"small","goal":null}',
      '{"respond":true,"model":"small","goal":true}',
      '{"respond":true,"model":"small","goal":"summarize"}',
      '{"respond":false,"model":null}',
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
    output = '{"respond":true,"model":"small","goal":"answer"}';
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
