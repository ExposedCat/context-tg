import { sql } from "kysely";
import type { Database } from "./database.ts";

export type ForwardedMessage = {
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_sender_name?: string;
  forward_date?: number;
};

export function isForwardedMessage(message: ForwardedMessage): boolean {
  return (
    message.forward_origin !== undefined ||
    message.forward_from !== undefined ||
    message.forward_from_chat !== undefined ||
    message.forward_sender_name !== undefined ||
    message.forward_date !== undefined
  );
}

export type ForwardReplyCooldownsTable = {
  chat_id: number;
  next_allowed_at: number;
};

export const FORWARD_REPLY_COOLDOWN_MS = 60_000;
const inFlight = new WeakMap<Database, Set<number>>();

export async function migrateForwardReplyCooldowns(database: Database) {
  await database.schema
    .createTable("forward_reply_cooldowns")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.primaryKey().notNull())
    .addColumn("next_allowed_at", "integer", (column) => column.notNull())
    .execute();
}

// Reserve before routing, including declined/failed attempts. A burst gets
// zero or one answer; later forwards are dropped, never deferred or retried.
export async function withForwardReplyLimit(
  database: Database,
  chatId: number,
  processForward: () => Promise<void>,
  now: () => number = Date.now,
): Promise<boolean> {
  let active = inFlight.get(database);
  if (!active) {
    active = new Set();
    inFlight.set(database, active);
  }
  if (active.has(chatId)) return false;
  active.add(chatId);
  let reserved = false;
  try {
    const startedAt = now();
    const reservation = await database
      .insertInto("forward_reply_cooldowns")
      .values({
        chat_id: chatId,
        next_allowed_at: startedAt + FORWARD_REPLY_COOLDOWN_MS,
      })
      .onConflict((conflict) =>
        conflict
          .column("chat_id")
          .doUpdateSet({
            next_allowed_at: startedAt + FORWARD_REPLY_COOLDOWN_MS,
          })
          .where("next_allowed_at", "<=", startedAt),
      )
      .returning("chat_id")
      .executeTakeFirst();
    if (!reservation) return false;
    reserved = true;
    await processForward();
    return true;
  } finally {
    try {
      // Keep the chat reserved throughout slow generation/delivery, then wait
      // a full minute after completion so two delayed answers cannot bunch up.
      if (reserved)
        await database
          .updateTable("forward_reply_cooldowns")
          .set({
            next_allowed_at: sql<number>`max(next_allowed_at, ${now() + FORWARD_REPLY_COOLDOWN_MS})`,
          })
          .where("chat_id", "=", chatId)
          .execute();
    } finally {
      active.delete(chatId);
    }
  }
}
