import { test } from "bun:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";

for (const [key, value] of Object.entries({
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  KEENABLE_API_KEY: "test",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test",
  QDRANT_URL: "https://qdrant.test",
}))
  Bun.env[key] = value;

const { initDatabase } = await import("./database.ts");

test("startup fails interrupted tasks across chats and preserves completed history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-tg-restart-"));
  try {
    const connect = initDatabase(join(directory, "tasks.sqlite"));
    const first = await connect();
    const timestamp = "2026-01-01 12:00:00";
    const statuses = [
      "working",
      "working",
      "finished",
      "failed",
      "canceled",
    ] as const;
    try {
      await first
        .insertInto("tasks")
        .values(
          statuses.map((status, index) => ({
            chat_id: -index - 1,
            message_id: 1,
            thread_id: 1,
            task_text: "request",
            started_at: timestamp,
            status,
            finished_at: status === "working" ? null : timestamp,
          })),
        )
        .execute();
    } finally {
      await first.destroy();
    }

    const restarted = await connect();
    try {
      const rows = await restarted
        .selectFrom("tasks")
        .select(["status", "finished_at"])
        .orderBy("chat_id", "desc")
        .execute();
      deepStrictEqual(
        rows.map((row) => row.status),
        ["failed", "failed", "finished", "failed", "canceled"],
      );
      ok(rows.slice(0, 2).every((row) => row.finished_at));
      ok(rows.slice(2).every((row) => row.finished_at === timestamp));
    } finally {
      await restarted.destroy();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("integers beyond 32 bits read back exactly as numbers", async () => {
  const database = await initDatabase()();
  try {
    // Supergroup id, newer user id, ms timestamp, and the safe-integer edge.
    for (const value of [
      -1001756869879,
      7969922304,
      1792588800000,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const { rows } = await sql<{
        value: unknown;
      }>`select cast(${value} as integer) as value`.execute(database);
      strictEqual(rows[0].value, value);
    }
  } finally {
    await database.destroy();
  }
});
