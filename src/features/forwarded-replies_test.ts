import { test } from "bun:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { type Database, initDatabase } from "./database.ts";
import {
  isForwardedMessage,
  migrateForwardReplyCooldowns,
  withForwardReplyLimit,
} from "./forwarded-replies.ts";
import { createSqliteDialect, openSqlite } from "./sqlite.ts";

test("forward detection uses Telegram metadata, never ordinary text or reply parents", () => {
  for (const forward of [
    { forward_origin: { type: "channel" } },
    { forward_origin: { type: "hidden_user" } },
    { forward_from: { id: 1 } },
    { forward_from_chat: { id: -1 } },
    { forward_sender_name: "Hidden sender" },
    { forward_date: 100 },
  ])
    strictEqual(isForwardedMessage(forward), true);
  strictEqual(isForwardedMessage({}), false);
});

test("ten simultaneous forwards reserve at most one attempt, even when declined", async () => {
  const database = await initDatabase()();
  try {
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withForwardReplyLimit(
          database,
          -100,
          async () => {
            calls++;
          },
          () => 1000,
        ),
      ),
    );
    strictEqual(calls, 1);
    strictEqual(results.filter(Boolean).length, 1);
    strictEqual(
      await withForwardReplyLimit(
        database,
        -100,
        async () => {
          calls++;
        },
        () => 60_999,
      ),
      false,
    );
    strictEqual(
      await withForwardReplyLimit(
        database,
        -100,
        async () => {
          calls++;
        },
        () => 61_000,
      ),
      true,
    );
    strictEqual(calls, 2);
  } finally {
    await database.destroy();
  }
});

test("slow generations stay exclusive and start a fresh minute after completion", async () => {
  const database = await initDatabase()();
  let time = 1000;
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  try {
    const first = withForwardReplyLimit(
      database,
      -100,
      async () => {
        started.resolve();
        await finish.promise;
      },
      () => time,
    );
    await started.promise;
    time = 121_000;
    strictEqual(
      await withForwardReplyLimit(
        database,
        -100,
        async () => {},
        () => time,
      ),
      false,
    );
    // Other chats have independent limits; all topics/senders in one chat share it.
    strictEqual(
      await withForwardReplyLimit(
        database,
        -200,
        async () => {},
        () => time,
      ),
      true,
    );
    finish.resolve();
    strictEqual(await first, true);
    time = 180_999;
    strictEqual(
      await withForwardReplyLimit(
        database,
        -100,
        async () => {},
        () => time,
      ),
      false,
    );
    time = 181_000;
    strictEqual(
      await withForwardReplyLimit(
        database,
        -100,
        async () => {},
        () => time,
      ),
      true,
    );
  } finally {
    finish.resolve();
    await database.destroy();
  }
});

test("failed forwards retain their cooldown without queuing a replacement", async () => {
  const database = await initDatabase()();
  try {
    await rejects(
      () =>
        withForwardReplyLimit(
          database,
          -100,
          async () => {
            throw new Error("routing failed");
          },
          () => 1000,
        ),
      /routing failed/,
    );
    strictEqual(
      await withForwardReplyLimit(
        database,
        -100,
        async () => {},
        () => 2000,
      ),
      false,
    );
    strictEqual(
      await withForwardReplyLimit(
        database,
        -100,
        async () => {},
        () => 61_000,
      ),
      true,
    );
  } finally {
    await database.destroy();
  }
});

test("forward cooldowns survive closing and reopening SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-forward-cooldown-"));
  const path = join(directory, "test.sqlite");
  const connect = (): Database =>
    new Kysely({ dialect: createSqliteDialect(openSqlite(path)) });
  let database = connect();
  try {
    await migrateForwardReplyCooldowns(database);
    strictEqual(
      await withForwardReplyLimit(
        database,
        -100,
        async () => {},
        () => 1000,
      ),
      true,
    );
    await database.destroy();
    database = connect();
    await migrateForwardReplyCooldowns(database);
    strictEqual(
      await withForwardReplyLimit(
        database,
        -100,
        async () => {},
        () => 60_999,
      ),
      false,
    );
    deepStrictEqual(
      await database
        .selectFrom("forward_reply_cooldowns")
        .selectAll()
        .execute(),
      [{ chat_id: -100, next_allowed_at: 61_000 }],
    );
  } finally {
    await database.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
