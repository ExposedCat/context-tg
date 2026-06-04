import { Database as SqliteDatabase } from "@db/sqlite";
import { Kysely } from "@kysely/kysely";
import { DenoSqlite3Dialect } from "@marshift/kysely-deno-sqlite3";
import { APP_ENV } from "./env.ts";
import {
  type LlmSettingsTable,
  loadLlmSettings,
  migrateLlmSettings,
} from "./llm-models.ts";
import { migrateThreads, type ThreadsTable } from "./threads.ts";

export type DatabaseSchema = {
  threads: ThreadsTable;
  llm_settings: LlmSettingsTable;
};

export type Database = Kysely<DatabaseSchema>;

async function ensureDatabaseDirectory(databasePath: string) {
  if (databasePath === ":memory:") {
    return;
  }

  const separatorIndex = databasePath.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return;
  }

  await Deno.mkdir(databasePath.slice(0, separatorIndex), { recursive: true });
}

export function initDatabase() {
  const databasePath = APP_ENV.SQLITE_PATH;

  const connect = async (): Promise<Database> => {
    await ensureDatabaseDirectory(databasePath);

    const sqlite = new SqliteDatabase(databasePath);
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec("PRAGMA journal_mode = WAL");

    const database = new Kysely<DatabaseSchema>({
      dialect: new DenoSqlite3Dialect({
        database: sqlite,
      }),
    });

    await migrateThreads(database);
    await migrateLlmSettings(database);
    await loadLlmSettings(database);

    return database;
  };

  return connect;
}
