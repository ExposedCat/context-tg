import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { Api, Context as GrammyContext } from "grammy";
import type { MessageEntity } from "grammy/types";
import type { Context } from "../bot.ts";

const TEST_ENV = {
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  MEDIA_CACHE_CHAT_ID: "-10042",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  KEENABLE_API_KEY: "test",
  LLM_TEMPERATURE: "0.2",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test-embedding",
  QDRANT_URL: "https://qdrant.test",
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Deno.env.set(name, value);
}

const [
  { assembleMessageSearchWindows },
  {
    containsExactPhrase,
    formatRememberedMessageContent,
    fuseRankedMessageLists,
    messagesComposer,
    setIndexedTextMessageHandler,
  },
  { formatMessageContextJson },
  { initDatabase },
] = await Promise.all([
  import("./message-search.ts"),
  import("./messages.ts"),
  import("./llm-tools/chat.ts"),
  import("./database.ts"),
]);

type MessageMetadata = import("./messages.ts").MessageMetadata;
type MessageSearchResult = import("./messages.ts").MessageSearchResult;

Deno.test("slash commands are indexed and reindexed without triggering automatic responses", async () => {
  const originalFetch = globalThis.fetch;
  const indexed: MessageMetadata[] = [];
  const triggered: number[] = [];
  const embedded: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === `${TEST_ENV.EMBEDDER_BASE_URL}/embeddings`) {
      embedded.push(...body.input);
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    }
    ok(url.startsWith(TEST_ENV.QDRANT_URL), `Unexpected request: ${url}`);
    if (url.endsWith("/points")) {
      indexed.push(body.points[0].payload);
    }
    return Response.json({ result: { payload_schema: {} } });
  }) as typeof fetch;
  setIndexedTextMessageHandler(async (_ctx, message) => {
    triggered.push(message.message_id);
  });

  try {
    const cases: Array<{
      text?: string;
      caption?: string;
      entities?: MessageEntity[];
      caption_entities?: MessageEntity[];
      edited?: boolean;
    }> = [
      { text: "/unknown laylo" },
      {
        text: "/settings@test_bot",
        entities: [{ type: "bot_command", offset: 0, length: 18 }],
      },
      { text: "  /unknown @test_bot" },
      {
        caption: "/unknown laylo",
        caption_entities: [{ type: "bot_command", offset: 0, length: 8 }],
      },
      { text: "/edited laylo", edited: true },
      { text: "Ordinary conversation" },
    ];
    let nextCalls = 0;
    for (const [index, entry] of cases.entries()) {
      const message = {
        message_id: index + 1,
        date: 1,
        edit_date: 1,
        from: { id: 1, is_bot: false, first_name: "User" },
        chat: { id: -1, type: "supergroup", title: "Test" } as const,
        ...entry,
      };
      const ctx = new GrammyContext(
        {
          update_id: index + 1,
          ...(entry.edited ? { edited_message: message } : { message }),
        },
        new Api("test"),
        {} as Context["me"],
      ) as Context;
      await messagesComposer.middleware()(ctx, async () => {
        // A downstream command handler may consume the update.
        nextCalls++;
      });
      // Indexing runs in the background; wait for the mocked upsert to finish.
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (indexed.length === index + 1) break;
      }
      strictEqual(indexed.length, index + 1);
      strictEqual(indexed[index].text, entry.text ?? entry.caption);
    }
    strictEqual(nextCalls, cases.length);
    strictEqual(embedded.length, cases.length);
    deepStrictEqual(triggered, [6]);
  } finally {
    globalThis.fetch = originalFetch;
    setIndexedTextMessageHandler(async () => {});
  }
});

Deno.test("indexing preserves ordinary group reply parents and scopes only real topics", async () => {
  const originalFetch = globalThis.fetch;
  const indexed: MessageMetadata[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === `${TEST_ENV.EMBEDDER_BASE_URL}/embeddings`) {
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    }
    ok(url.startsWith(TEST_ENV.QDRANT_URL), `Unexpected request: ${url}`);
    if (url.endsWith("/points")) indexed.push(body.points[0].payload);
    return Response.json({ result: { payload_schema: {} } });
  }) as typeof fetch;
  setIndexedTextMessageHandler(async () => {});
  try {
    const cases = [
      { private: false, topic: 7, replyId: 7, expectedReply: 7, edited: false },
      { private: false, topic: 7, replyId: 8, expectedReply: 8, edited: true },
      {
        private: false,
        replyTopic: 7,
        replyId: 7,
        expectedReply: 7,
        edited: false,
      },
      {
        private: false,
        forum: true,
        topic: 7,
        replyId: 7,
        expectedTopic: 7,
        edited: false,
      },
      {
        private: false,
        forum: true,
        topic: 7,
        replyId: 8,
        expectedTopic: 7,
        expectedReply: 8,
        edited: true,
      },
      {
        private: false,
        replyForum: true,
        replyTopic: 7,
        replyId: 8,
        expectedTopic: 7,
        expectedReply: 8,
        edited: false,
      },
      { private: true, topic: 7, replyId: 7, expectedTopic: 7, edited: false },
      {
        private: true,
        topic: 7,
        replyId: 8,
        expectedTopic: 7,
        expectedReply: 8,
        edited: false,
      },
    ];
    for (const [index, test] of cases.entries()) {
      const chat = test.private
        ? ({ id: 1, type: "private", first_name: "User" } as const)
        : ({ id: -1, type: "supergroup", title: "Test" } as const);
      const message = {
        message_id: index + 20,
        date: 1,
        edit_date: 1,
        chat,
        from: { id: 1, is_bot: false, first_name: "User" },
        text: "Discussion",
        message_thread_id: test.topic,
        is_topic_message: test.forum,
        reply_to_message: {
          message_id: test.replyId,
          message_thread_id: test.replyTopic,
          is_topic_message: test.replyForum,
          date: 0,
          chat,
          text: "Parent",
          reply_to_message: undefined,
        },
      };
      const ctx = new GrammyContext(
        {
          update_id: index + 1,
          ...(test.edited ? { edited_message: message } : { message }),
        },
        new Api("test"),
        {} as Context["me"],
      ) as Context;
      await messagesComposer.middleware()(ctx, async () => {});
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (indexed.length === index + 1) break;
      }
      strictEqual(indexed.length, index + 1);
      strictEqual(indexed[index].reply_to_message_id, test.expectedReply);
      strictEqual(indexed[index].thread_id, test.expectedTopic);
    }
  } finally {
    globalThis.fetch = originalFetch;
    setIndexedTextMessageHandler(async () => {});
  }
});

function createMessage(
  messageId: number,
  overrides: Partial<MessageMetadata> = {},
): MessageMetadata {
  return {
    text: `message ${messageId}`,
    date: new Date(messageId * 1_000).toISOString(),
    date_timestamp: messageId,
    sender_name: "Sender",
    sender_id: 1,
    chat_id: 10,
    message_id: messageId,
    ...overrides,
  };
}

function createAnchor(
  messageId: number,
  score: number,
  overrides: Partial<MessageSearchResult> = {},
): MessageSearchResult {
  return {
    ...createMessage(messageId),
    id: `point-${messageId}`,
    score,
    queries: ["deployment"],
    matched_by: ["semantic"],
    ...overrides,
  };
}

Deno.test("rank fusion rewards messages found by multiple retrieval paths", () => {
  const first = createMessage(1);
  const second = createMessage(2);
  const third = createMessage(3);
  const results = fuseRankedMessageLists(
    [
      {
        query: "deployment",
        matchType: "semantic",
        points: [
          { id: "one", score: 0.9, payload: first },
          { id: "two", score: 0.8, payload: second },
        ],
      },
      {
        query: "deployment",
        matchType: "lexical",
        points: [
          { id: "two", payload: second },
          { id: "three", payload: third },
        ],
      },
      {
        query: "deploy-123",
        matchType: "phrase",
        weight: 2,
        points: [{ id: "three", payload: third }],
      },
    ],
    3,
  );

  deepStrictEqual(
    results.map((result) => result.message_id),
    [3, 2, 1],
  );
  deepStrictEqual(results[0].matched_by, ["lexical", "phrase"]);
  deepStrictEqual(results[0].queries, ["deployment", "deploy-123"]);
  deepStrictEqual(results[1].matched_by, ["semantic", "lexical"]);
});

Deno.test("exact phrase validation behaves like case-insensitive grep", () => {
  strictEqual(
    containsExactPhrase(
      "Track https://example.com/DEPLOY-123 now",
      "deploy-123",
    ),
    true,
  );
  strictEqual(
    containsExactPhrase("Let us deploy the service", "DEPLOY-123"),
    false,
  );
});

Deno.test("remembered Telegram photos render as reusable Markdown", async () => {
  const database = await initDatabase()();

  try {
    const content = await formatRememberedMessageContent(database, {
      message_id: 1,
      date: 1,
      caption: "Architecture sketch",
      photo: [
        { file_id: "small-photo", width: 90, height: 90 },
        { file_id: "large-photo", width: 1200, height: 800 },
      ],
    });

    ok(
      /^!\[\]\(tg:\/\/photo\?id=image_[a-f0-9]{32}\)\nArchitecture sketch$/.test(
        content ?? "",
      ),
    );
    strictEqual(
      (await database.selectFrom("images").select("file_id").executeTakeFirst())
        ?.file_id,
      "large-photo",
    );
  } finally {
    await database.destroy();
  }
});

Deno.test("remembered image documents render as reusable document Markdown", async () => {
  const database = await initDatabase()();

  try {
    const content = await formatRememberedMessageContent(database, {
      message_id: 2,
      media_group_id: "album-42",
      date: 2,
      document: {
        file_id: "image-document",
        file_name: "diagram.png",
        mime_type: "image/png",
      },
    });

    ok(/^!\[\]\(tg:\/\/document\?id=image_[a-f0-9]{32}\)$/.test(content ?? ""));
    deepStrictEqual(
      await database
        .selectFrom("images")
        .select(["file_id", "media_type"])
        .executeTakeFirst(),
      { file_id: "image-document", media_type: "document" },
    );
  } finally {
    await database.destroy();
  }
});

Deno.test("message context output marks the requested target", () => {
  const output = JSON.parse(
    formatMessageContextJson(
      10,
      2,
      [8, 9, 10, 11, 12].map((id) => createMessage(id)),
    ),
  );

  strictEqual(output.message_id, 10);
  strictEqual(output.radius, 2);
  strictEqual(output.target_found, true);
  deepStrictEqual(
    output.messages.map((message: { id: number; is_target: boolean }) => [
      message.id,
      message.is_target,
    ]),
    [
      [8, false],
      [9, false],
      [10, true],
      [11, false],
      [12, false],
    ],
  );
});

Deno.test("message context exposes Telegram album ids", () => {
  const output = JSON.parse(
    formatMessageContextJson(10, 1, [
      createMessage(10, { media_group_id: "album-42" }),
    ]),
  );

  strictEqual(output.messages[0].media_group_id, "album-42");
});

Deno.test("overlapping context windows merge and retain a distant reply parent", () => {
  const parent = createMessage(2);
  const firstAnchor = createAnchor(10, 0.04, {
    reply_to_message_id: parent.message_id,
    matched_by: ["semantic", "lexical"],
  });
  const secondAnchor = createAnchor(12, 0.03);
  const messages = new Map<number, MessageMetadata[]>([
    [10, [8, 9, 10, 11, 12].map((id) => createMessage(id))],
    [12, [10, 11, 12, 13, 14].map((id) => createMessage(id))],
  ]);

  const windows = assembleMessageSearchWindows(
    [firstAnchor, secondAnchor],
    messages,
    [parent],
  );

  strictEqual(windows.length, 1);
  deepStrictEqual(windows[0].anchor_ids, [10, 12]);
  deepStrictEqual(
    windows[0].messages.map((message) => message.message_id),
    [2, 8, 9, 10, 11, 12, 13, 14],
  );
  strictEqual(
    windows[0].messages.find((message) => message.message_id === 2)
      ?.is_reply_context,
    true,
  );
  ok(
    windows[0].messages
      .filter((message) => message.is_anchor)
      .every((message) => [10, 12].includes(message.message_id)),
  );
});

Deno.test("a shared reply parent does not merge unrelated local windows", () => {
  const parent = createMessage(2);
  const anchors = [
    createAnchor(10, 0.04, { reply_to_message_id: 2 }),
    createAnchor(20, 0.03, { reply_to_message_id: 2 }),
  ];
  const messages = new Map<number, MessageMetadata[]>([
    [10, [9, 10, 11].map((id) => createMessage(id))],
    [20, [19, 20, 21].map((id) => createMessage(id))],
  ]);

  const windows = assembleMessageSearchWindows(anchors, messages, [parent]);

  strictEqual(windows.length, 2);
  ok(windows.every((window) => window.messages[0].message_id === 2));
});
