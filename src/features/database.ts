import { Database as SqliteDatabase } from "@db/sqlite";
import { Kysely } from "@kysely/kysely";
import { DenoSqlite3Dialect } from "@marshift/kysely-deno-sqlite3";
import { migrateThreads, type ThreadsTable } from "./threads.ts";

const DEFAULT_SQLITE_PATH = "data/context-tg.sqlite";

export type DatabaseSchema = {
	threads: ThreadsTable;
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
	const databasePath = Deno.env.get("SQLITE_PATH") ?? DEFAULT_SQLITE_PATH;

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

		return database;
	};

	return connect;
}
