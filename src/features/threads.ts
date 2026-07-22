import type { ColumnType, Insertable, Selectable } from "@kysely/kysely";
import type { AgentId } from "./agents/index.ts";
import type { Database } from "./database.ts";

export type ThreadsTable = {
  chat_id: number;
  message_id: number;
  thread_id: number;
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

export type GuestResponseThreadsTable = {
  chat_id: number;
  response_fingerprint: string;
  trigger_message_id: number;
  thread_id: number;
  agent_id: ColumnType<
    AgentId | null,
    AgentId | null | undefined,
    AgentId | null
  >;
  response_id: string;
  inline_message_id: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  created_at: ColumnType<string, string | undefined, string>;
  updated_at: ColumnType<string, string | undefined, string>;
};

export type Thread = Selectable<ThreadsTable>;
export type CreateThread = Insertable<ThreadsTable>;
export type ThreadKey = Pick<Thread, "chat_id" | "message_id">;
export type GuestResponseThread = Selectable<GuestResponseThreadsTable>;
export type CreateGuestResponseThread = Insertable<GuestResponseThreadsTable>;
export type GuestResponseThreadDateKey = Pick<
  GuestResponseThread,
  "chat_id"
> & {
  date: Date;
  toleranceSeconds?: number;
};

export async function migrateThreads(database: Database) {
  await database.schema
    .createTable("threads")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("message_id", "integer", (column) => column.notNull())
    .addColumn("thread_id", "integer", (column) => column.notNull())
    .addColumn("agent_id", "text")
    .addColumn("response_id", "text")
    .addPrimaryKeyConstraint("threads_primary_key", ["chat_id", "message_id"])
    .execute();

  try {
    await database.schema
      .alterTable("threads")
      .addColumn("thread_id", "integer")
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
  }

  await database
    .updateTable("threads")
    .set(({ ref }) => ({ thread_id: ref("message_id") }))
    .where("thread_id", "is", null)
    .execute();

  try {
    await database.schema
      .alterTable("threads")
      .addColumn("agent_id", "text")
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
  }

  await database.schema
    .createTable("guest_response_threads")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("response_fingerprint", "text", (column) => column.notNull())
    .addColumn("trigger_message_id", "integer", (column) => column.notNull())
    .addColumn("thread_id", "integer", (column) => column.notNull())
    .addColumn("agent_id", "text")
    .addColumn("response_id", "text", (column) => column.notNull())
    .addColumn("inline_message_id", "text")
    .addColumn("created_at", "text", (column) => column.notNull())
    .addColumn("updated_at", "text", (column) => column.notNull())
    .addPrimaryKeyConstraint("guest_response_threads_primary_key", [
      "chat_id",
      "response_fingerprint",
    ])
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
    agent_id: thread.agent_id ?? null,
    response_id: thread.response_id ?? null,
  };

  await database.insertInto("threads").values(row).execute();

  return row;
}

export async function saveThread(
  database: Database,
  thread: CreateThread,
): Promise<Thread> {
  const row: Thread = {
    ...thread,
    agent_id: thread.agent_id ?? null,
    response_id: thread.response_id ?? null,
  };

  await database
    .insertInto("threads")
    .values(row)
    .onConflict((conflict) =>
      conflict.columns(["chat_id", "message_id"]).doUpdateSet({
        agent_id: row.agent_id,
        response_id: row.response_id,
      }),
    )
    .execute();

  return row;
}

export async function getGuestResponseThreadByDate(
  database: Database,
  { chat_id, date, toleranceSeconds = 30 }: GuestResponseThreadDateKey,
): Promise<GuestResponseThread | undefined> {
  const start = new Date(date.getTime() - toleranceSeconds * 1000);
  const end = new Date(date.getTime() + toleranceSeconds * 1000);
  const rows = await database
    .selectFrom("guest_response_threads")
    .selectAll()
    .where("chat_id", "=", chat_id)
    .where("created_at", ">=", start.toISOString())
    .where("created_at", "<=", end.toISOString())
    .execute();

  return rows.toSorted(
    (left, right) =>
      Math.abs(new Date(left.created_at).getTime() - date.getTime()) -
      Math.abs(new Date(right.created_at).getTime() - date.getTime()),
  )[0];
}

export async function saveGuestResponseThread(
  database: Database,
  thread: CreateGuestResponseThread,
): Promise<GuestResponseThread> {
  const now = new Date().toISOString();
  const row: GuestResponseThread = {
    ...thread,
    agent_id: thread.agent_id ?? null,
    inline_message_id: thread.inline_message_id ?? null,
    created_at: thread.created_at ?? now,
    updated_at: thread.updated_at ?? now,
  };

  await database
    .insertInto("guest_response_threads")
    .values(row)
    .onConflict((conflict) =>
      conflict.columns(["chat_id", "response_fingerprint"]).doUpdateSet({
        trigger_message_id: row.trigger_message_id,
        thread_id: row.thread_id,
        agent_id: row.agent_id,
        response_id: row.response_id,
        inline_message_id: row.inline_message_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }),
    )
    .execute();

  return row;
}
