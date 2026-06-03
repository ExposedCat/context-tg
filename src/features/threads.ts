import type { ColumnType, Insertable, Selectable } from "@kysely/kysely";
import type { AgentId } from "./agents/index.ts";
import type { Database } from "./database.ts";

export type ThreadsTable = {
  chat_id: number;
  message_id: number;
  agent_id: ColumnType<
    AgentId | null,
    AgentId | null | undefined,
    AgentId | null
  >;
  response_id: ColumnType<
    string | null,
    string | null | undefined,
    string | null
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
    .addColumn("agent_id", "text")
    .addColumn("response_id", "text")
    .addPrimaryKeyConstraint("threads_primary_key", ["chat_id", "message_id"])
    .execute();

  try {
    await database.schema
      .alterTable("threads")
      .addColumn("agent_id", "text")
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
  }
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
    agent_id: thread.agent_id ?? null,
    response_id: thread.response_id ?? null,
  };

  await database.insertInto("threads").values(row).execute();

  return row;
}
