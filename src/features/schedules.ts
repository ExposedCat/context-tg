import { createDebug } from "@grammyjs/debug";
import { type ColumnType, type Insertable, type Selectable, sql } from "kysely";
import type { Context } from "../bot.ts";
import { padDatePart } from "../utils/date.ts";
import { normalizeRichMarkdown } from "../utils/markdown.ts";
import { escapeHtml, normalizeWhitespace } from "../utils/text.ts";
import type { Database } from "./database.ts";
import { resolveRichMessageImageMedia } from "./images.ts";
import {
  describeRecurrence,
  formatRecurrenceDate,
  MIN_RECURRENCE_MS,
  nextOccurrences,
  normalizeRecurrence,
  type Recurrence,
} from "./recurrence.ts";
import { disabledLinkPreviewOptions as linkPreviewOptions } from "./telegram.ts";

export type ScheduledMessageStatus =
  | "scheduled"
  | "sending"
  | "sent"
  | "failed"
  | "canceled";
export type CronMessageStatus =
  | "active"
  | "sending"
  | "failed"
  | "completed"
  | "canceled";
export type CronIntervalUnit =
  | "dayOfMonth"
  | "dayOfWeek"
  | "hour"
  | "minute"
  | "month";

export type ScheduledMessagesTable = {
  id: string;
  chat_id: string;
  thread_id: ColumnType<
    number | null,
    number | null | undefined,
    number | null
  >;
  message: string;
  short_elaboration: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  scheduled_at: string;
  created_at: ColumnType<string, string | undefined, string>;
  status: ColumnType<
    ScheduledMessageStatus,
    ScheduledMessageStatus | undefined,
    ScheduledMessageStatus
  >;
  sent_at: ColumnType<string | null, string | null | undefined, string | null>;
  canceled_at: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  last_error: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
};

export type CronMessagesTable = {
  id: string;
  chat_id: string;
  thread_id: ColumnType<
    number | null,
    number | null | undefined,
    number | null
  >;
  message: string;
  short_elaboration: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  rrule: string;
  starts_at: string;
  timezone: string;
  next_run_at: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  next_allowed_at: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  created_at: ColumnType<string, string | undefined, string>;
  status: ColumnType<
    CronMessageStatus,
    CronMessageStatus | undefined,
    CronMessageStatus
  >;
  last_sent_at: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  canceled_at: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  last_error: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
};

export type ScheduledMessage = Selectable<ScheduledMessagesTable>;
export type CronMessage = Selectable<CronMessagesTable>;
type CreateScheduledMessage = Insertable<ScheduledMessagesTable>;
type CreateCronMessage = Insertable<CronMessagesTable>;
type TelegramApi = Context["api"];
// Standard 5-field cron expression: minute hour day-of-month month day-of-week.
type CronSchedule = string;

type CreateScheduledMessageInput = {
  chatId: number;
  threadId?: number;
  message: string;
  shortElaboration: string;
  at: string;
};

type CreateCronMessageInput = {
  chatId: number;
  threadId?: number;
  message: string;
  shortElaboration: string;
  rrule: string;
  startsAt: string;
  timezone: string;
};

type CancelScheduleResult = "canceled" | "not_active" | "not_found";

const logDebug = createDebug("app:schedules:debug");
const logError = createDebug("app:schedules:error");

const MAX_ACTIVE_SCHEDULED_MESSAGES_PER_CHAT = 5;
const MAX_ACTIVE_CRON_MESSAGES_PER_CHAT = 10;
const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;
const MAX_SHORT_ELABORATION_LENGTH = 80;
const SCHEDULE_EMOJI_ID = "5967412305338568701";
const SCHEDULE_EMOJI_FALLBACK = "\u23f0";
const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;
const scheduledMessageControllers = new Map<string, Bun.CronJob>();
const cronMessageControllers = new Map<string, ReturnType<typeof setTimeout>>();
let dispatcherGeneration = 0;

const scheduledMessageSelect = [
  "id",
  sql<string>`CAST(chat_id AS TEXT)`.as("chat_id"),
  "thread_id",
  "message",
  "short_elaboration",
  "scheduled_at",
  "created_at",
  "status",
  "sent_at",
  "canceled_at",
  "last_error",
] as const;
const cronMessageSelect = [
  "id",
  sql<string>`CAST(chat_id AS TEXT)`.as("chat_id"),
  "thread_id",
  "message",
  "short_elaboration",
  "rrule",
  "starts_at",
  "timezone",
  "next_run_at",
  "next_allowed_at",
  "created_at",
  "status",
  "last_sent_at",
  "canceled_at",
  "last_error",
] as const;

let dispatcher:
  | {
      database: Database;
      api: TelegramApi;
    }
  | undefined;

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export async function migrateSchedules(database: Database): Promise<void> {
  await database.schema
    .createTable("scheduled_messages")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey().notNull())
    .addColumn("chat_id", "text", (column) => column.notNull())
    .addColumn("thread_id", "integer")
    .addColumn("message", "text", (column) => column.notNull())
    .addColumn("short_elaboration", "text")
    .addColumn("scheduled_at", "text", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) =>
      column.notNull().defaultTo("scheduled"),
    )
    .addColumn("sent_at", "text")
    .addColumn("canceled_at", "text")
    .addColumn("last_error", "text")
    .execute();

  const columns = await sql<{
    name: string;
  }>`PRAGMA table_info(cron_messages)`.execute(database);
  if (
    columns.rows.length &&
    !columns.rows.some((column) => column.name === "rrule")
  ) {
    await migrateLegacyCronMessages(database);
  } else {
    await createCronMessagesTable(database, "cron_messages");
  }

  // Older one-time schedules may predate the label column.
  const scheduledColumns = await sql<{
    name: string;
  }>`PRAGMA table_info(scheduled_messages)`.execute(database);
  if (
    !scheduledColumns.rows.some((column) => column.name === "short_elaboration")
  ) {
    await database.schema
      .alterTable("scheduled_messages")
      .addColumn("short_elaboration", "text")
      .execute();
  }

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_messages_active_chat_at_index
    ON scheduled_messages(chat_id, scheduled_at)
    WHERE status IN ('scheduled', 'sending')
  `.execute(database);

  await sql`
    CREATE INDEX IF NOT EXISTS scheduled_messages_chat_status_at_index
    ON scheduled_messages(chat_id, status, scheduled_at)
  `.execute(database);

  await sql`
    CREATE INDEX IF NOT EXISTS cron_messages_chat_status_created_index
    ON cron_messages(chat_id, status, created_at)
  `.execute(database);
}

async function createCronMessagesTable(
  database: Database,
  table: string,
): Promise<void> {
  await database.schema
    .createTable(table)
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey().notNull())
    .addColumn("chat_id", "text", (c) => c.notNull())
    .addColumn("thread_id", "integer")
    .addColumn("message", "text", (c) => c.notNull())
    .addColumn("short_elaboration", "text")
    .addColumn("rrule", "text", (c) => c.notNull())
    .addColumn("starts_at", "text", (c) => c.notNull())
    .addColumn("timezone", "text", (c) => c.notNull())
    .addColumn("next_run_at", "text")
    .addColumn("next_allowed_at", "text")
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("active"))
    .addColumn("last_sent_at", "text")
    .addColumn("canceled_at", "text")
    .addColumn("last_error", "text")
    .execute();
}

type LegacyCronMessage = {
  id: string;
  chat_id: string;
  thread_id?: number | null;
  message: string;
  short_elaboration?: string | null;
  interval_unit: CronIntervalUnit;
  interval_value: number;
  created_at: string;
  status: "active" | "canceled";
  last_sent_at: string | null;
  canceled_at: string | null;
  last_error: string | null;
};

async function migrateLegacyCronMessages(database: Database): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const { rows } =
      await sql<LegacyCronMessage>`SELECT * FROM cron_messages`.execute(
        transaction,
      );
    await createCronMessagesTable(transaction, "cron_messages_rrule_migration");
    for (const row of rows) {
      const step = row.interval_value;
      const sequence = (start: number, end: number) =>
        Array.from(
          { length: Math.floor((end - start) / step) + 1 },
          (_, i) => start + i * step,
        );
      let rrule: string;
      let adjusted = false;
      switch (row.interval_unit) {
        case "minute": {
          const minutes =
            step < 5
              ? [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
              : sequence(0, 59);
          if (minutes.length > 1 && 60 - minutes[minutes.length - 1] < 5) {
            minutes.pop();
            adjusted = true;
          }
          adjusted ||= step < 5;
          rrule = `FREQ=HOURLY;BYMINUTE=${minutes.join(",")}`;
          break;
        }
        case "hour":
          rrule = `FREQ=DAILY;BYHOUR=${sequence(0, 23).join(",")};BYMINUTE=0`;
          break;
        case "dayOfWeek":
          rrule = `FREQ=WEEKLY;BYDAY=${sequence(0, 6)
            .map((day) => ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][day])
            .join(",")};BYHOUR=0;BYMINUTE=0`;
          break;
        case "dayOfMonth":
          rrule = `FREQ=MONTHLY;BYMONTHDAY=${sequence(1, 31).join(",")};BYHOUR=0;BYMINUTE=0`;
          break;
        case "month":
          rrule = `FREQ=YEARLY;BYMONTH=${sequence(1, 12).join(",")};BYMONTHDAY=1;BYHOUR=0;BYMINUTE=0`;
          break;
      }
      const recurrence = normalizeRecurrence({
        rrule,
        startsAt: new Date(row.created_at)
          .toISOString()
          .slice(0, 16)
          .replace("T", " "),
        timezone: "UTC",
      });
      const note = adjusted
        ? "Legacy schedule adjusted to enforce the five-minute minimum."
        : row.last_error;
      await sql`INSERT INTO cron_messages_rrule_migration
        (id, chat_id, thread_id, message, short_elaboration, rrule, starts_at, timezone, created_at, status, last_sent_at, canceled_at, last_error, next_allowed_at)
        VALUES (${row.id}, ${String(row.chat_id)}, ${row.thread_id ?? null}, ${row.message}, ${row.short_elaboration ?? null}, ${recurrence.rrule}, ${recurrence.startsAt}, ${recurrence.timezone}, ${row.created_at}, ${row.status}, ${row.last_sent_at}, ${row.canceled_at}, ${note}, ${row.last_sent_at ? new Date(new Date(row.last_sent_at).getTime() + MIN_RECURRENCE_MS).toISOString() : null})`.execute(
        transaction,
      );
    }
    await transaction.schema.dropTable("cron_messages").execute();
    await transaction.schema
      .alterTable("cron_messages_rrule_migration")
      .renameTo("cron_messages")
      .execute();
  });
}

function createId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeThreadId(threadId: number | undefined): number | null {
  return threadId ?? null;
}

function normalizeChatId(chatId: number): string {
  return String(chatId);
}

function normalizeMessage(message: string): string {
  const normalized = message.trim();

  if (!normalized) {
    throw new ScheduleValidationError("Message cannot be empty.");
  }

  if (normalized.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
    throw new ScheduleValidationError(
      `Message is too long: maximum is ${MAX_TELEGRAM_MESSAGE_LENGTH} characters.`,
    );
  }

  return normalized;
}

function normalizeShortElaboration(
  shortElaboration: string,
  message: string,
): string {
  const normalized = normalizeWhitespace(shortElaboration);

  if (!normalized) {
    throw new ScheduleValidationError("Short elaboration cannot be empty.");
  }

  if (normalized.length > MAX_SHORT_ELABORATION_LENGTH) {
    throw new ScheduleValidationError(
      `Short elaboration is too long: maximum is ${MAX_SHORT_ELABORATION_LENGTH} characters.`,
    );
  }

  const words = normalized.split(" ");

  if (words.length > 3) {
    throw new ScheduleValidationError("Short elaboration must be 1-3 words.");
  }

  if (
    normalized.toLocaleLowerCase() ===
    normalizeWhitespace(message).toLocaleLowerCase()
  ) {
    throw new ScheduleValidationError(
      "Short elaboration cannot be the message itself.",
    );
  }

  return normalized;
}

function parseScheduleInputDate(value: string): Date {
  const trimmed = value.trim();
  const match = trimmed.match(LOCAL_DATE_TIME_PATTERN);

  if (!match) {
    return new Date(trimmed);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const date = new Date(year, month - 1, day, hour, minute, second, 0);

  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute &&
    date.getSeconds() === second
    ? date
    : new Date(Number.NaN);
}

function normalizeScheduledAt(value: string): string {
  const date = parseScheduleInputDate(value);

  if (Number.isNaN(date.getTime())) {
    throw new ScheduleValidationError("Invalid schedule date.");
  }

  date.setSeconds(0, 0);

  const currentMinute = new Date();
  currentMinute.setSeconds(0, 0);

  if (date.getTime() <= currentMinute.getTime()) {
    throw new ScheduleValidationError(
      "Schedule date must be at least one minute in the future.",
    );
  }

  return date.toISOString();
}

function parseScheduledAt(value: string): Date {
  return new Date(value);
}

function createOneTimeCronSchedule(date: Date): CronSchedule {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`;
}

function countRows(row: { count: number | string | bigint } | undefined) {
  return Number(row?.count ?? 0);
}

async function countActiveScheduledMessages(
  database: Database,
  chatId: number,
): Promise<number> {
  const row = await database
    .selectFrom("scheduled_messages")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("chat_id", "=", normalizeChatId(chatId))
    .where("status", "in", ["scheduled", "sending"])
    .executeTakeFirst();

  return countRows(row);
}

async function countActiveCronMessages(
  database: Database,
  chatId: number,
): Promise<number> {
  const row = await database
    .selectFrom("cron_messages")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("chat_id", "=", normalizeChatId(chatId))
    .where("status", "in", ["active", "sending", "failed"])
    .executeTakeFirst();

  return countRows(row);
}

async function getScheduledMessageAt(
  database: Database,
  chatId: number,
  scheduledAt: string,
): Promise<ScheduledMessage | undefined> {
  return await database
    .selectFrom("scheduled_messages")
    .select(scheduledMessageSelect)
    .where("chat_id", "=", normalizeChatId(chatId))
    .where("scheduled_at", "=", scheduledAt)
    .where("status", "in", ["scheduled", "sending"])
    .executeTakeFirst();
}

function isDuplicateScheduleError(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message);
}

function ensureDispatcher(): typeof dispatcher {
  return dispatcher;
}

function getCronName(prefix: string, id: string): string {
  return `${prefix}_${id.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function startCron(
  name: string,
  schedule: CronSchedule,
  handler: () => Promise<void>,
): Bun.CronJob | undefined {
  try {
    // Deno.cron always ran in UTC; keep that so stored schedules do not shift
    // with the container's TZ. An escaping rejection would exit the process,
    // so failures are logged here instead.
    return Bun.cron(
      schedule,
      async () => {
        try {
          await handler();
        } catch (error) {
          logError("Cron job failed", { name, error });
        }
      },
      { tz: "UTC" },
    );
  } catch (error) {
    logError("Failed to register cron job", { name, schedule, error });
    return undefined;
  }
}

function stopScheduledMessageCron(id: string): void {
  scheduledMessageControllers.get(id)?.stop();
  scheduledMessageControllers.delete(id);
}

function stopCronMessageCron(id: string): void {
  const timer = cronMessageControllers.get(id);
  if (timer) clearTimeout(timer);
  cronMessageControllers.delete(id);
}

async function getScheduledMessage(
  database: Database,
  id: string,
): Promise<ScheduledMessage | undefined> {
  return await database
    .selectFrom("scheduled_messages")
    .select(scheduledMessageSelect)
    .where("id", "=", id)
    .executeTakeFirst();
}

async function getCronMessage(
  database: Database,
  id: string,
): Promise<CronMessage | undefined> {
  return await database
    .selectFrom("cron_messages")
    .select(cronMessageSelect)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function sendScheduledRichMessage(
  database: Database,
  api: TelegramApi,
  row: Pick<
    ScheduledMessage | CronMessage,
    "chat_id" | "message" | "thread_id"
  >,
): Promise<void> {
  const markdown = normalizeRichMarkdown(row.message);
  const media = await resolveRichMessageImageMedia(database, markdown);

  await api.sendRichMessage(
    row.chat_id,
    {
      markdown,
      ...(media.length > 0 ? { media } : {}),
    },
    {
      ...(row.thread_id === null ? {} : { message_thread_id: row.thread_id }),
    },
  );
}

async function sendScheduledMessage(
  database: Database,
  api: TelegramApi,
  id: string,
): Promise<void> {
  const row = await getScheduledMessage(database, id);

  if (!row || row.status !== "scheduled") {
    stopScheduledMessageCron(id);
    return;
  }

  const claim = await database
    .updateTable("scheduled_messages")
    .set({ status: "sending" })
    .where("id", "=", id)
    .where("status", "=", "scheduled")
    .executeTakeFirst();

  if (Number(claim.numUpdatedRows) === 0) {
    stopScheduledMessageCron(id);
    return;
  }

  try {
    await sendScheduledRichMessage(database, api, row);
    await database
      .updateTable("scheduled_messages")
      .set({ status: "sent", sent_at: nowIso(), last_error: null })
      .where("id", "=", id)
      .where("status", "=", "sending")
      .execute();
    logDebug("Scheduled message sent", { id, chatId: row.chat_id });
  } catch (error) {
    await database
      .updateTable("scheduled_messages")
      .set({
        status: "failed",
        last_error: error instanceof Error ? error.message : String(error),
      })
      .where("id", "=", id)
      .where("status", "=", "sending")
      .execute();
    logError("Failed to send scheduled message", { id, error });
  } finally {
    stopScheduledMessageCron(id);
  }
}

function recurrenceFromRow(row: CronMessage): Recurrence {
  return { rrule: row.rrule, startsAt: row.starts_at, timezone: row.timezone };
}

/** Atomic reservation is persisted before Telegram I/O. Failures consume the
 * same cooldown as successful sends; a retry cannot bypass the minimum. */
export async function sendCronMessage(
  database: Database,
  api: TelegramApi,
  id: string,
): Promise<void> {
  const now = nowIso();
  const row = await database
    .updateTable("cron_messages")
    .set({
      status: "sending",
      next_allowed_at: new Date(Date.now() + MIN_RECURRENCE_MS).toISOString(),
    })
    .where("id", "=", id)
    .where("status", "=", "active")
    .where("next_run_at", "<=", now)
    .where((eb) =>
      eb.or([
        eb("next_allowed_at", "is", null),
        eb("next_allowed_at", "<=", now),
      ]),
    )
    .returning(cronMessageSelect)
    .executeTakeFirst();
  if (!row) {
    const current = await getCronMessage(database, id);
    if (current?.status === "active")
      await registerCronMessage(database, api, current);
    return;
  }
  let error: string | null = null;
  try {
    await sendScheduledRichMessage(database, api, row);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    logError("Failed to send recurring message", { id, error: cause });
  }
  const finished = Date.now();
  const nextAllowed = finished + MIN_RECURRENCE_MS;
  try {
    const [next] = await nextOccurrences(recurrenceFromRow(row), finished, 1);
    const updated = await database
      .updateTable("cron_messages")
      .set({
        status: next === undefined ? "completed" : "active",
        next_run_at: next === undefined ? null : new Date(next).toISOString(),
        next_allowed_at: new Date(nextAllowed).toISOString(),
        ...(!error ? { last_sent_at: new Date(finished).toISOString() } : {}),
        last_error: error,
      })
      .where("id", "=", id)
      .where("status", "=", "sending")
      .returning(cronMessageSelect)
      .executeTakeFirst();
    if (updated?.status === "active")
      await registerCronMessage(database, api, updated);
  } catch (cause) {
    await failCronMessage(database, id, cause);
  }
}

async function failCronMessage(
  database: Database,
  id: string,
  cause: unknown,
): Promise<void> {
  stopCronMessageCron(id);
  const error = cause instanceof Error ? cause.message : String(cause);
  await database
    .updateTable("cron_messages")
    .set({ status: "failed", last_error: error })
    .where("id", "=", id)
    .where("status", "in", ["active", "sending"])
    .execute();
  logError("Recurring reminder paused", { id, error });
}

function registerScheduledMessage(
  database: Database,
  api: TelegramApi,
  row: ScheduledMessage,
): void {
  stopScheduledMessageCron(row.id);

  const scheduledAt = parseScheduledAt(row.scheduled_at);

  if (scheduledAt.getTime() <= Date.now()) {
    void sendScheduledMessage(database, api, row.id);
    return;
  }

  const controller = startCron(
    getCronName("schedule_message", row.id),
    createOneTimeCronSchedule(scheduledAt),
    // Cron has no year field: a date more than a year out also matches every
    // earlier anniversary. Only send once the actual date has arrived.
    async () => {
      if (scheduledAt.getTime() - Date.now() > 60_000) return;
      await sendScheduledMessage(database, api, row.id);
    },
  );

  if (controller) {
    scheduledMessageControllers.set(row.id, controller);
  }
}

async function registerCronMessage(
  database: Database,
  api: TelegramApi,
  row: CronMessage,
): Promise<void> {
  stopCronMessageCron(row.id);
  if (row.status !== "active" || dispatcher?.database !== database) return;
  const generation = dispatcherGeneration;
  try {
    let next = row.next_run_at
      ? new Date(row.next_run_at).getTime()
      : undefined;
    const allowed = row.next_allowed_at
      ? new Date(row.next_allowed_at).getTime()
      : 0;
    if (next === undefined || next <= Date.now()) {
      [next] = await nextOccurrences(
        recurrenceFromRow(row),
        Math.max(Date.now(), allowed - 1),
        1,
      );
      const updated = await database
        .updateTable("cron_messages")
        .set({
          next_run_at: next === undefined ? null : new Date(next).toISOString(),
          status: next === undefined ? "completed" : "active",
        })
        .where("id", "=", row.id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!updated.numUpdatedRows || next === undefined) return;
    }
    const target = next === undefined ? undefined : Math.max(next, allowed);
    if (target === undefined) return;
    if (generation !== dispatcherGeneration) return;
    const timer = setTimeout(
      async () => {
        if (generation !== dispatcherGeneration) return;
        cronMessageControllers.delete(row.id);
        try {
          if (Date.now() < target) {
            const current = await getCronMessage(database, row.id);
            if (current) await registerCronMessage(database, api, current);
          } else {
            await sendCronMessage(database, api, row.id);
          }
        } catch (error) {
          await failCronMessage(database, row.id, error);
        }
      },
      Math.min(2_147_483_647, Math.max(1, target - Date.now())),
    );
    timer.unref();
    cronMessageControllers.set(row.id, timer);
  } catch (error) {
    await failCronMessage(database, row.id, error);
  }
}

/** Also used by tests and shutdown paths; timers never outlive their dispatcher. */
export function stopScheduleDispatcher(): void {
  dispatcherGeneration++;
  for (const id of scheduledMessageControllers.keys())
    stopScheduledMessageCron(id);
  for (const id of cronMessageControllers.keys()) stopCronMessageCron(id);
  dispatcher = undefined;
}

export async function startScheduleDispatcher(
  database: Database,
  api: TelegramApi,
): Promise<void> {
  stopScheduleDispatcher();
  dispatcher = { database, api };
  // An interrupted delivery may have reached Telegram. Wait five minutes from
  // recovery before another attempt, and skip the old occurrence.
  await database
    .updateTable("cron_messages")
    .set({
      status: "active",
      next_run_at: null,
      next_allowed_at: new Date(Date.now() + MIN_RECURRENCE_MS).toISOString(),
    })
    .where("status", "=", "sending")
    .execute();

  await database
    .updateTable("scheduled_messages")
    .set({ status: "scheduled" })
    .where("status", "=", "sending")
    .execute();

  const [scheduledMessages, cronMessages] = await Promise.all([
    listActiveScheduledMessages(database),
    listActiveCronMessages(database),
  ]);

  for (const row of scheduledMessages) {
    registerScheduledMessage(database, api, row);
  }

  for (const row of cronMessages) {
    await registerCronMessage(database, api, row);
  }

  logDebug("Schedule dispatcher started", {
    scheduledMessages: scheduledMessages.length,
    cronMessages: cronMessages.length,
  });
}

export async function createScheduledMessage(
  database: Database,
  input: CreateScheduledMessageInput,
): Promise<ScheduledMessage> {
  const message = normalizeMessage(input.message);
  const shortElaboration = normalizeShortElaboration(
    input.shortElaboration,
    message,
  );
  const scheduledAt = normalizeScheduledAt(input.at);
  const row: CreateScheduledMessage = {
    id: createId(),
    chat_id: normalizeChatId(input.chatId),
    thread_id: normalizeThreadId(input.threadId),
    message,
    short_elaboration: shortElaboration,
    scheduled_at: scheduledAt,
    created_at: nowIso(),
    status: "scheduled",
    sent_at: null,
    canceled_at: null,
    last_error: null,
  };

  const scheduledMessage = await database
    .transaction()
    .execute(async (transaction) => {
      if (
        (await countActiveScheduledMessages(transaction, input.chatId)) >=
        MAX_ACTIVE_SCHEDULED_MESSAGES_PER_CHAT
      ) {
        throw new ScheduleValidationError(
          `This chat already has ${MAX_ACTIVE_SCHEDULED_MESSAGES_PER_CHAT} scheduled messages.`,
        );
      }

      if (await getScheduledMessageAt(transaction, input.chatId, scheduledAt)) {
        throw new ScheduleValidationError(
          "This chat already has a scheduled message at that time.",
        );
      }

      try {
        await transaction
          .insertInto("scheduled_messages")
          .values(row)
          .execute();
      } catch (error) {
        if (isDuplicateScheduleError(error)) {
          throw new ScheduleValidationError(
            "This chat already has a scheduled message at that time.",
          );
        }

        throw error;
      }

      return row as ScheduledMessage;
    });

  const activeDispatcher = ensureDispatcher();
  if (activeDispatcher) {
    registerScheduledMessage(
      activeDispatcher.database,
      activeDispatcher.api,
      scheduledMessage,
    );
  }

  return scheduledMessage;
}

export async function createCronMessage(
  database: Database,
  input: CreateCronMessageInput,
): Promise<CronMessage> {
  const recurrence = normalizeRecurrence(input);
  const message = normalizeMessage(input.message);
  const shortElaboration = normalizeShortElaboration(
    input.shortElaboration,
    message,
  );
  const [next] = await nextOccurrences(recurrence, Date.now(), 1);
  if (next === undefined)
    throw new ScheduleValidationError(
      "This recurrence has no future occurrences.",
    );
  const row: CreateCronMessage = {
    id: createId(),
    chat_id: normalizeChatId(input.chatId),
    thread_id: normalizeThreadId(input.threadId),
    message,
    short_elaboration: shortElaboration,
    rrule: recurrence.rrule,
    starts_at: recurrence.startsAt,
    timezone: recurrence.timezone,
    next_run_at: new Date(next).toISOString(),
    next_allowed_at: null,
    created_at: nowIso(),
    status: "active",
    last_sent_at: null,
    canceled_at: null,
    last_error: null,
  };
  const cronMessage = await database
    .transaction()
    .execute(async (transaction) => {
      if (
        (await countActiveCronMessages(transaction, input.chatId)) >=
        MAX_ACTIVE_CRON_MESSAGES_PER_CHAT
      ) {
        throw new ScheduleValidationError(
          `This chat already has ${MAX_ACTIVE_CRON_MESSAGES_PER_CHAT} recurring reminders.`,
        );
      }
      return await transaction
        .insertInto("cron_messages")
        .values(row)
        .returning(cronMessageSelect)
        .executeTakeFirstOrThrow();
    });
  const activeDispatcher = ensureDispatcher();
  if (activeDispatcher)
    await registerCronMessage(
      activeDispatcher.database,
      activeDispatcher.api,
      cronMessage,
    );
  return cronMessage;
}

export async function cancelScheduledMessage(
  database: Database,
  chatId: number,
  id: string,
): Promise<CancelScheduleResult> {
  const row = await database
    .selectFrom("scheduled_messages")
    .select(scheduledMessageSelect)
    .where("id", "=", id)
    .where("chat_id", "=", normalizeChatId(chatId))
    .executeTakeFirst();

  if (!row) {
    return "not_found";
  }

  if (row.status !== "scheduled") {
    return "not_active";
  }

  await database
    .updateTable("scheduled_messages")
    .set({ status: "canceled", canceled_at: nowIso() })
    .where("id", "=", id)
    .where("chat_id", "=", normalizeChatId(chatId))
    .where("status", "=", "scheduled")
    .execute();

  stopScheduledMessageCron(id);
  return "canceled";
}

export async function cancelScheduledMessageByNumber(
  database: Database,
  chatId: number,
  number: number,
): Promise<CancelScheduleResult> {
  if (!Number.isInteger(number) || number < 1) {
    return "not_found";
  }

  const row = (await listActiveScheduledMessages(database, chatId))[number - 1];

  if (!row) {
    return "not_found";
  }

  return await cancelScheduledMessage(database, chatId, row.id);
}

export async function cancelCronMessage(
  database: Database,
  chatId: number,
  id: string,
): Promise<CancelScheduleResult> {
  const row = await database
    .selectFrom("cron_messages")
    .select(cronMessageSelect)
    .where("id", "=", id)
    .where("chat_id", "=", normalizeChatId(chatId))
    .executeTakeFirst();

  if (!row) {
    return "not_found";
  }

  if (!["active", "sending", "failed"].includes(row.status)) {
    return "not_active";
  }

  await database
    .updateTable("cron_messages")
    .set({ status: "canceled", canceled_at: nowIso() })
    .where("id", "=", id)
    .where("chat_id", "=", normalizeChatId(chatId))
    .where("status", "in", ["active", "sending", "failed"])
    .execute();

  stopCronMessageCron(id);
  return "canceled";
}

export async function cancelCronMessageByNumber(
  database: Database,
  chatId: number,
  number: number,
): Promise<CancelScheduleResult> {
  if (!Number.isInteger(number) || number < 1) {
    return "not_found";
  }

  const row = (await listActiveCronMessages(database, chatId))[number - 1];

  if (!row) {
    return "not_found";
  }

  return await cancelCronMessage(database, chatId, row.id);
}

export async function listActiveScheduledMessages(
  database: Database,
  chatId?: number,
): Promise<ScheduledMessage[]> {
  let query = database
    .selectFrom("scheduled_messages")
    .select(scheduledMessageSelect)
    .where("status", "=", "scheduled");

  if (chatId !== undefined) {
    query = query.where("chat_id", "=", normalizeChatId(chatId));
  }

  return await query
    .orderBy("scheduled_at", "asc")
    .orderBy("created_at", "asc")
    .execute();
}

export async function listActiveCronMessages(
  database: Database,
  chatId?: number,
): Promise<CronMessage[]> {
  let query = database
    .selectFrom("cron_messages")
    .select(cronMessageSelect)
    .where("status", "in", ["active", "sending", "failed"]);

  if (chatId !== undefined) {
    query = query.where("chat_id", "=", normalizeChatId(chatId));
  }

  return await query.orderBy("created_at", "asc").execute();
}

export function formatScheduledAt(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hours = padDatePart(date.getHours());
  const minutes = padDatePart(date.getMinutes());

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function formatCronInterval(
  row: Pick<CronMessage, "rrule" | "starts_at" | "timezone">,
): string {
  return describeRecurrence({
    rrule: row.rrule,
    startsAt: row.starts_at,
    timezone: row.timezone,
  });
}

function formatScheduleHeading(label: string, useCustomEmoji: boolean): string {
  const emoji = useCustomEmoji
    ? `<tg-emoji emoji-id="${SCHEDULE_EMOJI_ID}">${SCHEDULE_EMOJI_FALLBACK}</tg-emoji>`
    : SCHEDULE_EMOJI_FALLBACK;

  return `${emoji} ${label}`;
}

function formatScheduleLabel(
  row: Pick<ScheduledMessage | CronMessage, "short_elaboration">,
  fallback: string,
): string {
  const label =
    typeof row.short_elaboration === "string" && row.short_elaboration.trim()
      ? row.short_elaboration
      : fallback;

  return escapeHtml(label);
}

function formatScheduledMessageLine(
  row: ScheduledMessage,
  index: number,
): string {
  const number = index + 1;
  const label = formatScheduleLabel(row, "Scheduled message");

  return `${number}. ${label}\n${formatScheduledAt(row.scheduled_at)} /cancel_s${number}`;
}

function formatCronMessageLine(row: CronMessage, index: number): string {
  const number = index + 1;
  const label = formatScheduleLabel(row, "Repeating message");

  const description = escapeHtml(formatCronInterval(row));
  const next =
    row.next_run_at && row.status !== "failed"
      ? `\nNext: ${formatRecurrenceDate(new Date(row.next_run_at).getTime(), row.timezone)}`
      : "";
  const state =
    row.status === "failed"
      ? "\nPaused: recurrence could not be calculated."
      : "";
  return `${number}. ${label}\n${description}${next}${state} /cancel_c${number}`;
}

export function formatScheduleList(
  scheduledMessages: ScheduledMessage[],
  cronMessages: CronMessage[],
  useCustomEmoji = true,
): string {
  return [
    formatScheduleHeading("Scheduled", useCustomEmoji),
    scheduledMessages.length > 0
      ? scheduledMessages.map(formatScheduledMessageLine).join("\n")
      : "None.",
    "",
    formatScheduleHeading("Repeating", useCustomEmoji),
    cronMessages.length > 0
      ? cronMessages.map(formatCronMessageLine).join("\n\n")
      : "None.",
  ].join("\n");
}

export async function getScheduleList(
  database: Database,
  chatId: number,
  useCustomEmoji = true,
): Promise<string> {
  const [scheduledMessages, cronMessages] = await Promise.all([
    listActiveScheduledMessages(database, chatId),
    listActiveCronMessages(database, chatId),
  ]);

  return formatScheduleList(scheduledMessages, cronMessages, useCustomEmoji);
}

export async function replyWithSchedules(ctx: Context): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  // Rich recurrence descriptions can exceed a single Telegram message. Break
  // at lines/spaces, keeping complete HTML entities and emoji tags intact.
  let remaining = await getScheduleList(ctx.database, ctx.chat.id);
  while (remaining) {
    let end = remaining.length;
    if (end > 3500) {
      end = remaining.lastIndexOf("\n", 3500);
      if (end <= 0) end = remaining.lastIndexOf(" ", 3500);
      if (end <= 0) end = 3500;
    }
    const chunk = remaining.slice(0, end);
    remaining = remaining.slice(end).trimStart();
    try {
      await ctx.reply(chunk, { ...linkPreviewOptions, parse_mode: "HTML" });
    } catch {
      await ctx.reply(
        chunk.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/g, "$1"),
        {
          ...linkPreviewOptions,
          parse_mode: "HTML",
        },
      );
    }
  }
}

export async function replyWithCancelScheduledMessage(
  ctx: Context,
  id: string,
): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const result = await cancelScheduledMessage(ctx.database, ctx.chat.id, id);
  const response =
    result === "canceled"
      ? "Canceled scheduled message."
      : result === "not_active"
        ? "Scheduled message is not active."
        : "Scheduled message not found.";

  await ctx.reply(response);
}

export async function replyWithCancelScheduledMessageByNumber(
  ctx: Context,
  number: number,
): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const result = await cancelScheduledMessageByNumber(
    ctx.database,
    ctx.chat.id,
    number,
  );
  const response =
    result === "canceled"
      ? "Canceled scheduled message."
      : result === "not_active"
        ? "Scheduled message is not active."
        : "Scheduled message not found.";

  await ctx.reply(response);
}

export async function replyWithCancelCronMessage(
  ctx: Context,
  id: string,
): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const result = await cancelCronMessage(ctx.database, ctx.chat.id, id);
  const response =
    result === "canceled"
      ? "Canceled cron message."
      : result === "not_active"
        ? "Cron message is not active."
        : "Cron message not found.";

  await ctx.reply(response);
}

export async function replyWithCancelCronMessageByNumber(
  ctx: Context,
  number: number,
): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const result = await cancelCronMessageByNumber(
    ctx.database,
    ctx.chat.id,
    number,
  );
  const response =
    result === "canceled"
      ? "Canceled cron message."
      : result === "not_active"
        ? "Cron message is not active."
        : "Cron message not found.";

  await ctx.reply(response);
}
