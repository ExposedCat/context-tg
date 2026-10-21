import { test } from "bun:test";
import { strictEqual } from "node:assert";
import { sql } from "kysely";

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
  EMBEDDING_MODEL: "test",
  QDRANT_URL: "https://qdrant.test",
}))
  Bun.env[key] = value;

const { initDatabase } = await import("./database.ts");

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
