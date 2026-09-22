import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { Database as SqliteDatabase } from "@db/sqlite";
import { Kysely } from "@kysely/kysely";
import { DenoSqlite3Dialect } from "@marshift/kysely-deno-sqlite3";
import type { TranslateFunction } from "grammy-i18n";
import type { Context } from "../bot.ts";
import type { DatabaseSchema } from "./database.ts";
import {
  consumeUsage,
  createCreditCharge,
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
    strictEqual((await getUsageStatus(db, -1)).used, 12);
    strictEqual((await getUsageStatus(db, 2)).used, 0);
    await handleUsageCommand(db, -1, "-50", true, t);
    await rejects(() => charge("tool", "web_search"));
    strictEqual(events.length, 4);
    await handleUsageCommand(db, -1, "+50", true, t);
    await charge("request");
    strictEqual((await getUsageStatus(db, -1)).used, 13);
    await handleUsageCommand(db, -1, "+unlimited", true, t);
    await charge("request");
    strictEqual(events[5].payload.usage_limit, "unlimited");
    strictEqual(events[5].payload.usage_owner, -1);
    strictEqual(events[5].name, "credit_usage");
    strictEqual(
      events.reduce((sum, e) => sum + Number(e.payload.credits), 0),
      14,
    );
  } finally {
    await db.destroy();
  }
});
