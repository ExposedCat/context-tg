import { createDebug } from "@grammyjs/debug";
import {
  type ColumnType,
  type Insertable,
  type Selectable,
  sql,
} from "@kysely/kysely";
import type { Context } from "../bot.ts";
import { padDatePart } from "../utils/date.ts";
import { escapeHtml, normalizeWhitespace } from "../utils/text.ts";
import type { Database } from "./database.ts";
import { disabledLinkPreviewOptions as linkPreviewOptions } from "./telegram.ts";

export type ScheduledMessageStatus =
  | "scheduled"
  | "sending"
  | "sent"
  | "failed"
  | "canceled";
export type CronMessageStatus = "active" | "canceled";
export type CronIntervalUnit =
  | "dayOfMonth"
  | "dayOfWeek"
  | "hour"
  | "minute"
  | "month";

export type ScheduledMessagesTable = {
  id: string;
  chat_id: number;
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
  chat_id: number;
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
  interval_unit: CronIntervalUnit;
  interval_value: number;
  schedule_key: string;
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
type CronSchedule = Deno.CronSchedule;

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
  intervalUnit: CronIntervalUnit;
  intervalValue: number;
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
const scheduledMessageControllers = new Map<string, AbortController>();
const cronMessageControllers = new Map<string, AbortController>();

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
    .addColumn("chat_id", "integer", (column) => column.notNull())
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

  await database.schema
    .createTable("cron_messages")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey().notNull())
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("thread_id", "integer")
    .addColumn("message", "text", (column) => column.notNull())
    .addColumn("short_elaboration", "text")
    .addColumn("interval_unit", "text", (column) => column.notNull())
    .addColumn("interval_value", "integer", (column) => column.notNull())
    .addColumn("schedule_key", "text", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) =>
      column.notNull().defaultTo("active"),
    )
    .addColumn("last_sent_at", "text")
    .addColumn("canceled_at", "text")
    .addColumn("last_error", "text")
    .execute();

  try {
    await database.schema
      .alterTable("scheduled_messages")
      .addColumn("short_elaboration", "text")
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
  }

  try {
    await database.schema
      .alterTable("cron_messages")
      .addColumn("short_elaboration", "text")
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
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
    CREATE UNIQUE INDEX IF NOT EXISTS cron_messages_active_chat_schedule_index
    ON cron_messages(chat_id, schedule_key)
    WHERE status = 'active'
  `.execute(database);

  await sql`
    CREATE INDEX IF NOT EXISTS cron_messages_chat_status_created_index
    ON cron_messages(chat_id, status, created_at)
  `.execute(database);
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
  return {
    minute: date.getUTCMinutes(),
    hour: date.getUTCHours(),
    dayOfMonth: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
  };
}

function createCronSchedule(
  intervalUnit: CronIntervalUnit,
  intervalValue: number,
): CronSchedule {
  switch (intervalUnit) {
    case "minute":
      return { minute: { every: intervalValue } };
    case "hour":
      return { minute: 0, hour: { every: intervalValue } };
    case "dayOfWeek":
      return { minute: 0, hour: 0, dayOfWeek: { every: intervalValue } };
    case "dayOfMonth":
      return { minute: 0, hour: 0, dayOfMonth: { every: intervalValue } };
    case "month":
      return {
        minute: 0,
        hour: 0,
        dayOfMonth: 1,
        month: { every: intervalValue },
      };
  }
}

function validateCronInterval(
  intervalUnit: CronIntervalUnit,
  intervalValue: number,
): void {
  const value = Math.trunc(intervalValue);

  if (value !== intervalValue || !Number.isFinite(value)) {
    throw new ScheduleValidationError("Cron interval must be an integer.");
  }

  const ranges = {
    minute: [1, 59],
    hour: [1, 23],
    dayOfWeek: [1, 6],
    dayOfMonth: [1, 31],
    month: [1, 12],
  } as const satisfies Record<CronIntervalUnit, readonly [number, number]>;
  const [minimum, maximum] = ranges[intervalUnit];

  if (value < minimum || value > maximum) {
    throw new ScheduleValidationError(
      `${intervalUnit} interval must be between ${minimum} and ${maximum}.`,
    );
  }
}

function getScheduleKey(
  intervalUnit: CronIntervalUnit,
  intervalValue: number,
): string {
  return `${intervalUnit}:${intervalValue}`;
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
    .where("chat_id", "=", chatId)
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
    .where("chat_id", "=", chatId)
    .where("status", "=", "active")
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
    .selectAll()
    .where("chat_id", "=", chatId)
    .where("scheduled_at", "=", scheduledAt)
    .where("status", "in", ["scheduled", "sending"])
    .executeTakeFirst();
}

async function getCronMessageAt(
  database: Database,
  chatId: number,
  scheduleKey: string,
): Promise<CronMessage | undefined> {
  return await database
    .selectFrom("cron_messages")
    .selectAll()
    .where("chat_id", "=", chatId)
    .where("schedule_key", "=", scheduleKey)
    .where("status", "=", "active")
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

function startDenoCron(
  name: string,
  schedule: CronSchedule,
  handler: () => Promise<void>,
): AbortController | undefined {
  const controller = new AbortController();

  try {
    void Deno.cron(
      name,
      schedule,
      { signal: controller.signal },
      handler,
    ).catch((error) => {
      if (!controller.signal.aborted) {
        logError("Cron job failed", { name, error });
      }
    });
  } catch (error) {
    logError("Failed to register cron job", { name, schedule, error });
    return undefined;
  }

  return controller;
}

function stopScheduledMessageCron(id: string): void {
  scheduledMessageControllers.get(id)?.abort();
  scheduledMessageControllers.delete(id);
}

function stopCronMessageCron(id: string): void {
  cronMessageControllers.get(id)?.abort();
  cronMessageControllers.delete(id);
}

async function getScheduledMessage(
  database: Database,
  id: string,
): Promise<ScheduledMessage | undefined> {
  return await database
    .selectFrom("scheduled_messages")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
}

async function getCronMessage(
  database: Database,
  id: string,
): Promise<CronMessage | undefined> {
  return await database
    .selectFrom("cron_messages")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
}

async function sendTelegramMessage(
  api: TelegramApi,
  row: Pick<
    ScheduledMessage | CronMessage,
    "chat_id" | "message" | "thread_id"
  >,
): Promise<void> {
  await api.sendMessage(row.chat_id, row.message, {
    ...linkPreviewOptions,
    ...(row.thread_id === null ? {} : { message_thread_id: row.thread_id }),
  });
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
    await sendTelegramMessage(api, row);
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

async function sendCronMessage(
  database: Database,
  api: TelegramApi,
  id: string,
): Promise<void> {
  const row = await getCronMessage(database, id);

  if (!row || row.status !== "active") {
    stopCronMessageCron(id);
    return;
  }

  try {
    await sendTelegramMessage(api, row);
    await database
      .updateTable("cron_messages")
      .set({ last_sent_at: nowIso(), last_error: null })
      .where("id", "=", id)
      .where("status", "=", "active")
      .execute();
    logDebug("Cron message sent", { id, chatId: row.chat_id });
  } catch (error) {
    await database
      .updateTable("cron_messages")
      .set({
        last_error: error instanceof Error ? error.message : String(error),
      })
      .where("id", "=", id)
      .where("status", "=", "active")
      .execute();
    logError("Failed to send cron message", { id, error });
  }
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

  const controller = startDenoCron(
    getCronName("schedule_message", row.id),
    createOneTimeCronSchedule(scheduledAt),
    () => sendScheduledMessage(database, api, row.id),
  );

  if (controller) {
    scheduledMessageControllers.set(row.id, controller);
  }
}

function registerCronMessage(
  database: Database,
  api: TelegramApi,
  row: CronMessage,
): void {
  stopCronMessageCron(row.id);

  const controller = startDenoCron(
    getCronName("cron_message", row.id),
    createCronSchedule(row.interval_unit, row.interval_value),
    () => sendCronMessage(database, api, row.id),
  );

  if (controller) {
    cronMessageControllers.set(row.id, controller);
  }
}

export async function startScheduleDispatcher(
  database: Database,
  api: TelegramApi,
): Promise<void> {
  dispatcher = { database, api };

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
    registerCronMessage(database, api, row);
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
    chat_id: input.chatId,
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
  const intervalValue = Math.trunc(input.intervalValue);
  validateCronInterval(input.intervalUnit, input.intervalValue);

  const message = normalizeMessage(input.message);
  const shortElaboration = normalizeShortElaboration(
    input.shortElaboration,
    message,
  );
  const scheduleKey = getScheduleKey(input.intervalUnit, intervalValue);
  const row: CreateCronMessage = {
    id: createId(),
    chat_id: input.chatId,
    thread_id: normalizeThreadId(input.threadId),
    message,
    short_elaboration: shortElaboration,
    interval_unit: input.intervalUnit,
    interval_value: intervalValue,
    schedule_key: scheduleKey,
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
          `This chat already has ${MAX_ACTIVE_CRON_MESSAGES_PER_CHAT} cron messages.`,
        );
      }

      if (await getCronMessageAt(transaction, input.chatId, scheduleKey)) {
        throw new ScheduleValidationError(
          "This chat already has a cron message for that interval.",
        );
      }

      try {
        await transaction.insertInto("cron_messages").values(row).execute();
      } catch (error) {
        if (isDuplicateScheduleError(error)) {
          throw new ScheduleValidationError(
            "This chat already has a cron message for that interval.",
          );
        }

        throw error;
      }

      return row as CronMessage;
    });

  const activeDispatcher = ensureDispatcher();
  if (activeDispatcher) {
    registerCronMessage(
      activeDispatcher.database,
      activeDispatcher.api,
      cronMessage,
    );
  }

  return cronMessage;
}

export async function cancelScheduledMessage(
  database: Database,
  chatId: number,
  id: string,
): Promise<CancelScheduleResult> {
  const row = await database
    .selectFrom("scheduled_messages")
    .selectAll()
    .where("id", "=", id)
    .where("chat_id", "=", chatId)
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
    .where("chat_id", "=", chatId)
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
    .selectAll()
    .where("id", "=", id)
    .where("chat_id", "=", chatId)
    .executeTakeFirst();

  if (!row) {
    return "not_found";
  }

  if (row.status !== "active") {
    return "not_active";
  }

  await database
    .updateTable("cron_messages")
    .set({ status: "canceled", canceled_at: nowIso() })
    .where("id", "=", id)
    .where("chat_id", "=", chatId)
    .where("status", "=", "active")
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
    .selectAll()
    .where("status", "=", "scheduled");

  if (chatId !== undefined) {
    query = query.where("chat_id", "=", chatId);
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
    .selectAll()
    .where("status", "=", "active");

  if (chatId !== undefined) {
    query = query.where("chat_id", "=", chatId);
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
  row: Pick<CronMessage, "interval_unit" | "interval_value">,
): string {
  const unitLabels = {
    minute: "min",
    hour: "h",
    dayOfWeek: "w",
    dayOfMonth: "d",
    month: "mo",
  } as const satisfies Record<CronIntervalUnit, string>;

  return `Every ${row.interval_value}${unitLabels[row.interval_unit]}`;
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

  return `${number}. ${label}\n${formatCronInterval(row)} /cancel_c${number}`;
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
      ? cronMessages.map(formatCronMessageLine).join("\n")
      : "None.",
  ].join("\n");
}

export async function replyWithSchedules(ctx: Context): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const [scheduledMessages, cronMessages] = await Promise.all([
    listActiveScheduledMessages(ctx.database, ctx.chat.id),
    listActiveCronMessages(ctx.database, ctx.chat.id),
  ]);

  try {
    await ctx.reply(formatScheduleList(scheduledMessages, cronMessages), {
      ...linkPreviewOptions,
      parse_mode: "HTML",
    });
  } catch {
    await ctx.reply(
      formatScheduleList(scheduledMessages, cronMessages, false),
      {
        ...linkPreviewOptions,
        parse_mode: "HTML",
      },
    );
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
