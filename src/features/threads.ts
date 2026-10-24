import type { ColumnType, Insertable, Selectable } from "kysely";
import type { AgentId } from "./agents/index.ts";
import type { Database } from "./database.ts";
import {
  getGuestInlineMessageId,
  getGuestMessageScope,
} from "./guest-threads.ts";

export type ThreadsTable = {
  chat_id: number;
  message_id: number;
  thread_id: number;
  agent_name: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
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
  conversation_key: ColumnType<string | null, string | null | undefined>;
  caller_id: ColumnType<number | null, number | null | undefined>;
  content_fingerprint: ColumnType<string | null, string | null | undefined>;
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
export type GuestThreadLinksTable = ThreadsTable & { conversation_key: string };
export type GuestResponseThread = Selectable<GuestResponseThreadsTable>;
export type CreateGuestResponseThread = Insertable<GuestResponseThreadsTable>;

export async function migrateThreads(database: Database) {
  await database.schema
    .createTable("threads")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("message_id", "integer", (column) => column.notNull())
    .addColumn("thread_id", "integer", (column) => column.notNull())
    .addColumn("agent_id", "text")
    .addColumn("agent_name", "text")
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

  try {
    await database.schema
      .alterTable("threads")
      .addColumn("agent_name", "text")
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
  }

  await database.schema
    .createIndex("threads_topic_message_index")
    .ifNotExists()
    .on("threads")
    .columns(["chat_id", "thread_id", "message_id"])
    .execute();

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

  const guestColumns = (await database.introspection.getTables()).find(
    (table) => table.name === "guest_response_threads",
  )?.columns;
  for (const [name, type] of [
    ["conversation_key", "text"],
    ["caller_id", "integer"],
    ["content_fingerprint", "text"],
  ] as const) {
    if (!guestColumns?.some((column) => column.name === name)) {
      await database.schema
        .alterTable("guest_response_threads")
        .addColumn(name, type)
        .execute();
    }
  }

  await database.schema
    .dropIndex("guest_response_content_index")
    .ifExists()
    .execute();
  await database.schema
    .dropIndex("guest_response_reference_index")
    .ifExists()
    .execute();
  await database.schema
    .createIndex("guest_response_content_lookup_index")
    .ifNotExists()
    .on("guest_response_threads")
    .columns(["conversation_key", "caller_id", "content_fingerprint"])
    .execute();

  await database.schema
    .createTable("guest_thread_links")
    .ifNotExists()
    .addColumn("conversation_key", "text", (column) => column.notNull())
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("message_id", "integer", (column) => column.notNull())
    .addColumn("thread_id", "integer", (column) => column.notNull())
    .addColumn("agent_id", "text")
    .addColumn("agent_name", "text")
    .addColumn("response_id", "text")
    .addPrimaryKeyConstraint("guest_thread_links_primary_key", [
      "conversation_key",
      "chat_id",
      "message_id",
    ])
    .execute();

  // Recover exact numeric links for existing guest answers from their stored
  // inline identifiers. Old content/time guesses are not copied into new scopes.
  const references = await database
    .selectFrom("guest_response_threads")
    .selectAll()
    .where("conversation_key", "is not", null)
    .where("caller_id", "is not", null)
    .where("inline_message_id", "is not", null)
    .execute();
  for (const reference of references) {
    if (!reference.conversation_key || reference.caller_id === null) continue;
    const messageId = getGuestInlineMessageId(reference);
    for (const id of new Set([
      reference.trigger_message_id,
      ...(messageId === undefined ? [] : [messageId]),
    ])) {
      await database
        .insertInto("guest_thread_links")
        .values({
          conversation_key: getGuestMessageScope(
            reference.conversation_key,
            reference.chat_id,
            reference.caller_id,
          ),
          chat_id: reference.chat_id,
          message_id: id,
          thread_id: reference.thread_id,
          response_id: reference.response_id,
          agent_id: reference.agent_id,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["conversation_key", "chat_id", "message_id"])
            .doNothing(),
        )
        .execute();
    }
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

export async function getLatestTopicThread(
  database: Database,
  {
    chatId,
    threadId,
    beforeMessageId,
  }: {
    chatId: number;
    threadId: number;
    beforeMessageId: number;
  },
): Promise<Thread | undefined> {
  return await database
    .selectFrom("threads")
    .selectAll()
    .where("chat_id", "=", chatId)
    .where("thread_id", "=", threadId)
    .where("message_id", "<", beforeMessageId)
    .where("response_id", "is not", null)
    .orderBy("message_id", "desc")
    .executeTakeFirst();
}

export async function createThread(
  database: Database,
  thread: CreateThread,
): Promise<Thread> {
  const row: Thread = {
    ...thread,
    agent_id: thread.agent_id ?? null,
    agent_name: thread.agent_name ?? null,
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
    agent_name: thread.agent_name ?? null,
    response_id: thread.response_id ?? null,
  };

  await database
    .insertInto("threads")
    .values(row)
    .onConflict((conflict) =>
      conflict.columns(["chat_id", "message_id"]).doUpdateSet({
        thread_id: row.thread_id,
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        response_id: row.response_id,
      }),
    )
    .execute();

  return row;
}

export async function getUniqueGuestResponseByContent(
  database: Database,
  {
    conversationKey,
    callerId,
    contentFingerprint,
  }: {
    conversationKey: string;
    callerId: number;
    contentFingerprint: string;
  },
): Promise<GuestResponseThread | undefined> {
  const rows = await database
    .selectFrom("guest_response_threads")
    .selectAll()
    .where("conversation_key", "=", conversationKey)
    .where("caller_id", "=", callerId)
    .where("content_fingerprint", "=", contentFingerprint)
    .where("inline_message_id", "is not", null)
    .limit(2)
    .execute();
  return rows.length === 1 ? rows[0] : undefined;
}

export async function getGuestThreadLink(
  database: Database,
  key: ThreadKey & { conversation_key: string },
): Promise<Thread | undefined> {
  return await database
    .selectFrom("guest_thread_links")
    .selectAll()
    .where("conversation_key", "=", key.conversation_key)
    .where("chat_id", "=", key.chat_id)
    .where("message_id", "=", key.message_id)
    .executeTakeFirst();
}

export async function saveGuestThreadLink(
  database: Database,
  thread: CreateThread & { conversation_key: string },
): Promise<Thread> {
  const row = {
    ...thread,
    agent_id: thread.agent_id ?? null,
    agent_name: thread.agent_name ?? null,
    response_id: thread.response_id ?? null,
  };
  await database
    .insertInto("guest_thread_links")
    .values(row)
    .onConflict((conflict) =>
      conflict
        .columns(["conversation_key", "chat_id", "message_id"])
        .doUpdateSet({
          thread_id: row.thread_id,
          agent_id: row.agent_id,
          agent_name: row.agent_name,
          response_id: row.response_id,
        }),
    )
    .execute();
  return row;
}

export async function saveGuestResponseThread(
  database: Database,
  thread: CreateGuestResponseThread,
): Promise<GuestResponseThread> {
  const now = new Date().toISOString();
  const row: GuestResponseThread = {
    ...thread,
    conversation_key: thread.conversation_key ?? null,
    caller_id: thread.caller_id ?? null,
    content_fingerprint: thread.content_fingerprint ?? null,
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
        conversation_key: row.conversation_key,
        caller_id: row.caller_id,
        content_fingerprint: row.content_fingerprint,
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
