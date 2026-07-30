import { strictEqual } from "node:assert";
import { Database as SqliteDatabase } from "@db/sqlite";
import { Kysely } from "@kysely/kysely";
import { DenoSqlite3Dialect } from "@marshift/kysely-deno-sqlite3";
import type { DatabaseSchema } from "./database.ts";
import {
  getChatBooleanLlmSetting,
  isBooleanLlmSettingKey,
  migrateLlmSettings,
  parseBooleanModeSetting,
  persistChatBooleanLlmSetting,
  persistGlobalBooleanLlmSetting,
} from "./llm-models.ts";

Deno.test("boolean LLM settings accept only on and off", () => {
  strictEqual(parseBooleanModeSetting("on"), true);
  strictEqual(parseBooleanModeSetting("OFF"), false);
  strictEqual(parseBooleanModeSetting("true"), undefined);
});

Deno.test("boolean LLM setting keys include input dumps", () => {
  strictEqual(isBooleanLlmSettingKey("debug"), true);
  strictEqual(isBooleanLlmSettingKey("input_dump"), true);
  strictEqual(isBooleanLlmSettingKey("reasoning"), false);
});

Deno.test("chat LLM input dumps inherit and override the global setting", async () => {
  const database = new Kysely<DatabaseSchema>({
    dialect: new DenoSqlite3Dialect({
      database: new SqliteDatabase(":memory:"),
    }),
  });

  try {
    await migrateLlmSettings(database);
    strictEqual(
      await getChatBooleanLlmSetting(database, 1, "input_dump"),
      false,
    );

    await persistGlobalBooleanLlmSetting(database, "input_dump", true);
    strictEqual(
      await getChatBooleanLlmSetting(database, 1, "input_dump"),
      true,
    );

    await persistChatBooleanLlmSetting(database, 1, "input_dump", false);
    strictEqual(
      await getChatBooleanLlmSetting(database, 1, "input_dump"),
      false,
    );
    strictEqual(
      await getChatBooleanLlmSetting(database, 2, "input_dump"),
      true,
    );
  } finally {
    await database.destroy();
  }
});
