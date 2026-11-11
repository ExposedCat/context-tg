import { test } from "bun:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import type { Api } from "grammy";
import { Kysely } from "kysely";
import type { Database, DatabaseSchema } from "../database.ts";
import { migrateImages, saveImageFileId } from "../images.ts";
import {
  listActiveCronMessages,
  listActiveScheduledMessages,
  migrateSchedules,
  sendScheduledRichMessage,
} from "../schedules.ts";
import { createSqliteDialect, openSqlite } from "../sqlite.ts";
import {
  executeCancelScheduledMessage,
  executeCronMessage,
  executeGetScheduledMessages,
} from "./schedule.ts";

const CHAT_ID = 42;
const TOOL_CONTEXT = { chatId: CHAT_ID, messageId: 1 };

async function createTestDatabase(): Promise<Database> {
  const database = new Kysely<DatabaseSchema>({
    dialect: createSqliteDialect(openSqlite(":memory:")),
  });

  await migrateSchedules(database);
  await migrateImages(database);
  return database;
}

test("scheduled messages resolve saved images through rich messages", async () => {
  const database = await createTestDatabase();
  const image = await saveImageFileId(database, "scheduled-photo");
  let request: unknown;
  const api = {
    sendRichMessage: (...args: unknown[]) => {
      request = args;
      return Promise.resolve({ message_id: 1 });
    },
  } as unknown as Api;

  try {
    await sendScheduledRichMessage(database, api, {
      chat_id: String(CHAT_ID),
      thread_id: 7,
      message: `Reminder\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![](tg://photo?id=${image.id})`,
    });

    deepStrictEqual(request, [
      String(CHAT_ID),
      {
        markdown: `Reminder\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![](tg://photo?id=${image.id})`,
        media: [
          {
            id: image.id,
            media: { type: "photo", media: "scheduled-photo" },
          },
        ],
      },
      { message_thread_id: 7 },
    ]);
  } finally {
    await database.destroy();
  }
});

async function seedSchedules(database: Database): Promise<void> {
  await database
    .insertInto("scheduled_messages")
    .values([
      {
        id: "scheduled-current-chat",
        chat_id: String(CHAT_ID),
        thread_id: null,
        message: "Standup time",
        short_elaboration: "Standup",
        scheduled_at: "2099-01-02T03:04:00.000",
        created_at: "2099-01-01T00:00:00.000Z",
      },
      {
        id: "scheduled-other-chat",
        chat_id: "99",
        thread_id: null,
        message: "Private reminder",
        short_elaboration: "Private reminder",
        scheduled_at: "2099-01-03T03:04:00.000",
        created_at: "2099-01-01T00:00:00.000Z",
      },
    ])
    .execute();

  await database
    .insertInto("cron_messages")
    .values({
      id: "cron-current-chat",
      chat_id: String(CHAT_ID),
      thread_id: null,
      message: "Drink some water",
      short_elaboration: "Hydrate",
      rrule: "FREQ=HOURLY;INTERVAL=2",
      starts_at: "2099-01-01 00:00",
      timezone: "UTC",
      created_at: "2099-01-01T00:00:00.000Z",
    })
    .execute();
}

test("get_scheduled_messages returns the current chat's /schedule list", async () => {
  const database = await createTestDatabase();

  try {
    await seedSchedules(database);

    const output = await executeGetScheduledMessages(null, TOOL_CONTEXT, {
      database,
    });

    strictEqual(
      output,
      [
        "⏰ Scheduled",
        "1. Standup",
        "2099-01-02 03:04 /cancel_s1",
        "",
        "⏰ Repeating",
        "1. Hydrate",
        "Every 2 hours at minute 00 (UTC) /cancel_c1",
      ].join("\n"),
    );
  } finally {
    await database.destroy();
  }
});

test("cancel_scheduled_message cancels by /schedule id and returns the updated schedule", async () => {
  const database = await createTestDatabase();

  try {
    await seedSchedules(database);

    const afterScheduledCancellation = await executeCancelScheduledMessage(
      { id: "s1" },
      TOOL_CONTEXT,
      { database },
    );

    strictEqual(
      afterScheduledCancellation,
      [
        "⏰ Scheduled",
        "None.",
        "",
        "⏰ Repeating",
        "1. Hydrate",
        "Every 2 hours at minute 00 (UTC) /cancel_c1",
      ].join("\n"),
    );
    deepStrictEqual(await listActiveScheduledMessages(database, CHAT_ID), []);

    const afterCronCancellation = await executeCancelScheduledMessage(
      { id: "c1" },
      TOOL_CONTEXT,
      { database },
    );

    strictEqual(
      afterCronCancellation,
      ["⏰ Scheduled", "None.", "", "⏰ Repeating", "None."].join("\n"),
    );
    deepStrictEqual(await listActiveCronMessages(database, CHAT_ID), []);

    strictEqual((await listActiveScheduledMessages(database, 99)).length, 1);
  } finally {
    await database.destroy();
  }
});

test("cancel_scheduled_message rejects an invalid cancellation id", async () => {
  const database = await createTestDatabase();

  try {
    strictEqual(
      await executeCancelScheduledMessage(
        { id: "scheduled-current-chat" },
        TOOL_CONTEXT,
        { database },
      ),
      JSON.stringify({
        error: "Cannot cancel scheduled message: id must look like s1 or c1.",
      }),
    );
  } finally {
    await database.destroy();
  }
});

test("cron_message creates an RRULE reminder scoped to the calling chat and topic", async () => {
  const database = await createTestDatabase();
  try {
    const rawOutput = await executeCronMessage(
      {
        message: "Time for your morning walk",
        short_elaboration: "Morning walk",
        rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
        starts_at: "2099-01-01 09:00",
        timezone: "Europe/Prague",
        chat_id: 99,
        thread_id: 99,
      },
      { ...TOOL_CONTEXT, threadId: 7 },
      { database },
    );
    if (typeof rawOutput !== "string") throw new Error("Expected JSON text");
    const output = JSON.parse(rawOutput);
    strictEqual(
      output.cron_message.recurrence,
      "Every weekday at 09:00 (Europe/Prague)",
    );
    strictEqual(typeof output.cron_message.next_run_at, "string");
    const [row] = await listActiveCronMessages(database, CHAT_ID);
    strictEqual(row.thread_id, 7);
    strictEqual((await listActiveCronMessages(database, 99)).length, 0);
    const invalidOutput = await executeCronMessage(
      {
        message: "Time for a walk",
        short_elaboration: "Walking",
        rrule: "FREQ=MINUTELY;INTERVAL=1",
        starts_at: "2099-01-01 09:00",
        timezone: "UTC",
      },
      TOOL_CONTEXT,
      { database },
    );
    if (typeof invalidOutput !== "string")
      throw new Error("Expected JSON text");
    const invalid = JSON.parse(invalidOutput);
    strictEqual(typeof invalid.error, "string");
    strictEqual((await listActiveCronMessages(database, CHAT_ID)).length, 1);
  } finally {
    await database.destroy();
  }
});
