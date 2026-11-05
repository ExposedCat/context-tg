import { sql } from "kysely";
import type { Database } from "./database.ts";
import {
  type CalendarEvent,
  type CalendarEventsPage,
  calendarDate,
  type GoogleCalendarApi,
} from "./google-calendar.ts";

export type ChatCalendarTable = {
  chat_id: number;
  calendar_id: string;
  name: string;
  time_zone: string;
  linked_by: number;
  verified_at: number;
  verification_id: string;
};

export type CalendarChallengeTable = {
  chat_id: number;
  user_id: number;
  calendar_id: string;
  calendar_name: string;
  token: string;
  title: string;
  day: string;
  created_at: number;
  expires_at: number;
  verified_at: number | null;
  message_id: number | null;
};

export type ChatCalendarSettingsTable = {
  chat_id: number;
  enabled: number;
};

export type CalendarApi = Pick<
  GoogleCalendarApi,
  "email" | "metadata" | "assertWritable" | "request" | "requestGlobal"
>;

export async function migrateCalendars(database: Database): Promise<void> {
  const existingTables = await database.introspection.getTables();
  await database.schema
    .createTable("chat_calendars")
    .ifNotExists()
    .addColumn("chat_id", "integer", (c) => c.primaryKey())
    .addColumn("calendar_id", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("time_zone", "text", (c) => c.notNull())
    .addColumn("linked_by", "integer", (c) => c.notNull())
    .addColumn("verified_at", "integer", (c) => c.notNull())
    .addColumn("verification_id", "text", (c) => c.notNull())
    .execute();
  await database.schema
    .createTable("chat_calendar_links")
    .ifNotExists()
    .addColumn("chat_id", "integer", (c) => c.notNull())
    .addColumn("calendar_id", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("time_zone", "text", (c) => c.notNull())
    .addColumn("linked_by", "integer", (c) => c.notNull())
    .addColumn("verified_at", "integer", (c) => c.notNull())
    .addColumn("verification_id", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("chat_calendar_links_pk", [
      "chat_id",
      "calendar_id",
    ])
    .execute();
  await sql`INSERT OR IGNORE INTO chat_calendar_links
    SELECT chat_id, calendar_id, name, time_zone, linked_by, verified_at, verification_id FROM chat_calendars`.execute(
    database,
  );
  await database.schema
    .createTable("calendar_challenges")
    .ifNotExists()
    .addColumn("chat_id", "integer", (c) => c.primaryKey())
    .addColumn("user_id", "integer", (c) => c.notNull())
    .addColumn("calendar_id", "text", (c) => c.notNull())
    .addColumn("calendar_name", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("token", "text", (c) => c.notNull().unique())
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("day", "text", (c) => c.notNull())
    .addColumn("created_at", "integer", (c) => c.notNull())
    .addColumn("expires_at", "integer", (c) => c.notNull())
    .addColumn("verified_at", "integer")
    .addColumn("message_id", "integer")
    .execute();
  const oldChallenges = existingTables.find(
    (table) => table.name === "calendar_challenges",
  );
  if (
    oldChallenges &&
    !oldChallenges.columns.some((column) => column.name === "calendar_name")
  )
    await database.schema
      .alterTable("calendar_challenges")
      .addColumn("calendar_name", "text", (c) => c.notNull().defaultTo(""))
      .execute();
  await database.schema
    .createTable("chat_calendar_settings")
    .ifNotExists()
    .addColumn("chat_id", "integer", (c) => c.primaryKey())
    .addColumn("enabled", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
  // Carry the setup administrator's legacy preference to known chats once.
  // Never infer access for arbitrary chats from a personal toggle.
  if (
    !existingTables.some((table) => table.name === "chat_calendar_settings") &&
    existingTables
      .find((table) => table.name === "user_settings")
      ?.columns.some((column) => column.name === "calendar_mcp_enabled")
  ) {
    await sql`INSERT INTO chat_calendar_settings (chat_id, enabled)
      SELECT known.chat_id, MAX(users.calendar_mcp_enabled)
      FROM (
        SELECT chat_id, linked_by AS user_id FROM chat_calendars
        UNION ALL
        SELECT chat_id, user_id FROM calendar_challenges
      ) AS known JOIN user_settings AS users ON users.user_id = known.user_id
      GROUP BY known.chat_id`.execute(database);
  }
}

export async function getCalendarMcpEnabled(
  database: Database,
  chatId: number,
): Promise<boolean> {
  const row = await database
    .selectFrom("chat_calendar_settings")
    .select("enabled")
    .where("chat_id", "=", chatId)
    .executeTakeFirst();
  return row?.enabled === 1;
}

export async function setCalendarMcpEnabled(
  database: Database,
  chatId: number,
  enabled: boolean,
): Promise<void> {
  await database
    .insertInto("chat_calendar_settings")
    .values({ chat_id: chatId, enabled: enabled ? 1 : 0 })
    .onConflict((c) =>
      c.column("chat_id").doUpdateSet({ enabled: enabled ? 1 : 0 }),
    )
    .execute();
}

export function getChatCalendar(database: Database, chatId: number) {
  return database
    .selectFrom("chat_calendars")
    .selectAll()
    .where("chat_id", "=", chatId)
    .executeTakeFirst();
}

export function getChatCalendars(database: Database, chatId: number) {
  return database
    .selectFrom("chat_calendar_links")
    .selectAll()
    .where("chat_id", "=", chatId)
    .orderBy("verified_at", "desc")
    .execute();
}

export async function linkChatCalendar(
  database: Database,
  binding: ChatCalendarTable,
): Promise<void> {
  await database.transaction().execute(async (tx) => {
    await tx
      .insertInto("chat_calendar_links")
      .values(binding)
      .onConflict((c) =>
        c.columns(["chat_id", "calendar_id"]).doUpdateSet(binding),
      )
      .execute();
    await tx
      .insertInto("chat_calendars")
      .values(binding)
      .onConflict((c) => c.column("chat_id").doUpdateSet(binding))
      .execute();
  });
}

export async function unlinkChatCalendar(
  database: Database,
  chatId: number,
  calendarId: string,
): Promise<void> {
  await database.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("chat_calendar_links")
      .where("chat_id", "=", chatId)
      .where("calendar_id", "=", calendarId)
      .execute();
    const current = await getChatCalendar(tx, chatId);
    if (current?.calendar_id === calendarId) {
      const [next] = await getChatCalendars(tx, chatId);
      if (next)
        await tx
          .updateTable("chat_calendars")
          .set(next)
          .where("chat_id", "=", chatId)
          .execute();
      else
        await tx
          .deleteFrom("chat_calendars")
          .where("chat_id", "=", chatId)
          .execute();
    }
  });
}

export function getCalendarChallenge(database: Database, chatId: number) {
  return database
    .selectFrom("calendar_challenges")
    .selectAll()
    .where("chat_id", "=", chatId)
    .executeTakeFirst();
}

export async function beginCalendarSetup(
  database: Database,
  chatId: number,
  userId: number,
  calendarId: string,
  api: CalendarApi,
  now = Date.now(),
): Promise<CalendarChallengeTable> {
  if (!/^[^\s/@]+@[^\s/]+$/.test(calendarId) || calendarId.length > 1024)
    throw new Error(
      "Use the Calendar ID from Google Calendar Settings → Integrate calendar, not a URL or 'primary'.",
    );
  const metadata = await api.metadata(calendarId);
  await api.assertWritable(calendarId);
  const token = crypto.randomUUID().replaceAll("-", "");
  const challenge: CalendarChallengeTable = {
    chat_id: chatId,
    user_id: userId,
    calendar_id: calendarId,
    calendar_name: metadata.summary,
    token,
    title: `Telegram Integration #${token}`,
    day: calendarDate(new Date(now), metadata.timeZone),
    created_at: now,
    expires_at: now + 10 * 60_000,
    verified_at: null,
    message_id: null,
  };
  await database
    .insertInto("calendar_challenges")
    .values(challenge)
    .onConflict((c) => c.column("chat_id").doUpdateSet(challenge))
    .execute();
  return challenge;
}

function isVerificationEvent(
  event: CalendarEvent,
  challenge: CalendarChallengeTable,
  timeZone: string,
  serviceEmail: string,
  now: number,
): boolean {
  const created = Date.parse(event.created ?? "");
  const start = event.start?.dateTime;
  const day =
    event.start?.date ??
    (start && Number.isFinite(Date.parse(start))
      ? calendarDate(new Date(start), timeZone)
      : undefined);
  return (
    event.summary === challenge.title &&
    event.status === "confirmed" &&
    event.organizer?.self === true &&
    typeof event.creator?.email === "string" &&
    event.creator?.email?.toLowerCase() !== serviceEmail.toLowerCase() &&
    !event.recurrence?.length &&
    !event.recurringEventId &&
    !event.attendees?.length &&
    Number.isFinite(created) &&
    created >= challenge.created_at &&
    created <= now &&
    day === challenge.day &&
    calendarDate(new Date(now), timeZone) === challenge.day
  );
}

export async function verifyCalendarSetup(
  database: Database,
  chatId: number,
  userId: number,
  token: string,
  api: CalendarApi,
  now = Date.now(),
): Promise<ChatCalendarTable> {
  const challenge = await getCalendarChallenge(database, chatId);
  if (!challenge || challenge.token !== token || challenge.user_id !== userId)
    throw new Error(
      "This verification belongs to another setup. Run /calendar ID again.",
    );
  if (challenge.verified_at !== null) {
    const binding = await getChatCalendar(database, chatId);
    if (binding?.verification_id === token) return binding;
    throw new Error("This verification has already been used.");
  }
  if (challenge.expires_at <= now)
    throw new Error("Verification expired. Run /calendar ID again.");
  const metadata = await api.metadata(challenge.calendar_id);
  await api.assertWritable(challenge.calendar_id);
  let pageToken: string | undefined;
  let matched = false;
  do {
    const page = await api.request<CalendarEventsPage>(
      challenge.calendar_id,
      "/events",
      {
        query: {
          q: challenge.title,
          showDeleted: "false",
          singleEvents: "false",
          maxResults: "250",
          ...(pageToken ? { pageToken } : {}),
        },
      },
    );
    matched =
      page.items?.some((event) =>
        isVerificationEvent(
          event,
          challenge,
          metadata.timeZone,
          api.email,
          Math.max(now, Date.now()),
        ),
      ) ?? false;
    pageToken = page.nextPageToken;
  } while (!matched && pageToken);
  if (!matched)
    throw new Error(
      `Verification event not found yet. Google may take a little time to sync a saved event. Wait a few seconds and press Verify again, keeping the same event and title. Check that it is saved in calendar '${metadata.summary}'.`,
    );

  // Recheck after network I/O: expired, superseded and concurrent callbacks
  // must never overwrite a newer binding or consume the same challenge twice.
  return database.transaction().execute(async (tx) => {
    const currentTime = Math.max(now, Date.now());
    const consumed = await tx
      .updateTable("calendar_challenges")
      .set({ verified_at: currentTime })
      .where("chat_id", "=", chatId)
      .where("user_id", "=", userId)
      .where("token", "=", token)
      .where("verified_at", "is", null)
      .where("expires_at", ">", currentTime)
      .returningAll()
      .executeTakeFirst();
    if (!consumed) {
      const existing = await getChatCalendar(tx, chatId);
      if (existing?.verification_id === token) return existing;
      throw new Error(
        "Verification expired or was replaced. Run /calendar ID again.",
      );
    }
    const binding: ChatCalendarTable = {
      chat_id: chatId,
      calendar_id: challenge.calendar_id,
      name: metadata.summary,
      time_zone: metadata.timeZone,
      linked_by: userId,
      verified_at: currentTime,
      verification_id: token,
    };
    await tx
      .insertInto("chat_calendars")
      .values(binding)
      .onConflict((c) => c.column("chat_id").doUpdateSet(binding))
      .execute();
    await tx
      .insertInto("chat_calendar_links")
      .values(binding)
      .onConflict((c) =>
        c.columns(["chat_id", "calendar_id"]).doUpdateSet(binding),
      )
      .execute();
    return binding;
  });
}
