import { setSystemTime, test } from "bun:test";
import { deepStrictEqual, match, rejects, strictEqual } from "node:assert";
import type { Api } from "grammy";
import { Kysely, sql } from "kysely";
import type { Database, DatabaseSchema } from "./database.ts";
import { migrateImages } from "./images.ts";
import { MIN_RECURRENCE_MS, nextOccurrences } from "./recurrence.ts";
import {
  cancelCronMessage,
  createCronMessage,
  getScheduleList,
  listActiveCronMessages,
  migrateSchedules,
  sendCronMessage,
  startScheduleDispatcher,
  stopScheduleDispatcher,
} from "./schedules.ts";
import { createSqliteDialect, openSqlite } from "./sqlite.ts";

const NOW = Date.parse("2040-01-02T08:00:00Z");
async function fixture() {
  const database = new Kysely<DatabaseSchema>({
    dialect: createSqliteDialect(openSqlite(":memory:")),
  });
  await migrateSchedules(database);
  await migrateImages(database);
  return database;
}
const input = {
  chatId: 42,
  threadId: 7,
  message: "Drink a glass of water",
  shortElaboration: "Hydration",
  rrule: "FREQ=MINUTELY;INTERVAL=5",
  startsAt: "2040-01-02 08:00",
  timezone: "UTC",
};
async function due(database: Database) {
  const row = await createCronMessage(database, input);
  await database
    .updateTable("cron_messages")
    .set({ next_run_at: new Date(NOW).toISOString() })
    .where("id", "=", row.id)
    .execute();
  return row.id;
}

test("recurring creation stores RRULE, time zone, next occurrence and forum topic", async () => {
  setSystemTime(NOW);
  const database = await fixture();
  try {
    const row = await createCronMessage(database, {
      ...input,
      rrule: "FREQ=DAILY",
      startsAt: "2040-01-02 09:00",
      timezone: "Europe/Prague",
    });
    strictEqual(row.next_run_at, "2040-01-03T08:00:00.000Z");
    strictEqual(row.thread_id, 7);
    const list = await getScheduleList(database, 42, false);
    match(list, /Every day at 09:00 \(Europe\/Prague\)/);
    match(list, /Next: 3 Jan 2040, 09:00/);
    match(list, /\/cancel_c1/);
    await rejects(
      createCronMessage(database, {
        ...input,
        rrule: "FREQ=DAILY;COUNT=1",
        startsAt: "2000-01-01 09:00",
      }),
      /no future occurrences/,
    );
    await rejects(
      createCronMessage(database, {
        ...input,
        rrule: "FREQ=DAILY;BYMINUTE=0,1",
      }),
      /5 minutes/,
    );
  } finally {
    await database.destroy();
    setSystemTime();
  }
});

test("same-schedule reminders are allowed; the ten-per-chat cap and chat isolation remain", async () => {
  setSystemTime(NOW);
  const database = await fixture();
  try {
    for (let i = 0; i < 10; i++) await createCronMessage(database, input);
    await rejects(createCronMessage(database, input), /10 recurring reminders/);
    const other = await createCronMessage(database, { ...input, chatId: 99 });
    strictEqual(await cancelCronMessage(database, 42, other.id), "not_found");
    strictEqual((await listActiveCronMessages(database, 42)).length, 10);
    strictEqual((await listActiveCronMessages(database, 99)).length, 1);
  } finally {
    await database.destroy();
    setSystemTime();
  }
});

test("concurrent callbacks reserve one delivery; persisted cooldown blocks a forced early retry", async () => {
  setSystemTime(NOW);
  const database = await fixture();
  let sends = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = {
    sendRichMessage: async (
      _chat: unknown,
      _message: unknown,
      options: unknown,
    ) => {
      sends++;
      deepStrictEqual(options, { message_thread_id: 7 });
      await wait;
    },
  } as unknown as Api;
  try {
    const id = await due(database);
    const first = sendCronMessage(database, api, id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sendCronMessage(database, api, id);
    strictEqual(sends, 1);
    release();
    await first;
    let row = await database
      .selectFrom("cron_messages")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    strictEqual(row.next_allowed_at, "2040-01-02T08:05:00.000Z");
    strictEqual(row.next_run_at, "2040-01-02T08:05:00.000Z");
    await database
      .updateTable("cron_messages")
      .set({ next_run_at: new Date(NOW).toISOString() })
      .where("id", "=", id)
      .execute();
    setSystemTime(NOW + MIN_RECURRENCE_MS - 1);
    await sendCronMessage(database, api, id);
    strictEqual(sends, 1);
    setSystemTime(NOW + MIN_RECURRENCE_MS);
    await sendCronMessage(database, api, id);
    strictEqual(sends, 2);
    row = await database
      .selectFrom("cron_messages")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    strictEqual(row.next_run_at, "2040-01-02T08:10:00.000Z");
  } finally {
    release();
    stopScheduleDispatcher();
    await database.destroy();
    setSystemTime();
  }
});

test("failed deliveries consume the same cooldown and retain the error", async () => {
  setSystemTime(NOW);
  const database = await fixture();
  let sends = 0;
  const api = {
    sendRichMessage: async () => {
      sends++;
      throw new Error("Telegram unavailable");
    },
  } as unknown as Api;
  try {
    const id = await due(database);
    await sendCronMessage(database, api, id);
    const row = await database
      .selectFrom("cron_messages")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    strictEqual(row.last_error, "Telegram unavailable");
    strictEqual(row.last_sent_at, null);
    strictEqual(row.next_allowed_at, "2040-01-02T08:05:00.000Z");
    await sendCronMessage(database, api, id);
    strictEqual(sends, 1);
  } finally {
    stopScheduleDispatcher();
    await database.destroy();
    setSystemTime();
  }
});

test("five-minute cadence tolerates delivery latency without dropping every other occurrence", async () => {
  setSystemTime(NOW + 50);
  const database = await fixture();
  const api = {
    sendRichMessage: async () => {
      setSystemTime(NOW + 100);
    },
  } as unknown as Api;
  try {
    const id = await due(database);
    await sendCronMessage(database, api, id);
    const row = await database
      .selectFrom("cron_messages")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    strictEqual(row.next_run_at, "2040-01-02T08:05:00.000Z");
    strictEqual(row.next_allowed_at, "2040-01-02T08:05:00.100Z");
  } finally {
    stopScheduleDispatcher();
    await database.destroy();
    setSystemTime();
  }
});

test("cancelling an in-flight reminder prevents it from being revived after delivery", async () => {
  setSystemTime(NOW);
  const database = await fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = {
    sendRichMessage: async () => {
      await wait;
    },
  } as unknown as Api;
  try {
    const id = await due(database);
    const delivery = sendCronMessage(database, api, id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    strictEqual(await cancelCronMessage(database, 42, id), "canceled");
    release();
    await delivery;
    strictEqual((await listActiveCronMessages(database, 42)).length, 0);
    strictEqual(
      (
        await database
          .selectFrom("cron_messages")
          .select("status")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).status,
      "canceled",
    );
  } finally {
    release();
    stopScheduleDispatcher();
    await database.destroy();
    setSystemTime();
  }
});

test("restart skips downtime, restores cooldowns, and completes exhausted series", async () => {
  setSystemTime(NOW);
  const database = await fixture();
  let sends = 0;
  const api = {
    sendRichMessage: async () => {
      sends++;
    },
  } as unknown as Api;
  try {
    const overdue = await due(database);
    const interrupted = await due(database);
    const exhausted = await due(database);
    await database
      .updateTable("cron_messages")
      .set({ status: "sending" })
      .where("id", "=", interrupted)
      .execute();
    await database
      .updateTable("cron_messages")
      .set({ rrule: "FREQ=DAILY;COUNT=1", starts_at: "2000-01-01 09:00" })
      .where("id", "=", exhausted)
      .execute();
    await startScheduleDispatcher(database, api);
    strictEqual(sends, 0);
    const rows = await database
      .selectFrom("cron_messages")
      .selectAll()
      .execute();
    strictEqual(
      rows.find((r) => r.id === overdue)?.next_run_at,
      "2040-01-02T08:05:00.000Z",
    );
    const recovery = rows.find((r) => r.id === interrupted);
    strictEqual(recovery?.next_allowed_at, "2040-01-02T08:05:00.000Z");
    strictEqual(recovery?.next_run_at, "2040-01-02T08:05:00.000Z");
    strictEqual(rows.find((r) => r.id === exhausted)?.status, "completed");
  } finally {
    stopScheduleDispatcher();
    await database.destroy();
    setSystemTime();
  }
});

test("last occurrence completes a finite reminder", async () => {
  setSystemTime(NOW);
  const database = await fixture();
  const api = { sendRichMessage: async () => {} } as unknown as Api;
  try {
    const id = await due(database);
    await database
      .updateTable("cron_messages")
      .set({ rrule: "FREQ=DAILY;COUNT=1" })
      .where("id", "=", id)
      .execute();
    await sendCronMessage(database, api, id);
    strictEqual(
      (
        await database
          .selectFrom("cron_messages")
          .select("status")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).status,
      "completed",
    );
  } finally {
    stopScheduleDispatcher();
    await database.destroy();
    setSystemTime();
  }
});

test("the restored timer dispatches a due occurrence, then cancellation stops future delivery", async () => {
  setSystemTime(NOW);
  const database = await fixture();
  let sends = 0;
  const api = {
    sendRichMessage: async () => {
      sends++;
    },
  } as unknown as Api;
  try {
    const id = await due(database);
    await database
      .updateTable("cron_messages")
      .set({ next_run_at: new Date(NOW + 20).toISOString() })
      .where("id", "=", id)
      .execute();
    await startScheduleDispatcher(database, api);
    setSystemTime(NOW + 21);
    // Real timers keep running under setSystemTime; wait for the worker-backed
    // callback to finish before closing its database.
    for (let i = 0; i < 100; i++) {
      const row = await database
        .selectFrom("cron_messages")
        .select(["status", "last_sent_at"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      if (row.status === "active" && row.last_sent_at) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    strictEqual(sends, 1);
    strictEqual(await cancelCronMessage(database, 42, id), "canceled");
    setSystemTime(NOW + MIN_RECURRENCE_MS * 2);
    await sendCronMessage(database, api, id);
    strictEqual(sends, 1);
  } finally {
    stopScheduleDispatcher();
    await database.destroy();
    setSystemTime();
  }
});

test("legacy migration preserves IDs, topics, UTC cron timings, and cancellations, enforcing the new minimum", async () => {
  const database = new Kysely<DatabaseSchema>({
    dialect: createSqliteDialect(openSqlite(":memory:")),
  });
  try {
    await sql`CREATE TABLE cron_messages (id TEXT PRIMARY KEY, chat_id TEXT, thread_id INTEGER, message TEXT, short_elaboration TEXT, interval_unit TEXT, interval_value INTEGER, schedule_key TEXT, created_at TEXT, status TEXT, last_sent_at TEXT, canceled_at TEXT, last_error TEXT)`.execute(
      database,
    );
    for (const [id, unit, value] of [
      ["hours", "hour", 5],
      ["weekly", "dayOfWeek", 2],
      ["daily", "dayOfMonth", 3],
      ["months", "month", 2],
      ["fast", "minute", 1],
      ["wrap", "minute", 7],
    ] as const) {
      await sql`INSERT INTO cron_messages VALUES (${id}, '42', 7, 'Hello', 'Reminder', ${unit}, ${value}, ${id}, '2026-01-01T00:00:00.000Z', 'active', NULL, NULL, NULL)`.execute(
        database,
      );
    }
    await sql`UPDATE cron_messages SET status='canceled', canceled_at='2026-01-02T00:00:00Z' WHERE id='months'`.execute(
      database,
    );
    await migrateSchedules(database);
    await migrateSchedules(database); // safe on subsequent launches
    const rows = await database
      .selectFrom("cron_messages")
      .selectAll()
      .execute();
    strictEqual(rows.length, 6);
    strictEqual(rows.find((r) => r.id === "months")?.status, "canceled");
    const hours = rows.find((r) => r.id === "hours");
    strictEqual(hours?.thread_id, 7);
    strictEqual(hours?.timezone, "UTC");
    deepStrictEqual(
      (
        await nextOccurrences(
          {
            rrule: hours?.rrule ?? "",
            startsAt: hours?.starts_at ?? "",
            timezone: "UTC",
          },
          Date.parse("2026-11-11T19:00:00Z"),
          3,
        )
      ).map((date) => new Date(date).toISOString()),
      [
        "2026-11-11T20:00:00.000Z",
        "2026-11-12T00:00:00.000Z",
        "2026-11-12T05:00:00.000Z",
      ],
    );
    for (const id of ["fast", "wrap"]) {
      const row = rows.find((r) => r.id === id);
      match(row?.last_error ?? "", /five-minute minimum/);
      const occurrences = await nextOccurrences(
        {
          rrule: row?.rrule ?? "",
          startsAt: row?.starts_at ?? "",
          timezone: "UTC",
        },
        Date.parse("2026-11-11T00:50:00Z"),
        3,
      );
      for (let i = 1; i < occurrences.length; i++)
        strictEqual(
          occurrences[i] - occurrences[i - 1] >= MIN_RECURRENCE_MS,
          true,
        );
    }
  } finally {
    await database.destroy();
  }
});
