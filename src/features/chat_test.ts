import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { Api, Context as GrammyContext } from "grammy";
import { I18n } from "grammy-i18n";
import type { Context } from "../bot.ts";

const TEST_ENV = {
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  LLM_TEMPERATURE: "0.2",
  KEENABLE_API_KEY: "test",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test-embedding",
  QDRANT_URL: "https://qdrant.test",
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Deno.env.set(name, value);
}

const [
  {
    buildGuestRichMessage,
    chatComposer,
    formatLlmToolError,
    getAzureDownMessage,
    getErrorRecoveryPrompt,
    getMessagesImageAttachments,
    isUnavailableRichMessagePhotoError,
  },
  { initDatabase },
  { saveImageFileId },
] = await Promise.all([
  import("./chat.ts"),
  import("./database.ts"),
  import("./images.ts"),
]);

Deno.test("messages dropped for missing mentions still emit analytics once", async () => {
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

Deno.test("trigger aliases persist through replies and update on explicit triggers", async () => {
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

Deno.test("group replies retain their parent and history scope while forum topics stay isolated", async () => {
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

Deno.test("DMs continue without mentions with or without topic IDs and preserve explicit reply branches", async () => {
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
        previous: null,
        agent: "tofu",
        name: "тофу лейло",
      },
      {
        id: 20,
        topic: 8,
        text: "beta secret",
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
        "rootReply" in test
          ? test.topic
          : "replyId" in test
            ? test.replyId
            : undefined;
      const ctx = new GrammyContext(
        {
          update_id: test.id,
          message: {
            message_id: test.id,
            message_thread_id: test.topic,
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
      await chatComposer.middleware()(ctx, () => {
        throw new Error("DM topic message should be handled");
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

Deno.test("private chat commands bypass model responses with or without a topic ID", async () => {
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

Deno.test("tool errors hide details unless debug is enabled", () => {
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

Deno.test("guest usage commands report and adjust group credits without changing personal credits", async () => {
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
            "Request · 1 credit",
            "Tool use · 1 credit",
            "Web search · +1 credit",
            "Image generation · +5 credits per attempt (retries count)",
            "Resets daily at 00:00 UTC.",
          ].map((text) => ({ type: "paragraph", text })),
        },
      });
    }
  } finally {
    await database.destroy();
  }
});

Deno.test("Azure upstream outages use a plain custom-emoji message", () => {
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

Deno.test("other model failures do not use the Azure outage message", () => {
  strictEqual(
    getAzureDownMessage(new Error("status 503: another server error")),
    undefined,
  );
  strictEqual(
    getAzureDownMessage(new Error("status 502: no healthy upstream")),
    undefined,
  );
});

Deno.test("media-group input includes the largest photo from every message", () => {
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
      { fileId: "large-1", mimeType: "image/jpeg" },
      { fileId: "large-2", mimeType: "image/jpeg" },
    ],
  );
});

Deno.test("unavailable rich-message photos are retried without user diagnostics", () => {
  const error = new Error("400 Bad Request: RICH_MESSAGE_PHOTO_NO_MEDIA_FOUND");
  const prompt = getErrorRecoveryPrompt("Show me the result", error);

  strictEqual(isUnavailableRichMessagePhotoError(error), true);
  ok(prompt.includes("Some image in your previous response cannot be sent."));
  ok(prompt.includes("Retry the complete user-facing answer"));
  ok(prompt.includes("Show me the result"));
  ok(!prompt.includes("RICH_MESSAGE_PHOTO_NO_MEDIA_FOUND"));
});

Deno.test("guest rich messages include saved image media mappings", async () => {
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

Deno.test("exhausted balances skip proactive and troll work before context lookup", async () => {
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
