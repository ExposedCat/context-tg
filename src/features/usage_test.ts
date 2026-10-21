import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { Database as SqliteDatabase } from "@db/sqlite";
import { Kysely } from "@kysely/kysely";
import { DenoSqlite3Dialect } from "@marshift/kysely-deno-sqlite3";
import type { TranslateFunction } from "grammy-i18n";
import type { Context } from "../bot.ts";
import type { DatabaseSchema } from "./database.ts";
import { TOKENS_PER_CREDIT } from "./text-tokens.ts";
import {
  consumeUsage,
  createCreditCharge,
  createTextCreditCharge,
  getUsageDate,
  getUsageStatus,
  handleUsageCommand,
  hasUsageRemaining,
  migrateUsage,
  parseGuestUsageCommand,
} from "./usage.ts";

async function database() {
  const db = new Kysely<DatabaseSchema>({
    dialect: new DenoSqlite3Dialect({
      database: new SqliteDatabase(":memory:"),
    }),
  });
  await migrateUsage(db);
  return db;
}
const t: TranslateFunction = (key, args) => `${key}:${JSON.stringify(args)}`;

function textCharge(db: Awaited<ReturnType<typeof database>>, chatId = -1) {
  return createTextCreditCharge({
    database: db,
    chat: { id: chatId, type: "supergroup" },
    telemetry: { event: () => {} },
  } as unknown as Context);
}

Deno.test("text credits accumulate exact fractions, release unused allowance, and block parallel overspending", async () => {
  const db = await database();
  try {
    await handleUsageCommand(db, -1, "-49", true, t);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        textCharge(db).reserve(TOKENS_PER_CREDIT),
      ),
    );
    const successful = outcomes.filter((item) => item.status === "fulfilled");
    strictEqual(successful.length, 1);
    strictEqual(await hasUsageRemaining(db, -1), false);
    strictEqual((await consumeUsage(db, -1, 1)).ok, false);
    const first = successful[0];
    if (first.status !== "fulfilled") throw new Error("Missing reservation");
    await first.value.settle(100);
    await first.value.settle(100); // Idempotent settlement cannot double-charge.
    strictEqual((await getUsageStatus(db, -1)).used, 100 / TOKENS_PER_CREDIT);
    const next = await textCharge(db).reserve(TOKENS_PER_CREDIT);
    strictEqual(next.tokens, TOKENS_PER_CREDIT - 100);
    await next.settle(next.tokens);
    strictEqual((await getUsageStatus(db, -1)).used, 1);
    strictEqual(await hasUsageRemaining(db, -1), false);
    await rejects(() => textCharge(db).reserve(1));
    strictEqual((await getUsageStatus(db, 1)).used, 0);
  } finally {
    await db.destroy();
  }
});

Deno.test("text reservations expire after a crashed attempt and unlimited credits still record text usage", async () => {
  const db = await database();
  try {
    await handleUsageCommand(db, -1, "-49", true, t);
    await textCharge(db).reserve(TOKENS_PER_CREDIT);
    strictEqual(await hasUsageRemaining(db, -1), false);
    await db
      .updateTable("credit_text_reservations")
      .set({ expires_at: "2000-01-01 00:00:00" })
      .execute();
    strictEqual(await hasUsageRemaining(db, -1), true);
    await handleUsageCommand(db, -1, "+unlimited", true, t);
    const reservation = await textCharge(db).reserve(10000);
    await reservation.settle(10000);
    strictEqual((await getUsageStatus(db, -1)).used, 10000 / TOKENS_PER_CREDIT);
    strictEqual(await hasUsageRemaining(db, -1), true);
  } finally {
    await db.destroy();
  }
});

Deno.test("usage migration preserves existing credit charges and initializes text accounting once", async () => {
  const db = new Kysely<DatabaseSchema>({
    dialect: new DenoSqlite3Dialect({
      database: new SqliteDatabase(":memory:"),
    }),
  });
  try {
    await db.schema
      .createTable("credit_usage")
      .addColumn("chat_id", "integer", (c) => c.notNull())
      .addColumn("usage_date", "text", (c) => c.notNull())
      .addColumn("used", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("credit_usage_pk", ["chat_id", "usage_date"])
      .execute();
    await db
      .insertInto("credit_usage")
      .values({ chat_id: -1, usage_date: getUsageDate(), used: 7 })
      .execute();
    await migrateUsage(db);
    strictEqual((await getUsageStatus(db, -1)).used, 7);
    const reservation = await textCharge(db).reserve(TOKENS_PER_CREDIT);
    await reservation.settle(TOKENS_PER_CREDIT);
    await migrateUsage(db);
    strictEqual((await getUsageStatus(db, -1)).used, 8);
  } finally {
    await db.destroy();
  }
});

Deno.test("guest usage commands are parsed after the bot mention", () => {
  strictEqual(parseGuestUsageCommand("@LayloBot /usage", "LayloBot"), "");
  strictEqual(
    parseGuestUsageCommand("  @laylobot   /usage +42  ", "LayloBot"),
    "+42",
  );
  strictEqual(
    parseGuestUsageCommand("@LayloBot /usage@LayloBot -3", "LayloBot"),
    "-3",
  );
});

Deno.test("guest usage commands must target the current bot exactly", () => {
  strictEqual(parseGuestUsageCommand("/usage +42", "LayloBot"), undefined);
  strictEqual(
    parseGuestUsageCommand("@OtherBot /usage +42", "LayloBot"),
    undefined,
  );
  strictEqual(
    parseGuestUsageCommand("@LayloBot /usage_report", "LayloBot"),
    undefined,
  );
});

Deno.test("credits have isolated daily group/user balances and atomic debits", async () => {
  const db = await database();
  try {
    deepStrictEqual(await getUsageStatus(db, -1), {
      used: 0,
      quota: 50,
      unlimited: false,
    });
    deepStrictEqual(await getUsageStatus(db, 1), {
      used: 0,
      quota: 20,
      unlimited: false,
    });
    const results = await Promise.all(
      Array.from({ length: 30 }, () => consumeUsage(db, 1)),
    );
    strictEqual(results.filter((r) => r.ok).length, 20);
    strictEqual((await getUsageStatus(db, 1)).used, 20);
    strictEqual(await hasUsageRemaining(db, 1), false);
    strictEqual((await getUsageStatus(db, -1)).used, 0);
    strictEqual((await getUsageStatus(db, 1, "2000-01-01")).used, 0);
    strictEqual(
      getUsageDate(new Date("2026-09-20T23:30:00-02:00")),
      "2026-09-21",
    );
    await rejects(() => consumeUsage(db, 1, -1));
  } finally {
    await db.destroy();
  }
});

Deno.test("admin credit adjustments preserve spend and finite limits across unlimited toggles", async () => {
  const db = await database();
  try {
    await consumeUsage(db, -1, 10);
    await handleUsageCommand(db, -1, "+10", false, t);
    strictEqual((await getUsageStatus(db, -1)).quota, 50);
    for (const invalid of [
      "20",
      "+1.5",
      "+NaN",
      "+1 extra",
      "+9007199254740992",
    ]) {
      await handleUsageCommand(db, -1, invalid, true, t);
    }
    strictEqual((await getUsageStatus(db, -1)).quota, 50);
    await handleUsageCommand(db, -1, "+10", true, t);
    await handleUsageCommand(db, -1, "-20", true, t);
    deepStrictEqual(await getUsageStatus(db, -1), {
      used: 10,
      quota: 40,
      unlimited: false,
    });
    await handleUsageCommand(db, -1, "+unlimited", true, t);
    strictEqual((await consumeUsage(db, -1, 100)).ok, true);
    await handleUsageCommand(db, -1, "-unlimited", true, t);
    deepStrictEqual(await getUsageStatus(db, -1), {
      used: 110,
      quota: 40,
      unlimited: false,
    });
    strictEqual(await hasUsageRemaining(db, -1), false);
    await handleUsageCommand(db, -1, "-100", true, t);
    strictEqual((await getUsageStatus(db, -1)).quota, 0);
  } finally {
    await db.destroy();
  }
});

Deno.test("guest requests spend group credits and obey the group's usage adjustments", async () => {
  const db = await database();
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    database: db,
    chat: { id: -1, type: "group" },
    from: { id: 2 },
    telemetry: {
      event: (name: string, payload: Record<string, unknown>) =>
        events.push({ name, payload }),
    },
  } as unknown as Context;
  try {
    const charge = createCreditCharge(ctx, true);
    await charge("request");
    await charge("tool", "generate_image");
    await charge("image_attempt", "generate_image");
    await charge("image_attempt", "generate_image");
    strictEqual((await getUsageStatus(db, -1)).used, 11);
    strictEqual((await getUsageStatus(db, 2)).used, 0);
    await handleUsageCommand(db, -1, "-50", true, t);
    await rejects(() => charge("tool", "web_search"));
    strictEqual(events.length, 3);
    await handleUsageCommand(db, -1, "+50", true, t);
    await charge("request");
    strictEqual((await getUsageStatus(db, -1)).used, 11);
    await handleUsageCommand(db, -1, "+unlimited", true, t);
    await charge("request");
    await charge("tool", "web_search");
    strictEqual(events[3].payload.usage_limit, "unlimited");
    strictEqual(events[3].payload.usage_owner, -1);
    strictEqual(events[3].name, "credit_usage");
    strictEqual(
      events.reduce((sum, e) => sum + Number(e.payload.credits), 0),
      12,
    );
  } finally {
    await db.destroy();
  }
});
