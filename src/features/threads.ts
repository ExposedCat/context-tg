import type { ColumnType, Insertable, Selectable } from "@kysely/kysely";
import type { Database } from "./database.ts";

export type ThreadsTable = {
	chat_id: number;
	message_id: number;
	response_id: ColumnType<
		number | null,
		number | null | undefined,
		number | null
	>;
};

export type Thread = Selectable<ThreadsTable>;
export type CreateThread = Insertable<ThreadsTable>;
export type ThreadKey = Pick<Thread, "chat_id" | "message_id">;

export async function migrateThreads(database: Database) {
	await database.schema
		.createTable("threads")
		.ifNotExists()
		.addColumn("chat_id", "integer", (column) => column.notNull())
		.addColumn("message_id", "integer", (column) => column.notNull())
		.addColumn("response_id", "integer")
		.addPrimaryKeyConstraint("threads_primary_key", ["chat_id", "message_id"])
		.execute();
}

export async function getThread(
	database: Database,
	{ chat_id, message_id }: ThreadKey,
): Promise<Thread | undefined> {
	return await database
		.selectFrom("threads")
		.selectAll()
		.where("chat_id", "=", chat_id)
		.where("message_id", "=", message_id)
		.executeTakeFirst();
}

export async function createThread(
	database: Database,
	thread: CreateThread,
): Promise<Thread> {
	const row: Thread = {
		...thread,
		response_id: thread.response_id ?? null,
	};

	await database.insertInto("threads").values(row).execute();

	return row;
}
