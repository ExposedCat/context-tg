import { sql } from "@kysely/kysely";
import type { Database } from "./database.ts";

export type ChatProactiveResponsesTable = {
  chat_id: number;
  message_count: number;
  interval_message_count: number;
  enabled: number;
};

export type ProactiveResponseSettings = {
  enabled: boolean;
  intervalMessageCount: number;
};

export const DEFAULT_PROACTIVE_RESPONSE_INTERVAL_MESSAGE_COUNT = 100;
const TRIGGER_CHANCE = 0.25;

export async function migrateProactiveResponses(database: Database) {
  await database.schema
    .createTable("chat_proactive_responses")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.primaryKey().notNull())
    .addColumn("message_count", "integer", (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn("interval_message_count", "integer", (column) =>
      column
        .notNull()
        .defaultTo(DEFAULT_PROACTIVE_RESPONSE_INTERVAL_MESSAGE_COUNT),
    )
    .addColumn("enabled", "integer", (column) => column.notNull().defaultTo(1))
    .execute();

  try {
    await database.schema
      .alterTable("chat_proactive_responses")
      .addColumn("interval_message_count", "integer", (column) =>
        column
          .notNull()
          .defaultTo(DEFAULT_PROACTIVE_RESPONSE_INTERVAL_MESSAGE_COUNT),
      )
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
  }

  try {
    await database.schema
      .alterTable("chat_proactive_responses")
      .addColumn("enabled", "integer", (column) =>
        column.notNull().defaultTo(1),
      )
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
  }
}

export async function incrementProactiveResponseMessageCount(
  database: Database,
  chatId: number,
): Promise<{ messageCount: number } & ProactiveResponseSettings> {
  return await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("chat_proactive_responses")
      .values({
        chat_id: chatId,
        message_count: 0,
        interval_message_count:
          DEFAULT_PROACTIVE_RESPONSE_INTERVAL_MESSAGE_COUNT,
        enabled: 1,
      })
      .onConflict((conflict) => conflict.column("chat_id").doNothing())
      .execute();

    await transaction
      .updateTable("chat_proactive_responses")
      .set({ message_count: sql<number>`message_count + 1` })
      .where("chat_id", "=", chatId)
      .execute();

    const row = await transaction
      .selectFrom("chat_proactive_responses")
      .select(["message_count", "interval_message_count", "enabled"])
      .where("chat_id", "=", chatId)
      .executeTakeFirst();

    return {
      messageCount: row?.message_count ?? 0,
      enabled: row?.enabled !== 0,
      intervalMessageCount:
        row?.interval_message_count ??
        DEFAULT_PROACTIVE_RESPONSE_INTERVAL_MESSAGE_COUNT,
    };
  });
}

export async function setProactiveResponseInterval(
  database: Database,
  chatId: number,
  intervalMessageCount: number,
): Promise<void> {
  await database
    .insertInto("chat_proactive_responses")
    .values({
      chat_id: chatId,
      message_count: 0,
      interval_message_count: intervalMessageCount,
      enabled: 1,
    })
    .onConflict((conflict) =>
      conflict.column("chat_id").doUpdateSet({
        message_count: 0,
        interval_message_count: intervalMessageCount,
        enabled: 1,
      }),
    )
    .execute();
}

export async function setProactiveResponseEnabled(
  database: Database,
  chatId: number,
  enabled: boolean,
): Promise<void> {
  await database
    .insertInto("chat_proactive_responses")
    .values({
      chat_id: chatId,
      message_count: 0,
      interval_message_count: DEFAULT_PROACTIVE_RESPONSE_INTERVAL_MESSAGE_COUNT,
      enabled: enabled ? 1 : 0,
    })
    .onConflict((conflict) =>
      conflict.column("chat_id").doUpdateSet({
        message_count: 0,
        enabled: enabled ? 1 : 0,
      }),
    )
    .execute();
}

export async function getProactiveResponseSettings(
  database: Database,
  chatId: number,
): Promise<ProactiveResponseSettings> {
  const row = await database
    .selectFrom("chat_proactive_responses")
    .select(["interval_message_count", "enabled"])
    .where("chat_id", "=", chatId)
    .executeTakeFirst();

  return {
    enabled: row?.enabled !== 0,
    intervalMessageCount:
      row?.interval_message_count ??
      DEFAULT_PROACTIVE_RESPONSE_INTERVAL_MESSAGE_COUNT,
  };
}

export function shouldTriggerProactiveResponse(
  messageCount: number,
  enabled: boolean,
  intervalMessageCount: number,
): boolean {
  return (
    enabled &&
    messageCount > 0 &&
    intervalMessageCount > 0 &&
    messageCount % intervalMessageCount === 0 &&
    Math.random() < TRIGGER_CHANCE
  );
}
