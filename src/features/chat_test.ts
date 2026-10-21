import { test } from "bun:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { I18n } from "@grammyjs/i18n";
import { Api, Context as GrammyContext } from "grammy";
import type { Context } from "../bot.ts";

const TEST_ENV = {
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  LLM_STREAMING: "false",
  LLM_TEMPERATURE: "0.2",
  LLM_MAX_USER_INPUT_TOKENS: "5000",
  KEENABLE_API_KEY: "test",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test-embedding",
  QDRANT_URL: "https://qdrant.test",
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Bun.env[name] = value;
}

const [
  {
    buildGuestRichMessage,
    chatComposer,
    formatLlmToolError,
    formatModelFailureResponse,
    getAzureDownMessage,
    getErrorRecoveryPrompt,
    getMessagesImageAttachments,
    getUserInputLimitError,
    isUnavailableRichMessagePhotoError,
  },
  { initDatabase },
  { saveImageFileId },
] = await Promise.all([
  import("./chat.ts"),
  import("./database.ts"),
  import("./images.ts"),
]);

test("raw model newlines survive chat delivery and Telegram HTTP serialization", async () => {
  const { setLlmDeploymentName } = await import("./llm-deployments.ts");
  const { createEmojiPackTransformer } = await import("./emoji-packs.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const chat = { id: -1, type: "supergroup", title: "Test" } as const;
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
  } as Context["me"];
  const sent: string[] = [];
  const api = new Api("test", {
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/sendRichMessage")) {
        // Inspect the serialized HTTP body, after grammY and API transformers.
        const payload = JSON.parse(String(init?.body));
        sent.push(payload.rich_message.markdown);
        return Response.json({
          ok: true,
          result: {
            message_id: 100 + sent.length,
            date: 0,
            chat,
            from: bot,
            rich_message: { blocks: [{ type: "paragraph", text: "Sent" }] },
          },
        });
      }
      ok(String(url).endsWith("/sendChatAction"));
      return Response.json({ ok: true, result: true });
    },
  });
  api.config.use(createEmojiPackTransformer(database, api));
  const fixtures = [
    // Actual assistant text recovered from the reported response's history.
    [
      "**Основа реальная, но «ни одно фото не отредактировано» — не доказано.**",
      "",
      "• Слева — Барбера Торнхилл: такой портрет действительно опубликован [Госдепом](https://x.com/StateDRL/status/2109999025604698420). Официальная публикация, однако, не гарантирует отсутствие ретуши.",
      "• В центре — Келли Леффлер, глава SBA. Кадр связан с [роликом официального аккаунта ведомства](https://www.tiktok.com/@sbagov/video/7673494995348884749), который [разбирала Mediaite](https://mediaite.com/media/news/trump-appointee-roasted-over-video-of-her-stiffly-walking-by-pics-of-herself-this-has-to-be-ai-right). Само существование ролика не доказывает, что пропорции в этом меме не меняли.",
      "• Правая фотография обрезана — её по этому скрину надёжно не проверить.",
      "",
      "**Итог: не очевидный ИИ-фейк, но подпись выдаёт непроверенное утверждение за факт.**",
    ].join("\n"),
    "Intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nConclusion",
    "First line\nsecond line\n\nNext paragraph\n\n- First\n- Second",
    "First **line**<br>second line\n\nNext paragraph",
    'Intro\n\n<table bordered striped>\n<tr><th align="left">Item</th><th align="right">Value</th></tr>\n<tr><td align="left">Example</td><td align="right"><b>42</b></td></tr>\n</table>\n\nConclusion',
  ];
  let responseText = "";
  globalThis.fetch = (async () =>
    Response.json({
      id: `resp_newlines_${sent.length}`,
      object: "response",
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      created_at: 1,
      status: "completed",
      output: [
        {
          id: `msg_newlines_${sent.length}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: responseText, annotations: [] },
          ],
        },
      ],
    })) as unknown as typeof fetch;

  try {
    setLlmDeploymentName("small", "test-model");
    for (const [index, fixture] of fixtures.entries()) {
      responseText = fixture;
      const ctx = new GrammyContext(
        {
          update_id: index + 1,
          message: {
            message_id: index + 1,
            date: 0,
            from: { id: 1, is_bot: false, first_name: "User" },
            chat,
            text: "лейло check formatting",
          },
        },
        api,
        bot,
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      await chatComposer.middleware()(ctx, () => {
        throw new Error("Named trigger should be handled");
      });
      strictEqual(sent.length, index + 1);
      strictEqual(sent[index], fixture);
    }
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("small", "");
    await database.destroy();
  }
});

test("Danbooru suffixes are hidden in chat history and override searches for only the current message", async () => {
  const { setLlmDeploymentName } = await import("./llm-deployments.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const chat = { id: 1, type: "private", first_name: "User" } as const;
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
  } as Context["me"];
  const searches: string[] = [];
  const modelInputs: string[] = [];
  let modelCalls = 0;
  let sent = 0;
  const api = new Api("test", {
    fetch: async (url: string | URL | Request) => {
      if (String(url).endsWith("/sendRichMessage")) {
        sent++;
        return Response.json({
          ok: true,
          result: {
            message_id: 100 + sent,
            date: 0,
            chat,
            from: bot,
            rich_message: { blocks: [{ type: "paragraph", text: "Found it" }] },
          },
        });
      }
      ok(String(url).endsWith("/sendChatAction"));
      return Response.json({ ok: true, result: true });
    },
  });
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "danbooru.donmai.us") {
      searches.push(url.searchParams.get("tags") ?? "");
      return Response.json([]);
    }
    strictEqual(url.href, `${TEST_ENV.LLM_BASE_URL}/responses`);
    const body = await request.json();
    modelInputs.push(JSON.stringify(body.input));
    ok(
      body.tools.some(
        (tool: { name: string }) => tool.name === "search_danbooru",
      ),
    );
    ok(
      body.tools.some(
        (tool: { name: string }) => tool.name === "search_danbooru_tags",
      ),
    );
    modelCalls++;
    const output =
      modelCalls % 2 === 1
        ? [
            {
              id: `fc_danbooru_${modelCalls}`,
              type: "function_call",
              call_id: `call_danbooru_${modelCalls}`,
              name: "search_danbooru",
              arguments: JSON.stringify(
                modelCalls === 7
                  ? { tags: "pigeon" }
                  : {
                      tags: "pigeon rating:e order:random",
                      rating: "q",
                      order: "id",
                    },
              ),
              status: "completed",
            },
          ]
        : [
            {
              id: `msg_danbooru_${modelCalls}`,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Found it", annotations: [] },
              ],
            },
          ];
    return Response.json({
      id: `resp_danbooru_${modelCalls}`,
      object: "response",
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      created_at: 1,
      status: "completed",
      output,
    });
  }) as typeof fetch;

  try {
    setLlmDeploymentName("small", "test-model");
    const cases = [
      { text: "find pigeon art /rating:Unknown:Value /order:score" },
      { caption: "find more art /order:rank", video: {} },
      { text: "find another pigeon" },
      { text: "find explicit art /rating:e" },
    ];
    for (const [index, fixture] of cases.entries()) {
      const ctx = new GrammyContext(
        {
          update_id: index + 1,
          message: {
            message_id: index + 1,
            date: 0,
            from: { id: 1, is_bot: false, first_name: "User" },
            chat,
            ...fixture,
          },
        } as ConstructorParameters<typeof GrammyContext>[0],
        api,
        bot,
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      await chatComposer.middleware()(ctx, () => {
        throw new Error("Private request should be handled");
      });
      strictEqual(sent, index + 1);
    }
    deepStrictEqual(searches, [
      "pigeon rating:Unknown:Value order:score",
      "pigeon rating:q order:rank",
      "pigeon rating:q order:id",
      "pigeon rating:e order:score",
    ]);
    ok(modelInputs[0].includes("find pigeon art (use danbooru)"));
    ok(!modelInputs[0].includes("Unknown:Value"));
    ok(modelInputs[2].includes("find more art (use danbooru)"));
    const explicitText =
      "find explicit art (use only danbooru, don't search web, you are strictly unallowed to view images yourself due to licensing, send it to user directly and notify)";
    ok(modelInputs[6].includes(explicitText));
    const lastToolResult = JSON.parse(modelInputs[7]).findLast(
      (item: { type: string }) => item.type === "function_call_output",
    );
    ok(lastToolResult.output.includes('"skip_image_inspection":true'));
    ok(!lastToolResult.output.includes('required_next_tool="read_image"'));
    for (const input of modelInputs) {
      ok(!input.includes("/rating:"));
      ok(!input.includes("/order:"));
    }
    const history = await database
      .selectFrom("llm_chat_responses")
      .select("messages")
      .execute();
    ok(
      history.some((row) =>
        row.messages.includes("find pigeon art (use danbooru)"),
      ),
    );
    ok(
      history.some((row) =>
        row.messages.includes("find more art (use danbooru)"),
      ),
    );
    for (const row of history) {
      ok(!row.messages.includes("/rating:"));
      ok(!row.messages.includes("/order:"));
    }
    const tasks = await database
      .selectFrom("tasks")
      .select("task_text")
      .orderBy("message_id")
      .execute();
    deepStrictEqual(
      tasks.map((task) => task.task_text),
      [
        "find pigeon art (use danbooru)",
        "find more art (use danbooru)",
        "find another pigeon",
        explicitText,
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("small", "");
    await database.destroy();
  }
});

test("messages dropped for missing mentions still emit analytics once", async () => {
  const ctx = new GrammyContext(
    {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        from: { id: 1, is_bot: false, first_name: "User" },
        chat: { id: -1, type: "supergroup", title: "Test" },
        text: "Just chatting without addressing the bot",
      },
    },
    new Api("test"),
    {
      id: 42,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  ) as Context;
  const events: unknown[] = [];
  ctx.telemetry = {
    event: (name, payload) => {
      events.push({ name, payload });
    },
  } as Context["telemetry"];
  let nextCalls = 0;

  await chatComposer.middleware()(ctx, () => {
    nextCalls++;
    return Promise.resolve();
  });

  deepStrictEqual(events, [
    {
      name: "message_checked",
      payload: { chat_type: "group", mode: "normal", mentioned: false },
    },
  ]);
  strictEqual(nextCalls, 1);
});

test("trigger aliases persist through replies and update on explicit triggers", async () => {
  const { getThread, migrateThreads } = await import("./threads.ts");
  const { setLlmDeploymentName } = await import("./llm-deployments.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const instructions: string[] = [];
  const chat = { id: -1, type: "supergroup", title: "Test" } as const;
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
  } as Context["me"];
  const api = new Api("test");
  let sentMessageId = 100;
  api.sendRichMessage = async () => ({
    message_id: ++sentMessageId,
    date: 0,
    chat,
    from: bot,
    rich_message: { blocks: [{ type: "paragraph", text: "Done." }] },
  });
  api.sendChatAction = () => Promise.resolve(true);
  globalThis.fetch = (async (_input, init) => {
    const payload = JSON.parse(String(init?.body));
    instructions.push(payload.instructions);
    return new Response(
      JSON.stringify({
        id: `resp_alias_${instructions.length}`,
        object: "response",
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        created_at: 1,
        status: "completed",
        output: [
          {
            id: `msg_alias_${instructions.length}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done.", annotations: [] }],
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    // Simulate upgrading a database created before aliases were stored.
    await database.schema
      .alterTable("threads")
      .dropColumn("agent_name")
      .execute();
    await migrateThreads(database);
    await migrateThreads(database);
    setLlmDeploymentName("small", "test-model");
    const cases = [
      { text: "ЛЕЙЛО: hello", name: "лейло", agent: "normal" },
      { text: "continue", name: "лейло", agent: "normal" },
      { text: "laylo hello", name: "laylo", agent: "normal" },
      { text: "тофу лейло hello", name: "тофу лейло", agent: "tofu" },
      { text: "continue", name: "тофу лейло", agent: "tofu" },
      { text: "@test_bot hello", name: "laylo", agent: "normal" },
    ];
    for (const [index, { text, name, agent }] of cases.entries()) {
      const ctx = new GrammyContext(
        {
          update_id: index + 1,
          message: {
            message_id: index + 1,
            date: 0,
            from: { id: 1, is_bot: false, first_name: "User" },
            chat,
            text,
            ...(index > 0
              ? {
                  reply_to_message: {
                    message_id: sentMessageId,
                    date: 0,
                    from: bot,
                    chat,
                    text: "Done.",
                    reply_to_message: undefined,
                  },
                }
              : {}),
          },
        },
        api,
        bot,
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      await chatComposer.middleware()(ctx, () => {
        throw new Error("Named trigger or reply should be handled");
      });
      strictEqual(instructions.length, index + 1);
      ok(
        instructions[index].includes(
          `named ${JSON.stringify(name)} with a goal`,
        ),
      );
      for (const messageId of [index + 1, sentMessageId]) {
        const thread = await getThread(database, {
          chat_id: chat.id,
          message_id: messageId,
        });
        strictEqual(thread?.agent_name, name);
        strictEqual(thread?.agent_id, agent);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("small", "");
    await database.destroy();
  }
});

test("group replies retain their parent and history scope while forum topics stay isolated", async () => {
  const { getThread } = await import("./threads.ts");
  const { setLlmDeploymentName } = await import("./llm-deployments.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const chat = { id: -1, type: "supergroup", title: "Test" } as const;
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Bot",
    username: "test_bot",
  } as Context["me"];
  const user = { id: 1, is_bot: false, first_name: "User" };
  const api = new Api("test");
  const deliveries: unknown[] = [];
  const requests: Array<{ input: unknown }> = [];
  const scrolls: Array<{ filter: { must: unknown[] } }> = [];
  let sentMessageId = 100;
  let callHistoryTool = true;
  api.sendChatAction = async () => true;
  api.sendRichMessage = async (_chatId, _text, options) => {
    deliveries.push(options);
    return {
      message_id: ++sentMessageId,
      date: 0,
      chat,
      from: bot,
      rich_message: { blocks: [{ type: "paragraph", text: "Done." }] },
    };
  };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.startsWith(TEST_ENV.QDRANT_URL)) {
      if (url.endsWith("/points/scroll")) {
        scrolls.push(payload);
        // Honor the filter: an ordinary reply-chain ID is not a topic.
        const scope = payload.filter.must.find(
          (part: { key: string }) => part.key === "thread_id",
        );
        const text =
          scope === undefined
            ? "Earlier group discussion"
            : scope.match.value === 70
              ? "Earlier forum discussion"
              : undefined;
        return Response.json({
          result: {
            points: text
              ? [
                  {
                    id: "history",
                    payload: {
                      text,
                      date: new Date(0).toISOString(),
                      date_timestamp: 0,
                      sender_name: "User",
                      sender_id: 1,
                      chat_id: chat.id,
                      message_id: 5,
                      ...(scope ? { thread_id: scope.match.value } : {}),
                    },
                  },
                ]
              : [],
          },
        });
      }
      return Response.json({ result: { payload_schema: {} } });
    }
    strictEqual(url, `${TEST_ENV.LLM_BASE_URL}/responses`);
    requests.push(payload);
    const output = callHistoryTool
      ? [
          {
            type: "function_call",
            id: `fc_${requests.length}`,
            call_id: `call_${requests.length}`,
            name: "read_last_messages",
            arguments: '{"count":10,"target":"topic_thread"}',
          },
        ]
      : [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done.", annotations: [] }],
          },
        ];
    callHistoryTool = !callHistoryTool;
    return Response.json({
      id: `resp_group_${requests.length}`,
      object: "response",
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      created_at: 1,
      status: "completed",
      output,
    });
  }) as typeof fetch;

  try {
    setLlmDeploymentName("small", "test-model");
    const cases = [
      {
        id: 20,
        topic: 7,
        replyId: 7,
        replyBot: false,
        text: "laylo explain this discussion",
        anchor: 7,
        scope: undefined,
        previous: null,
      },
      {
        id: 21,
        topic: 7,
        replyTopic: 7,
        replyId: 101,
        replyBot: true,
        text: "continue",
        anchor: 101,
        scope: undefined,
        previous: "resp_group_2",
      },
      {
        id: 22,
        replyTopic: 7,
        replyId: 7,
        replyBot: false,
        text: "laylo another question",
        anchor: 7,
        scope: undefined,
        previous: null,
      },
      {
        id: 23,
        topic: 8,
        replyId: 8,
        replyBot: true,
        text: "explain this reply",
        anchor: 8,
        scope: undefined,
        previous: null,
      },
      {
        id: 80,
        topic: 70,
        forum: true,
        replyId: 70,
        replyBot: false,
        text: "laylo explain this topic",
        anchor: undefined,
        scope: 70,
        previous: null,
      },
      {
        id: 81,
        replyTopic: 70,
        replyForum: true,
        replyId: 105,
        replyBot: true,
        text: "laylo explain this forum reply",
        anchor: 105,
        scope: 70,
        previous: "resp_group_10",
      },
    ];
    for (const [index, test] of cases.entries()) {
      const reply = {
        message_id: test.replyId,
        date: 0,
        chat,
        from: test.replyBot ? bot : user,
        text: `Parent ${test.replyId}`,
        message_thread_id: test.replyTopic,
        is_topic_message: test.replyForum,
        reply_to_message: undefined,
      };
      const ctx = new GrammyContext(
        {
          update_id: test.id,
          message: {
            message_id: test.id,
            date: 0,
            chat,
            from: user,
            text: test.text,
            message_thread_id: test.topic,
            is_topic_message: test.forum,
            reply_to_message: reply,
          },
        },
        api,
        bot,
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      await chatComposer.middleware()(ctx, async () => {
        throw new Error("Group request should be handled");
      });
      strictEqual(deliveries.length, index + 1);
      const requestText = JSON.stringify(requests[index * 2].input);
      if (test.anchor !== undefined)
        ok(requestText.includes(`Parent ${test.replyId}`) || test.previous);
      else ok(!requestText.includes(`Parent ${test.replyId}`));
      deepStrictEqual(scrolls[index].filter.must, [
        { key: "chat_id", match: { value: chat.id } },
        ...(test.scope !== undefined
          ? [{ key: "thread_id", match: { value: test.scope } }]
          : []),
        ...(test.anchor !== undefined
          ? [{ key: "message_id", range: { lte: test.anchor } }]
          : []),
      ]);
      ok(
        JSON.stringify(requests[index * 2 + 1].input).includes(
          test.scope === undefined
            ? "Earlier group discussion"
            : "Earlier forum discussion",
        ),
      );
      const history = await database
        .selectFrom("llm_chat_responses")
        .selectAll()
        .where("response_id", "=", `resp_group_${index * 2 + 1}`)
        .executeTakeFirstOrThrow();
      strictEqual(history.previous_response_id, test.previous);
      const thread = await getThread(database, {
        chat_id: chat.id,
        message_id: test.id,
      });
      ok(thread);
      const delivery = deliveries[index] as {
        message_thread_id?: number;
        reply_parameters: unknown;
      };
      strictEqual(delivery.message_thread_id, test.scope);
      deepStrictEqual(delivery.reply_parameters, {
        message_id: test.id,
        allow_sending_without_reply: true,
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("small", "");
    await database.destroy();
  }
});

test("DMs continue without mentions with or without topic IDs and preserve explicit reply branches", async () => {
  const { createPrivateTopicMiddleware } = await import("./private-topics.ts");
  const resolvePrivateTopic = createPrivateTopicMiddleware();
  const { getThread, migrateThreads } = await import("./threads.ts");
  const { maybeSendProactiveAgentResponse } = await import("./chat.ts");
  const { setLlmDeploymentName } = await import("./llm-deployments.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: unknown; instructions: string }> = [];
  const deliveries: unknown[] = [];
  const typing: unknown[] = [];
  const names: unknown[] = [];
  const nameRequests: Array<{ model: string; input: unknown }> = [];
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
    has_topics_enabled: true,
  } as Context["me"];
  const api = new Api("test");
  let currentMessageId = 0;
  const chat = { id: 1, type: "private", first_name: "User" } as const;
  let sendWithoutReply = false;
  api.sendRichMessage = async (_chatId, _message, options) => {
    deliveries.push(options);
    return {
      message_id: currentMessageId + 1,
      date: 0,
      chat,
      from: bot,
      rich_message: { blocks: [{ type: "paragraph", text: "Done." }] },
    };
  };
  api.sendChatAction = async (_chatId, _action, options) => {
    typing.push(options);
    return true;
  };
  api.getFile = async (fileId) => ({
    file_id: fileId,
    file_unique_id: "dm-photo",
    file_path: "photos/dm-photo.jpg",
  });
  api.editForumTopic = async (chatId, topicId, options) => {
    names.push({ chatId, topicId, name: options?.name });
    return true;
  };
  globalThis.fetch = (async (_input, init) => {
    if (String(_input).includes("/photos/dm-photo.jpg")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
      });
    }
    const payload = JSON.parse(String(init?.body));
    if (payload.instructions === "") {
      nameRequests.push(payload);
      if (payload.model === "test-troll-model") {
        return new Response(
          JSON.stringify({
            error: {
              message: "Title generation failed",
              type: "invalid_request_error",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          id: "resp_title",
          object: "response",
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "  Generated thread name  ",
                  annotations: [],
                },
              ],
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    requests.push(payload);
    const id = `resp_dm_${requests.length}`;
    const output = sendWithoutReply
      ? [
          {
            type: "function_call",
            id: "fc_dm_reply",
            call_id: "call_dm_reply",
            name: "set_reply_message_id",
            arguments: '{"message_id":null}',
          },
        ]
      : [
          {
            id: `msg_dm_${requests.length}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done.", annotations: [] }],
          },
        ];
    sendWithoutReply = false;
    return new Response(
      JSON.stringify({
        id,
        object: "response",
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        created_at: 1,
        status: "completed",
        output,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    setLlmDeploymentName("small", "test-model");
    setLlmDeploymentName("openminded", "test-troll-model");
    const cases = [
      {
        id: 10,
        topic: 7,
        text: "тофу лейло alpha secret",
        implicitCreation: true,
        previous: null,
        agent: "tofu",
        name: "тофу лейло",
      },
      {
        id: 20,
        topic: 8,
        text: "beta secret",
        implicitCreation: true,
        previous: null,
        agent: "normal",
        name: "laylo",
        noReply: true,
      },
      {
        id: 30,
        topic: 7,
        text: "continue alpha",
        previous: "resp_dm_1",
        agent: "tofu",
        name: "тофу лейло",
        rootReply: true,
      },
      {
        id: 40,
        topic: 7,
        text: "branch alpha",
        previous: "resp_dm_1",
        agent: "tofu",
        name: "тофу лейло",
        replyId: 11,
      },
      {
        id: 50,
        topic: 7,
        text: "follow branch",
        previous: "resp_dm_5",
        agent: "tofu",
        name: "тофу лейло",
      },
      {
        id: 60,
        topic: 7,
        text: "laylo switch agent",
        previous: null,
        agent: "normal",
        name: "laylo",
      },
      {
        id: 70,
        topic: undefined,
        text: "default DM secret",
        previous: null,
        agent: "normal",
        name: "laylo",
      },
      {
        id: 80,
        topic: undefined,
        text: "continue default DM",
        previous: "resp_dm_8",
        agent: "normal",
        name: "laylo",
        noReply: true,
      },
      {
        id: 90,
        topic: undefined,
        text: undefined,
        photo: [
          {
            file_id: "dm-photo",
            file_unique_id: "dm-photo",
            width: 10,
            height: 10,
          },
        ],
        previous: "resp_dm_10",
        agent: "normal",
        name: "laylo",
      },
      {
        id: 100,
        topic: 9,
        text: "troll laylo gamma secret",
        previous: null,
        agent: "troll",
        name: "troll laylo",
      },
    ] as const;
    for (const test of cases) {
      currentMessageId = test.id;
      sendWithoutReply = "noReply" in test;
      const requestIndex = requests.length;
      const replyId =
        "rootReply" in test ? 9 : "replyId" in test ? test.replyId : undefined;
      const ctx = new GrammyContext(
        {
          update_id: test.id,
          message: {
            message_id: test.id,
            message_thread_id:
              "implicitCreation" in test ? undefined : test.topic,
            // DM topic routing must work even when is_topic_message is absent.
            date: 0,
            from: { id: 1, is_bot: false, first_name: "User" },
            chat,
            text: test.text,
            ...("photo" in test ? { photo: [...test.photo] } : {}),
            ...(replyId === undefined
              ? {}
              : {
                  reply_to_message: {
                    message_id: replyId,
                    date: 0,
                    chat,
                    from: bot,
                    text: "Done.",
                    reply_to_message: undefined,
                    ...("rootReply" in test
                      ? {
                          message_thread_id: test.topic,
                          forum_topic_created: { name: "Alpha", icon_color: 0 },
                        }
                      : {}),
                  },
                }),
          },
        },
        api,
        { ...bot, has_topics_enabled: test.topic !== undefined },
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      if ("implicitCreation" in test) {
        // Real Telegram updates use independent service-message/topic IDs and
        // omit the topic ID entirely from the following first text message.
        await resolvePrivateTopic(
          new GrammyContext(
            {
              update_id: test.id - 1,
              message: {
                message_id: test.id - 1,
                message_thread_id: test.topic,
                date: 0,
                chat,
                from: { id: 1, is_bot: false, first_name: "User" },
                forum_topic_created: {
                  name: "Implicit title",
                  icon_color: 7322096,
                  is_name_implicit: true,
                },
              },
            },
            api,
            bot,
          ),
          async () => {},
        );
      }
      await resolvePrivateTopic(ctx, async () => {
        await chatComposer.middleware()(ctx, () => {
          throw new Error("DM topic message should be handled");
        });
      });
      // Indexing must not produce a second automatic response for a DM.
      ok(ctx.message);
      await maybeSendProactiveAgentResponse(ctx, ctx.message, chat.id);
      strictEqual(deliveries.length, cases.indexOf(test) + 1);
      deepStrictEqual(deliveries.at(-1), {
        ...(test.topic === undefined ? {} : { message_thread_id: test.topic }),
        ...("noReply" in test
          ? {}
          : {
              reply_parameters: {
                message_id: test.id,
                allow_sending_without_reply: true,
              },
            }),
      });
      strictEqual(
        (typing.at(-1) as { message_thread_id: number }).message_thread_id,
        test.topic,
      );
      const thread = await getThread(database, {
        chat_id: chat.id,
        message_id: test.id,
      });
      strictEqual(thread?.thread_id, test.topic ?? 0);
      strictEqual(thread?.agent_id, test.agent);
      strictEqual(thread?.agent_name, test.name);
      const history = await database
        .selectFrom("llm_chat_responses")
        .selectAll()
        .where("response_id", "=", `resp_dm_${requestIndex + 1}`)
        .executeTakeFirstOrThrow();
      strictEqual(history.previous_response_id, test.previous);
      const input = JSON.stringify(requests[requestIndex].input);
      if ("photo" in test) ok(input.includes("data:image/jpeg;base64,"));
      if (test.topic === 8) ok(!input.includes("alpha secret"));
      if (test.topic === 7) ok(!input.includes("beta secret"));
      if (test.topic === undefined) {
        ok(!input.includes("alpha secret"));
        ok(!input.includes("beta secret"));
        if (test.previous) ok(input.includes("default DM secret"));
      }
      if (test.previous && test.topic === 7) ok(input.includes("alpha secret"));
      // Re-running migrations must keep persisted topic continuation links.
      await migrateThreads(database);
    }
    strictEqual(
      await database
        .selectFrom("chat_proactive_responses")
        .selectAll()
        .where("chat_id", "=", chat.id)
        .executeTakeFirst(),
      undefined,
    );
    deepStrictEqual(names, [
      { chatId: 1, topicId: 7, name: "Generated thread name" },
      { chatId: 1, topicId: 8, name: "Generated thread name" },
      { chatId: 1, topicId: 9, name: "troll laylo gamma" },
    ]);
    deepStrictEqual(
      nameRequests.map((request) => request.model),
      ["test-model", "test-model", "test-troll-model"],
    );
    // A different private chat with the same topic ID has no continuation.
    const { getLatestTopicThread } = await import("./threads.ts");
    strictEqual(
      await getLatestTopicThread(database, {
        chatId: 2,
        threadId: 7,
        beforeMessageId: 100,
      }),
      undefined,
    );
    // Messages from later updates cannot become the parent of an earlier one.
    strictEqual(
      (
        await getLatestTopicThread(database, {
          chatId: 1,
          threadId: 7,
          beforeMessageId: 30,
        })
      )?.response_id,
      "resp_dm_1",
    );
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("small", "");
    setLlmDeploymentName("openminded", "");
    await database.destroy();
  }
});

test("private chat commands bypass model responses with or without a topic ID", async () => {
  for (const topicId of [undefined, 7]) {
    const ctx = new GrammyContext(
      {
        update_id: 1,
        message: {
          message_id: 1,
          message_thread_id: topicId,
          date: 0,
          from: { id: 1, is_bot: false, first_name: "User" },
          chat: { id: 1, type: "private", first_name: "User" },
          text: "/usage",
        },
      },
      new Api("test"),
      {
        id: 42,
        is_bot: true,
        first_name: "Test",
        username: "test_bot",
      } as Context["me"],
    ) as Context;
    ctx.telemetry = { event: () => {} } as Context["telemetry"];
    let nextCalls = 0;
    await chatComposer.middleware()(ctx, () => {
      nextCalls++;
      return Promise.resolve();
    });
    strictEqual(nextCalls, 1);
  }
});

test("tool errors hide details unless debug is enabled", () => {
  const error = {
    tool: "generate_image",
    details: "MEDIA_CACHE_CHAT_ID is not set.",
  } as const;

  strictEqual(formatLlmToolError(error, false), "Tool generate_image failed.");
  strictEqual(
    formatLlmToolError(error, true),
    "Tool generate_image failed: MEDIA_CACHE_CHAT_ID is not set.",
  );
});

test("guest usage commands report and adjust group credits without changing personal credits", async () => {
  const { createCreditCharge, getUsageStatus } = await import("./usage.ts");
  const database = await initDatabase()();
  const i18n = new I18n({ directory: "locales", defaultLocale: "en" });
  try {
    for (const [args, expectedQuota] of [
      ["+10", 60],
      ["-20", 40],
      ["", 40],
    ] as const) {
      const ctx = new GrammyContext(
        {
          update_id: 1,
          guest_message: {
            message_id: 1,
            date: 0,
            from: { id: 1, is_bot: false, first_name: "Admin" },
            chat: { id: -1, type: "supergroup", title: "Test" },
            text: `@test_bot /usage ${args}`,
          },
        },
        new Api("test"),
        {
          id: 42,
          is_bot: true,
          first_name: "Test",
          username: "test_bot",
        } as Context["me"],
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      ctx.t = (key, values) => i18n.t("en", key, values);
      if (args === "+10") {
        const charge = createCreditCharge(ctx, true);
        await charge("request");
        await charge("tool", "generate_image");
        await charge("image_attempt", "generate_image");
      }
      const responses: Array<Parameters<Context["answerGuestQuery"]>[0]> = [];
      ctx.answerGuestQuery = (result) => {
        responses.push(result);
        return Promise.resolve({ inline_message_id: "test" });
      };
      await chatComposer.middleware()(ctx, () => {
        throw new Error("Usage command should be handled");
      });
      strictEqual((await getUsageStatus(database, -1)).quota, expectedQuota);
      deepStrictEqual(await getUsageStatus(database, 1), {
        used: 0,
        quota: 20,
        unlimited: false,
      });
      strictEqual(responses.length, 1);
      const response = responses[0];
      ok(response.type === "article");
      deepStrictEqual(response.input_message_content, {
        rich_message: {
          blocks: [
            ctx.t("settings-usage-title", {
              date: new Date().toISOString().slice(0, 10),
            }),
            ctx.t("settings-usage-line", { used: 7, quota: expectedQuota }),
            ...ctx.t("settings-usage-prices", { tokens: 620 }).split("\n"),
          ].map((text) => ({ type: "paragraph", text })),
        },
      });
    }
  } finally {
    await database.destroy();
  }
});

test("model failures without activity preserve escaped diagnostics and resume commands", () => {
  strictEqual(
    formatModelFailureResponse(
      new Error("status 400: blocked <image> & context"),
      "/resume_1283340",
    ),
    [
      "Failed to generate response",
      "<blockquote>status 400: blocked &lt;image&gt; &amp; context</blockquote>",
      "/resume_1283340",
      "![⚠️](tg://emoji?id=5881702736843511327)",
    ].join("\n\n"),
  );
});

test("failed model follow-ups retain tools with progress enabled or disabled", async () => {
  const { setLlmDeploymentName } = await import("./llm-deployments.ts");
  const { persistChatProgressEnabled } = await import("./llm-models.ts");
  const { getThread } = await import("./threads.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const chat = { id: -1, type: "supergroup", title: "Test" } as const;
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
  } as Context["me"];
  const api = new Api("test");
  const sent: string[] = [];
  let modelCalls = 0;
  let sentMessageId = 100;
  api.sendChatAction = async () => true;
  api.sendRichMessage = async (_chatId, richMessage) => {
    ok(typeof richMessage.markdown === "string");
    sent.push(richMessage.markdown);
    return {
      message_id: ++sentMessageId,
      date: 0,
      chat,
      from: bot,
      rich_message: { blocks: [{ type: "paragraph", text: "Sent" }] },
    };
  };
  globalThis.fetch = (async (input) => {
    strictEqual(String(input), `${TEST_ENV.LLM_BASE_URL}/responses`);
    modelCalls++;
    if (modelCalls > 2) {
      return Response.json(
        {
          error: {
            code: "content_policy_violation",
            type: "invalid_request_error",
            message:
              "Image processing blocked due to content policy violation.",
          },
        },
        { status: 400 },
      );
    }
    return Response.json({
      id: `resp_failure_progress_${sentMessageId}_${modelCalls}`,
      object: "response",
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      created_at: 1,
      status: "completed",
      output: [
        ...(modelCalls === 1
          ? [
              {
                type: "message",
                role: "assistant",
                phase: "commentary",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: "Checking **sources**.",
                    annotations: [],
                  },
                ],
              },
            ]
          : []),
        {
          type: "function_call",
          id: `fc_${modelCalls}`,
          call_id: `call_${modelCalls}`,
          name: modelCalls === 1 ? "set_reply_message_id" : "read_image",
          arguments:
            modelCalls === 1
              ? '{"message_id":42}'
              : '{"url":"https://images.test/example.png"}',
          status: "completed",
        },
      ],
    });
  }) as typeof fetch;

  try {
    setLlmDeploymentName("small", "test-model");
    for (const [index, progressEnabled] of [true, false].entries()) {
      await persistChatProgressEnabled(database, chat.id, progressEnabled);
      modelCalls = 0;
      sent.length = 0;
      const messageId = 1283340 + index;
      const ctx = new GrammyContext(
        {
          update_id: index + 1,
          message: {
            message_id: messageId,
            date: 0,
            from: { id: 1, is_bot: false, first_name: "User" },
            chat,
            text: "laylo check this image",
          },
        },
        api,
        bot,
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      await chatComposer.middleware()(ctx, async () => {});

      strictEqual(modelCalls, 13);
      strictEqual(sent.length, 1);
      strictEqual(sent[0].includes("Checking **sources**."), progressEnabled);
      ok(sent[0].includes("Failed to generate response"));
      ok(sent[0].includes("content policy violation"));
      ok(sent[0].includes(`/resume_${messageId}`));
      ok(
        sent[0].endsWith(
          [
            "![⚠️](tg://emoji?id=5881702736843511327)",
            "![↩️](tg://emoji?id=5877468380125990242)",
            "![🖼](tg://emoji?id=5775949822993371030)",
          ].join(" "),
        ),
      );
      // Replies to the failure message must still find the saved checkpoint.
      const thread = await getThread(database, {
        chat_id: chat.id,
        message_id: sentMessageId,
      });
      ok(thread?.response_id);
    }
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("small", "");
    await database.destroy();
  }
});

test("Azure upstream outages use a plain custom-emoji message", () => {
  deepStrictEqual(
    getAzureDownMessage(
      new Error(
        "status 503: server_error: no healthy upstream: 503 no healthy upstream",
      ),
    ),
    {
      text: "Azure is down 😔",
      entities: [
        {
          type: "custom_emoji",
          offset: 14,
          length: 2,
          custom_emoji_id: "5384549865625758405",
        },
      ],
    },
  );
});

test("other model failures do not use the Azure outage message", () => {
  strictEqual(
    getAzureDownMessage(new Error("status 503: another server error")),
    undefined,
  );
  strictEqual(
    getAzureDownMessage(new Error("status 502: no healthy upstream")),
    undefined,
  );
});

test("media-group input includes the largest photo from every message", () => {
  deepStrictEqual(
    getMessagesImageAttachments([
      {
        photo: [
          { file_id: "small-1", width: 100, height: 100 },
          { file_id: "large-1", width: 1200, height: 800 },
        ],
      },
      {
        photo: [
          { file_id: "small-2", width: 90, height: 90 },
          { file_id: "large-2", width: 800, height: 1200 },
        ],
      },
    ]),
    [
      { fileId: "large-1", mimeType: "image/jpeg", mediaType: "photo" },
      { fileId: "large-2", mimeType: "image/jpeg", mediaType: "photo" },
    ],
  );
});

test("rich-message images are collected recursively in block order", () => {
  const photo = (id: string) => ({
    type: "photo",
    photo: [
      { file_id: `${id}-small`, width: 100, height: 100 },
      { file_id: id, width: 1200, height: 800 },
    ],
  });
  deepStrictEqual(
    getMessagesImageAttachments([
      {
        rich_message: {
          blocks: [
            photo("standalone"),
            {
              type: "slideshow",
              blocks: [
                photo("slide-1"),
                {
                  type: "collage",
                  blocks: [photo("collage-1"), photo("collage-2")],
                },
                photo("slide-2"),
              ],
            },
            {
              type: "details",
              blocks: [
                { type: "list", items: [{ blocks: [photo("list-photo")] }] },
              ],
            },
            {
              type: "document",
              document: { file_id: "png", mime_type: "image/png" },
            },
            {
              type: "document",
              document: { file_id: "webp", file_name: "image.webp" },
            },
            {
              type: "document",
              document: { file_id: "pdf", mime_type: "application/pdf" },
            },
            {
              type: "video",
              video: { file_id: "video", thumbnail: photo("thumb").photo[0] },
            },
            { type: "photo", photo: [null, {}, { file_id: 1 }] },
            { type: "document", document: null },
            null,
          ],
        },
      },
    ]),
    [
      ...[
        "standalone",
        "slide-1",
        "collage-1",
        "collage-2",
        "slide-2",
        "list-photo",
      ].map((fileId) => ({
        fileId,
        mimeType: "image/jpeg",
        mediaType: "photo",
      })),
      { fileId: "png", mimeType: "image/png", mediaType: "document" },
      { fileId: "webp", mimeType: "image/webp", mediaType: "document" },
    ],
  );
});

test("normal and guest requests send every rich-message image to the model", async () => {
  const { setLlmDeploymentName } = await import("./llm-deployments.ts");
  const { saveThread } = await import("./threads.ts");
  const originalFetch = globalThis.fetch;
  const photo = (id: string) => ({
    type: "photo" as const,
    photo: [
      {
        file_id: `${id}-small`,
        file_unique_id: `${id}-small`,
        width: 10,
        height: 10,
      },
      { file_id: id, file_unique_id: id, width: 1000, height: 1000 },
    ],
  });
  const images = [
    photo("standalone"),
    {
      type: "slideshow" as const,
      blocks: [photo("slide-1"), photo("slide-2")],
    },
    {
      type: "collage" as const,
      blocks: [photo("collage-1"), photo("collage-2")],
    },
    {
      type: "document" as const,
      document: {
        file_id: "png",
        file_unique_id: "png",
        mime_type: "image/png",
      },
    },
  ];
  const fileIds = [
    "standalone",
    "slide-1",
    "slide-2",
    "collage-1",
    "collage-2",
    "png",
  ];
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
  } as Context["me"];

  try {
    setLlmDeploymentName("small", "rich-image-test");
    for (const guest of [false, true]) {
      for (const source of [
        "current",
        "image-only",
        "reply",
        "quoted-reply",
        "external-reply",
        "thread-current",
        "thread-reply",
      ]) {
        const database = await initDatabase()();
        try {
          const chat =
            source === "image-only"
              ? { id: 1, type: "private" as const, first_name: "User" }
              : { id: -1, type: "supergroup" as const, title: "Test" };
          const api = new Api("test");
          api.config.use((_previous, method) =>
            Promise.reject(
              new Error(`Unexpected Telegram API call: ${method}`),
            ),
          );
          let deliveries = 0;
          api.sendRichMessage = async () => {
            deliveries++;
            return {
              message_id: 100,
              date: 0,
              chat,
              from: bot,
              rich_message: { blocks: [] },
            };
          };
          api.sendChatAction = async () => true;
          const downloads: string[] = [];
          api.getFile = async (id) => {
            downloads.push(id);
            return {
              file_id: id,
              file_unique_id: id,
              file_path: `photos/${id}`,
            };
          };
          const inputs: Array<
            Array<{
              content:
                | string
                | Array<{
                    type: string;
                    image_url?: string;
                    text?: string;
                  }>;
            }>
          > = [];
          globalThis.fetch = (async (input, init) => {
            const url = new URL(String(input));
            if (url.hostname === "api.telegram.org") {
              const id = url.pathname.split("/").at(-1);
              ok(id && fileIds.includes(id));
              return new Response(id, {
                headers: {
                  "content-type": id === "png" ? "image/png" : "image/jpeg",
                },
              });
            }
            strictEqual(url.href, `${TEST_ENV.LLM_BASE_URL}/responses`);
            inputs.push(JSON.parse(String(init?.body)).input);
            return Response.json({
              id: `resp_rich_${guest}_${source}`,
              object: "response",
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                total_tokens: 120,
              },
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: "Done.", annotations: [] },
                  ],
                },
              ],
            });
          }) as typeof fetch;

          const richMessage = {
            blocks: [
              ...(source === "image-only"
                ? []
                : [
                    {
                      type: "paragraph" as const,
                      text: "laylo compare these images",
                    },
                  ]),
              ...images,
            ],
          };
          const isCurrent = [
            "current",
            "image-only",
            "thread-current",
          ].includes(source);
          const reply = {
            message_id: 1,
            date: 0,
            chat,
            from: bot,
            reply_to_message: undefined,
            ...(isCurrent
              ? { text: "Earlier response" }
              : { rich_message: richMessage }),
          };
          if (source.startsWith("thread-")) {
            await saveThread(database, {
              chat_id: chat.id,
              message_id: 1,
              thread_id: 1,
              response_id: "resp_rich_previous",
              agent_id: guest ? "guest" : "normal",
            });
          }
          const message = {
            message_id: 10,
            date: 10,
            from: { id: 1, is_bot: false, first_name: "User" },
            chat,
            ...(isCurrent
              ? { rich_message: richMessage }
              : { text: "laylo compare these images" }),
            ...(source === "external-reply"
              ? {
                  external_reply: {
                    origin: {
                      type: "hidden_user" as const,
                      sender_user_name: "Someone",
                      date: 0,
                    },
                    rich_message: richMessage,
                  },
                }
              : {}),
            ...([
              "reply",
              "quoted-reply",
              "thread-current",
              "thread-reply",
            ].includes(source)
              ? { reply_to_message: reply }
              : {}),
            ...(source === "quoted-reply"
              ? { quote: { text: "compare", entities: [], position: 0 } }
              : {}),
          };
          const ctx = new GrammyContext(
            {
              update_id: 1,
              ...(guest ? { guest_message: message } : { message }),
            },
            api,
            bot,
          ) as Context;
          ctx.database = database;
          ctx.telemetry = { event: () => {} } as Context["telemetry"];
          ctx.answerGuestQuery = async () => {
            deliveries++;
            return { inline_message_id: "test" };
          };
          await chatComposer.middleware()(ctx, () => {
            throw new Error(
              `Rich message should be handled: ${guest}/${source}`,
            );
          });
          strictEqual(inputs.length, 1, `${guest}/${source}`);
          deepStrictEqual(downloads, fileIds, `${guest}/${source}`);
          const content = inputs[0].flatMap((item) =>
            typeof item.content === "string"
              ? [{ type: "input_text", text: item.content }]
              : item.content,
          );
          deepStrictEqual(
            content
              .filter((item) => item.type === "input_image")
              .map((item) => item.image_url),
            fileIds.map(
              (id) =>
                `data:image/${id === "png" ? "png" : "jpeg"};base64,${btoa(id)}`,
            ),
          );
          strictEqual(deliveries, 1);
          const text = content
            .filter((item) => item.type === "input_text")
            .map((item) => item.text)
            .join("\n");
          ok(
            text.includes(
              source === "image-only"
                ? "Please respond to the attached image."
                : "compare these images",
            ),
            `${guest}/${source}: ${text}`,
          );
          strictEqual(
            (text.match(/!\[\]\(tg:\/\/(photo|document)\?id=/g) ?? []).length,
            fileIds.length,
          );
          const stored = await database
            .selectFrom("images")
            .select(["file_id", "media_type"])
            .execute();
          deepStrictEqual(
            stored,
            fileIds.map((file_id) => ({
              file_id,
              media_type: file_id === "png" ? "document" : "photo",
            })),
          );
        } finally {
          await database.destroy();
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("small", "");
  }
});

test("unavailable rich-message photos are retried without user diagnostics", () => {
  const error = new Error("400 Bad Request: RICH_MESSAGE_PHOTO_NO_MEDIA_FOUND");
  const prompt = getErrorRecoveryPrompt("Show me the result", error);

  strictEqual(isUnavailableRichMessagePhotoError(error), true);
  ok(prompt.includes("Some image in your previous response cannot be sent."));
  ok(prompt.includes("Retry the complete user-facing answer"));
  ok(prompt.includes("Show me the result"));
  ok(!prompt.includes("RICH_MESSAGE_PHOTO_NO_MEDIA_FOUND"));
});

test("guest rich messages preserve table source before delivery", async () => {
  const database = await initDatabase()();
  try {
    deepStrictEqual(
      await buildGuestRichMessage(
        database,
        "Intro\n| A | B |\n| --- | --- |\n| 1 | 2 |",
      ),
      { markdown: "Intro\n| A | B |\n| --- | --- |\n| 1 | 2 |" },
    );
  } finally {
    await database.destroy();
  }
});

test("guest rich messages include saved image media mappings", async () => {
  const database = await initDatabase()();

  try {
    const image = await saveImageFileId(database, "guest-photo");
    deepStrictEqual(
      await buildGuestRichMessage(
        database,
        `Guest image\n\n![](tg://photo?id=${image.id})`,
      ),
      {
        markdown: `Guest image\n\n![](tg://photo?id=${image.id})`,
        media: [
          {
            id: image.id,
            media: { type: "photo", media: "guest-photo" },
          },
        ],
      },
    );
  } finally {
    await database.destroy();
  }
});

test("exhausted balances skip proactive and troll work before context lookup", async () => {
  const { maybeSendProactiveAgentResponse } = await import("./chat.ts");
  const { maybeSendPeriodicTroll } = await import("./trolling.ts");
  const { consumeUsage } = await import("./usage.ts");
  const database = await initDatabase()();
  try {
    await consumeUsage(database, -100, 50);
    const ctx = { database } as import("../bot.ts").Context;
    await maybeSendProactiveAgentResponse(ctx, { message_id: 1 }, -100);
    await maybeSendPeriodicTroll(
      ctx,
      { message_id: 1 },
      { id: 2, first_name: "Test" },
      -100,
    );
    strictEqual(
      (await database.selectFrom("chat_trolling").selectAll().execute()).length,
      0,
    );
    strictEqual(
      (
        await database
          .selectFrom("chat_proactive_responses")
          .selectAll()
          .execute()
      ).length,
      0,
    );
  } finally {
    await database.destroy();
  }
});

test("combined progress has a separate final icon line ending with the progress marker", async () => {
  const { formatProgressSegments } = await import("./chat.ts");
  const marker = "![⏳](tg://emoji?id=5427181942934088912)";
  const markdown = formatProgressSegments([
    { text: "Found relevant articles.", tools: ["web_search"] },
    { text: "I'll check sources.", tools: ["read_web_page"] },
    { text: "Got it. Writing final response.", tools: [] },
  ]);
  deepStrictEqual(
    markdown,
    [
      "Found relevant articles.",
      "I'll check sources.",
      "Got it. Writing final response.",
      `![🌐](tg://emoji?id=5879585266426973039) ![📝](tg://emoji?id=5960551395730919906) ${marker}`,
    ].join("\n\n"),
  );
  strictEqual(
    formatProgressSegments([
      { text: "Reading context", tools: ["get_message_context"] },
    ]),
    `Reading context\n\n![💬](tg://emoji?id=5886330010054168711) ${marker}`,
  );
  strictEqual(
    formatProgressSegments([{ text: "Thinking...", tools: [] }]),
    `Thinking...\n\n${marker}`,
  );
});

test("oversized Unicode progress reserves room for tools and appends the marker to every chunk", async () => {
  const { formatProgressSegments, splitProgressSegments } = await import(
    "./chat.ts"
  );
  const text = "текст🙂".repeat(10_000);
  const segments = splitProgressSegments([
    { text, tools: ["web_search", "read_web_page"] },
  ]);
  ok(segments.length > 1);
  strictEqual(segments.map((segment) => segment.text).join(""), text);
  for (const segment of segments) {
    const message = formatProgressSegments([segment]);
    ok(new TextEncoder().encode(message).length <= 30_000);
    ok(message.endsWith("![⏳](tg://emoji?id=5427181942934088912)"));
    ok(message.includes("\n\n"));
  }
  deepStrictEqual(segments[0].tools, ["web_search", "read_web_page"]);
  ok(segments.slice(1).every((segment) => segment.tools.length === 0));
});

test("chat progress sends one message per tick in the originating topic and respects the chat toggle", async () => {
  const { persistChatProgressEnabled } = await import("./llm-models.ts");
  const { setLlmDeploymentName } = await import("./llm-deployments.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let tick: (() => void) | undefined;
  function fireTick() {
    if (!tick) throw new Error("Progress timer was not armed");
    tick();
  }
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 30_000) {
      tick = callback;
      return originalSetTimeout(() => {}, 0);
    }
    return originalSetTimeout(() => callback(...args), delay);
  }) as typeof setTimeout;
  const chat = { id: -901, type: "supergroup", title: "Test" } as const;
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
  } as Context["me"];
  let nextMessageId = 100;
  try {
    setLlmDeploymentName("small", "progress-chat-test");
    for (const enabled of [true, false]) {
      await persistChatProgressEnabled(database, chat.id, enabled);
      tick = undefined;
      const sent: Array<{ markdown: string; topic?: number }> = [];
      const api = new Api("test");
      api.config.use((_previous, method) =>
        Promise.reject(new Error(`Unexpected Telegram API call: ${method}`)),
      );
      let delivered!: () => void;
      api.sendRichMessage = (_chatId, content, options) => {
        strictEqual(_chatId, chat.id);
        sent.push({
          markdown: content.markdown ?? "",
          topic: options?.message_thread_id,
        });
        delivered?.();
        return Promise.resolve({
          message_id: ++nextMessageId,
          date: 0,
          chat,
          from: bot,
          rich_message: { blocks: [] },
        });
      };
      api.sendChatAction = () => Promise.resolve(true);
      let waiting!: () => void;
      const secondRequest = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      let finish!: (response: Response) => void;
      let calls = 0;
      globalThis.fetch = (() => {
        calls++;
        if (calls === 2) {
          waiting();
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return Promise.resolve(
          Response.json({
            id: `chat_progress_${enabled}`,
            object: "response",
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            status: "completed",
            output: [
              {
                id: "intro",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: "Checking sources.",
                    annotations: [],
                  },
                ],
              },
              {
                id: "reply",
                type: "function_call",
                call_id: "reply",
                name: "set_reply_message_id",
                arguments: '{"message_id":42}',
                status: "completed",
              },
            ],
          }),
        );
      }) as unknown as typeof fetch;
      const ctx = new GrammyContext(
        {
          update_id: enabled ? 1 : 2,
          message: {
            message_id: enabled ? 1 : 2,
            date: 0,
            chat,
            text: "laylo help",
            message_thread_id: 77,
            is_topic_message: true,
            from: { id: 1, is_bot: false, first_name: "User" },
          },
        },
        api,
        bot,
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      const handling = chatComposer.middleware()(ctx, () => Promise.resolve());
      await secondRequest;
      if (enabled) {
        ok(tick);
        const update = new Promise<void>((resolve) => {
          delivered = resolve;
        });
        fireTick();
        await update;
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        strictEqual(sent.length, 1);
        ok(sent[0].markdown.startsWith("Checking sources."));
        ok(sent[0].markdown.includes("tg://emoji?id=5877468380125990242"));
        ok(
          sent[0].markdown.endsWith("![⏳](tg://emoji?id=5427181942934088912)"),
        );
      } else {
        strictEqual(tick, undefined);
        strictEqual(sent.length, 0);
      }
      finish(
        Response.json({
          id: `chat_final_${enabled}`,
          object: "response",
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          status: "completed",
          output: [
            {
              id: "final",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Final answer.", annotations: [] },
              ],
            },
          ],
        }),
      );
      await handling;
      strictEqual(sent.length, enabled ? 2 : 1);
      ok(sent.at(-1)?.markdown.startsWith("Final answer."));
      ok(sent.at(-1)?.markdown.includes("tg://emoji?id=5877468380125990242"));
      ok(!sent.at(-1)?.markdown.includes("5427181942934088912"));
      ok(sent.every((message) => message.topic === 77));
    }
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    setLlmDeploymentName("small", "");
    await database.destroy();
  }
});

test("user input cap counts only the current message and its immediate reply", () => {
  // Decimal text is three digits per token, so these are exact token boundaries.
  const digits = (tokens: number) => "123".repeat(tokens);
  const oversized = { message_id: 1, text: digits(5001) };
  strictEqual(
    getUserInputLimitError({ message_id: 2, text: digits(5000) }),
    undefined,
  );
  ok(getUserInputLimitError(oversized)?.includes("5,000-token"));
  strictEqual(
    getUserInputLimitError({
      message_id: 2,
      text: digits(2000),
      reply_to_message: {
        message_id: 1,
        text: digits(3000),
        reply_to_message: oversized,
      },
    }),
    undefined,
  );
  ok(
    getUserInputLimitError({
      message_id: 2,
      text: digits(2001),
      reply_to_message: { message_id: 1, text: digits(3000) },
    }),
  );
  ok(getUserInputLimitError({ message_id: 2, caption: digits(5001) }));
  ok(
    getUserInputLimitError({
      message_id: 2,
      text: "Hi",
      external_reply: { text: digits(5000) },
    }),
  );
  ok(
    getUserInputLimitError({
      message_id: 2,
      text: "Hi",
      quote: { text: digits(5000) },
    }),
  );
  ok(
    getUserInputLimitError({
      message_id: 2,
      rich_message: {
        blocks: [{ type: "paragraph", text: digits(5001) }],
      },
    }),
  );
  strictEqual(
    getUserInputLimitError({ message_id: 2, text: "Привет".repeat(500) }),
    undefined,
  );
  strictEqual(
    getUserInputLimitError({
      message_id: 2,
      text: "Hi",
      message_thread_id: 1,
      is_topic_message: true,
      reply_to_message: { ...oversized, forum_topic_created: {} },
    }),
    undefined,
  );
});

test("oversized user input is rejected before generation, task creation, or credit reservations", async () => {
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const chat = { id: -567, type: "supergroup", title: "Test" } as const;
  const bot = {
    id: 42,
    is_bot: true,
    first_name: "Bot",
    username: "test_bot",
  } as Context["me"];
  const sent: string[] = [];
  const api = new Api("test");
  api.sendMessage = async (_chatId, text) => {
    sent.push(text);
    return { message_id: 100, date: 0, chat, from: bot, text };
  };
  api.sendRichMessage = async (_chatId, content) => {
    sent.push(content.markdown ?? "");
    return {
      message_id: 100,
      date: 0,
      chat,
      from: bot,
      rich_message: {
        blocks: [{ type: "paragraph", text: content.markdown ?? "" }],
      },
    };
  };
  globalThis.fetch = (() => {
    throw new Error("Rejected input must not call external services");
  }) as unknown as typeof fetch;
  try {
    for (const mode of ["normal", "guest"] as const) {
      const message = {
        message_id: 1,
        date: 0,
        chat,
        from: { id: 1, is_bot: false, first_name: "User" },
        text: "лейло hi",
        reply_to_message: {
          message_id: 2,
          date: 0,
          chat,
          from: bot,
          text: "123".repeat(5000),
        },
      };
      const ctx = new GrammyContext(
        {
          update_id: 1,
          ...(mode === "guest" ? { guest_message: message } : { message }),
        } as never,
        api,
        bot,
      ) as Context;
      ctx.database = database;
      ctx.telemetry = { event: () => {} } as Context["telemetry"];
      await chatComposer.middleware()(ctx, () => {
        throw new Error("Must handle input rejection");
      });
      ok(sent.at(-1)?.includes("5,000-token"));
    }
    strictEqual(sent.length, 2);
    strictEqual(
      (await database.selectFrom("tasks").selectAll().execute()).length,
      0,
    );
    strictEqual(
      (
        await database
          .selectFrom("credit_text_reservations")
          .selectAll()
          .execute()
      ).length,
      0,
    );
    strictEqual(
      (await database.selectFrom("credit_usage").selectAll().execute()).length,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

test("automatic response checks allow ADMIN_ID even when the group has no credits", async () => {
  const { prepareProactiveAgentResponse } = await import("./chat.ts");
  const { preparePeriodicTroll } = await import("./trolling.ts");
  const { setProactiveResponseInterval } = await import("./proactive.ts");
  const { setTrollingInterval } = await import("./trolling.ts");
  const { handleUsageCommand } = await import("./usage.ts");
  const database = await initDatabase()();
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    await handleUsageCommand(database, -100, "-50", true, (key) => key);
    await setProactiveResponseInterval(database, -100, 1);
    await setTrollingInterval(database, -100, 1);
    const chat = { id: -100, type: "supergroup", title: "Test" } as const;
    const sender = { id: 1, is_bot: false, first_name: "Admin" };
    const message = {
      message_id: 1,
      date: 0,
      chat,
      from: sender,
      text: "Hello everyone",
    };
    const ctx = new GrammyContext({ update_id: 1, message }, new Api("test"), {
      id: 42,
      is_bot: true,
      first_name: "Bot",
      username: "test_bot",
    } as Context["me"]) as Context;
    ctx.database = database;
    ok(await prepareProactiveAgentResponse(ctx, message, chat.id));
    ok(await preparePeriodicTroll(ctx, message, sender, chat.id));
  } finally {
    Math.random = originalRandom;
    await database.destroy();
  }
});
