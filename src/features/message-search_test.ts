import { deepStrictEqual, ok, strictEqual } from "node:assert";

const TEST_ENV = {
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  MEDIA_CACHE_CHAT_ID: "-10042",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  LLM_IMAGE_BASE_URL: "https://images.test/v1",
  LLM_IMAGE_MODEL: "test-image",
  LLM_IMAGE_API_KEY: "test",
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
  { containsExactPhrase, fuseRankedMessageLists },
  { formatMessageContextJson },
] = await Promise.all([
  import("./message-search.ts"),
  import("./messages.ts"),
  import("./llm-tools/chat.ts"),
]);

type MessageMetadata = import("./messages.ts").MessageMetadata;
type MessageSearchResult = import("./messages.ts").MessageSearchResult;

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
