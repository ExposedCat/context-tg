import type { Database } from "./database.ts";
import type { CalendarEvent } from "./google-calendar.ts";

export type CalendarEventArchiveTable = {
  chat_id: number;
  calendar_id: string;
  event_id: string;
  resource_json: string;
  saved_at: number;
};
export type CalendarWatchTable = {
  chat_id: number;
  calendar_id: string;
  verification_id: string;
  registration_id: string;
  thread_id: number | null;
  enabled: number;
  sync_token: string | null;
  last_polled_at: number;
};

export async function migrateCalendarOperations(
  database: Database,
): Promise<void> {
  await database.schema
    .createTable("calendar_event_archives")
    .ifNotExists()
    .addColumn("chat_id", "integer", (c) => c.notNull())
    .addColumn("calendar_id", "text", (c) => c.notNull())
    .addColumn("event_id", "text", (c) => c.notNull())
    .addColumn("resource_json", "text", (c) => c.notNull())
    .addColumn("saved_at", "integer", (c) => c.notNull())
    .addPrimaryKeyConstraint("calendar_event_archives_pk", [
      "chat_id",
      "calendar_id",
      "event_id",
    ])
    .execute();
  await database.schema
    .createTable("calendar_watches")
    .ifNotExists()
    .addColumn("chat_id", "integer", (c) => c.notNull())
    .addColumn("calendar_id", "text", (c) => c.notNull())
    .addColumn("verification_id", "text", (c) => c.notNull())
    .addColumn("registration_id", "text", (c) => c.notNull())
    .addColumn("thread_id", "integer")
    .addColumn("enabled", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("sync_token", "text")
    .addColumn("last_polled_at", "integer", (c) => c.notNull().defaultTo(0))
    .addPrimaryKeyConstraint("calendar_watches_pk", ["chat_id", "calendar_id"])
    .execute();
}

export async function archiveCalendarEvent(
  database: Database,
  chatId: number,
  calendarId: string,
  event: CalendarEvent,
) {
  const row = {
    chat_id: chatId,
    calendar_id: calendarId,
    event_id: event.id,
    resource_json: JSON.stringify(event),
    saved_at: Date.now(),
  };
  await database
    .insertInto("calendar_event_archives")
    .values(row)
    .onConflict((c) =>
      c.columns(["chat_id", "calendar_id", "event_id"]).doUpdateSet(row),
    )
    .execute();
}

export async function getCalendarEventArchive(
  database: Database,
  chatId: number,
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent | undefined> {
  const row = await database
    .selectFrom("calendar_event_archives")
    .select("resource_json")
    .where("chat_id", "=", chatId)
    .where("calendar_id", "=", calendarId)
    .where("event_id", "=", eventId)
    .executeTakeFirst();
  return row ? (JSON.parse(row.resource_json) as CalendarEvent) : undefined;
}
