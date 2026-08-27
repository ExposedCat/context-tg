import { deepStrictEqual, strictEqual } from "node:assert";
import type { Database } from "./database.ts";

const TEST_ENV = {
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
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Deno.env.set(name, value);
}

const { createEmojiPackTransformer, formatGlobalPacksList } = await import(
  "./emoji-packs.ts"
);

type PackTable = "emoji_packs" | "global_emoji_packs";

function createPackDatabase(includeChatPack = true): Database {
  const rows = {
    emoji_packs: includeChatPack
      ? [{ name: "chat", position: 0, created_at: "2026-01-01T00:00:00Z" }]
      : [],
    global_emoji_packs: [
      { name: "global", position: 0, created_at: "2026-01-01T00:00:00Z" },
    ],
  } satisfies Record<PackTable, Array<Record<string, unknown>>>;

  return {
    selectFrom: (table: PackTable) => ({
      selectAll: () => ({
        orderBy: () => ({
          execute: () => Promise.resolve(rows[table]),
        }),
      }),
    }),
  } as unknown as Database;
}

const stickerSetApi = {
  getStickerSet: (name: string) =>
    Promise.resolve(
      name === "chat"
        ? {
            sticker_type: "custom_emoji",
            stickers: [{ emoji: "🙂", custom_emoji_id: "chat-smile" }],
          }
        : {
            sticker_type: "custom_emoji",
            stickers: [
              { emoji: "🙂", custom_emoji_id: "global-smile" },
              { emoji: "🔥", custom_emoji_id: "global-fire" },
            ],
          },
    ),
};

async function transformText(database: Database, text: string) {
  const transformer = createEmojiPackTransformer(database, stickerSetApi);
  let sentPayload: unknown;
  const runTransformer = transformer as unknown as (
    prev: (
      method: string,
      payload: Record<string, unknown>,
    ) => Promise<unknown>,
    method: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;

  await runTransformer(
    (_method, payload) => {
      sentPayload = payload;
      return Promise.resolve({ ok: true, result: true });
    },
    "sendMessage",
    { chat_id: 1, text },
  );

  return sentPayload;
}

Deno.test("global emoji packs are fallback-only", async () => {
  const sentPayload = await transformText(createPackDatabase(), "🙂🔥");

  deepStrictEqual(sentPayload, {
    chat_id: 1,
    text: "🙂🔥",
    entities: [
      {
        type: "custom_emoji",
        offset: 0,
        length: 2,
        custom_emoji_id: "chat-smile",
      },
      {
        type: "custom_emoji",
        offset: 2,
        length: 2,
        custom_emoji_id: "global-fire",
      },
    ],
  });
});

Deno.test("global emoji packs are used when no chat packs exist", async () => {
  const sentPayload = await transformText(createPackDatabase(false), "🙂");

  deepStrictEqual(sentPayload, {
    chat_id: 1,
    text: "🙂",
    entities: [
      {
        type: "custom_emoji",
        offset: 0,
        length: 2,
        custom_emoji_id: "global-smile",
      },
    ],
  });
});

Deno.test("global pack commands are only included for the bot admin", () => {
  const packs = [{ name: "default_pack" }];
  const adminMessage = formatGlobalPacksList(packs, true);
  const memberMessage = formatGlobalPacksList(packs, false);

  strictEqual(adminMessage.includes("/global_pack_add"), true);
  strictEqual(adminMessage.includes("/global_pack_remove"), true);
  strictEqual(memberMessage, "Global emoji packs:\n- default_pack");
});
