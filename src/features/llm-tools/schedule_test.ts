import { deepStrictEqual, strictEqual } from "node:assert";
import { Database as SqliteDatabase } from "@db/sqlite";
import { Kysely } from "@kysely/kysely";
import { DenoSqlite3Dialect } from "@marshift/kysely-deno-sqlite3";
import type { Api } from "grammy";
import type { Database, DatabaseSchema } from "../database.ts";
import { migrateImages, saveImageFileId } from "../images.ts";
import {
  listActiveCronMessages,
  listActiveScheduledMessages,
  migrateSchedules,
  sendScheduledRichMessage,
} from "../schedules.ts";
import {
  executeCancelScheduledMessage,
  executeGetScheduledMessages,
} from "./schedule.ts";

const CHAT_ID = 42;
const TOOL_CONTEXT = { chatId: CHAT_ID, messageId: 1 };

async function createTestDatabase(): Promise<Database> {
  const sqlite = new SqliteDatabase(":memory:");
  const database = new Kysely<DatabaseSchema>({
    dialect: new DenoSqlite3Dialect({ database: sqlite }),
  });

  await migrateSchedules(database);
  await migrateImages(database);
  return database;
}

Deno.test("scheduled messages resolve saved images through rich messages", async () => {
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
      message: `Reminder\n\n![](tg://photo?id=${image.id})`,
    });

    deepStrictEqual(request, [
      String(CHAT_ID),
      {
        markdown: `Reminder\n\n![](tg://photo?id=${image.id})`,
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
      interval_unit: "hour",
      interval_value: 2,
      schedule_key: "hour:2",
      created_at: "2099-01-01T00:00:00.000Z",
    })
    .execute();
}

Deno.test("get_scheduled_messages returns the current chat's /schedule list", async () => {
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
        "Every 2h /cancel_c1",
      ].join("\n"),
    );
  } finally {
    await database.destroy();
  }
});

Deno.test("cancel_scheduled_message cancels by /schedule id and returns the updated schedule", async () => {
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
        "Every 2h /cancel_c1",
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

Deno.test("cancel_scheduled_message rejects an invalid cancellation id", async () => {
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
