import { Database as BunDatabase } from "bun:sqlite";
import {
  type SqliteDatabase,
  SqliteDialect,
  type SqliteStatement,
} from "kysely";

// bun:sqlite returns INTEGER columns as exact JS numbers up to 2^53; Telegram
// ids (-100… chats, newer users) and ms timestamps all fit. It never truncates
// to 32 bits like @db/sqlite did without its int64 option.
export function openSqlite(path: string): BunDatabase {
  const sqlite = new BunDatabase(path, { create: true, strict: true });
  sqlite.run("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") sqlite.run("PRAGMA journal_mode = WAL");
  return sqlite;
}

// Adapts bun:sqlite to the better-sqlite3-shaped interface Kysely's built-in
// SqliteDialect expects. Statements are not cached: Kysely compiles fresh SQL
// per query and bun:sqlite's `prepare` is cheap.
function adapt(sqlite: BunDatabase): SqliteDatabase {
  return {
    close: () => sqlite.close(),
    prepare(sql): SqliteStatement {
      const statement = sqlite.prepare(sql);
      return {
        // INSERT/UPDATE … RETURNING also produce columns and must use `all`.
        reader: statement.columnNames.length > 0,
        all: (parameters) =>
          statement.all(...(parameters as never[])) as unknown[],
        run: (parameters) => statement.run(...(parameters as never[])),
        iterate: (parameters) =>
          statement.iterate(
            ...(parameters as never[]),
          ) as IterableIterator<unknown>,
      };
    },
  };
}

export function createSqliteDialect(sqlite: BunDatabase): SqliteDialect {
  return new SqliteDialect({ database: adapt(sqlite) });
}
