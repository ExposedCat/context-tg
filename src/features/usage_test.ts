import { test } from "bun:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import type { TranslateFunction } from "@grammyjs/i18n";
import { Kysely, sql } from "kysely";
import type { Context } from "../bot.ts";
import type { DatabaseSchema } from "./database.ts";
import { createSqliteDialect, openSqlite } from "./sqlite.ts";
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

Bun.env.ADMIN_ID = "1";

async function database() {
  const db = new Kysely<DatabaseSchema>({
    dialect: createSqliteDialect(openSqlite(":memory:")),
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

test("text credits accumulate exact fractions, release unused allowance, and block parallel overspending", async () => {
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

test("text reservations expire after a crashed attempt and unlimited credits still record text usage", async () => {
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

test("default (uncapped) reservations work for unlimited and finite chats with real chat ids", async () => {
  const db = await database();
  const chatId = -1001756869879;
  try {
    // Production streaming calls reserve() without an explicit cap.
    const finite = await textCharge(db, chatId).reserve();
    strictEqual(finite.tokens, 50 * TOKENS_PER_CREDIT);
    await finite.settle(10);

    await handleUsageCommand(db, chatId, "+unlimited", true, t);
    const unlimited = await textCharge(db, chatId).reserve();
    strictEqual(unlimited.tokens, Number.MAX_SAFE_INTEGER);
    strictEqual(
      (await db.selectFrom("credit_text_reservations").selectAll().execute())
        .length,
      0,
    );
    await unlimited.settle(1240);
    strictEqual(
      (await getUsageStatus(db, chatId)).used,
      1250 / TOKENS_PER_CREDIT,
    );
  } finally {
    await db.destroy();
  }
});

test("usage migration preserves existing credit charges and initializes text accounting once", async () => {
  const db = new Kysely<DatabaseSchema>({
    dialect: createSqliteDialect(openSqlite(":memory:")),
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

test("guest usage commands are parsed after the bot mention", () => {
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

test("guest usage commands must target the current bot exactly", () => {
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

test("credits have isolated daily group/user balances and atomic debits", async () => {
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

test("admin credit adjustments preserve spend and finite limits across unlimited toggles", async () => {
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

test("guest requests spend group credits and obey the group's usage adjustments", async () => {
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
    await charge("tool", "web_search");
    strictEqual(events[5].payload.usage_limit, "unlimited");
    strictEqual(events[5].payload.usage_owner, -1);
    strictEqual(events[5].name, "credit_usage");
    strictEqual(
      events.reduce((sum, e) => sum + Number(e.payload.credits), 0),
      15,
    );
  } finally {
    await db.destroy();
  }
});

test("each request costs one fixed credit plus one credit per 620 generated text tokens", async () => {
  const db = await database();
  try {
    strictEqual(TOKENS_PER_CREDIT, 620);
    for (const guest of [false, true]) {
      const chatId = guest ? -2 : -1;
      const ctx = {
        database: db,
        chat: { id: chatId, type: "supergroup" },
        telemetry: { event: () => {} },
      } as unknown as Context;
      const charge = createCreditCharge(ctx, guest);
      await charge("request");
      strictEqual((await getUsageStatus(db, chatId)).used, 1);
      const first = await createTextCreditCharge(ctx, guest).reserve(620);
      await first.settle(620);
      strictEqual((await getUsageStatus(db, chatId)).used, 2);
      await charge("request");
      const second = await createTextCreditCharge(ctx, guest).reserve(620);
      await second.settle(310);
      strictEqual((await getUsageStatus(db, chatId)).used, 3.5);
      await handleUsageCommand(db, chatId, "-46", true, t);
      await rejects(() => charge("request"));
      strictEqual((await getUsageStatus(db, chatId)).used, 3.5);
    }
  } finally {
    await db.destroy();
  }
});

test("ADMIN_ID has unlimited credits in every chat and guest mode without granting other users an exemption", async () => {
  const db = await database();
  try {
    for (const chatId of [10, -10]) {
      await handleUsageCommand(db, chatId, "-100", true, t);
      for (const guest of [false, true]) {
        const events: Record<string, unknown>[] = [];
        const ctx = {
          database: db,
          chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" },
          from: { id: 1 },
          telemetry: {
            event: (_name: string, payload: Record<string, unknown>) =>
              events.push(payload),
          },
        } as unknown as Context;
        strictEqual(await hasUsageRemaining(db, chatId, ctx.from?.id), true);
        const charge = createCreditCharge(ctx, guest);
        for (const kind of [
          "request",
          "tool",
          "web_search",
          "image_attempt",
        ] as const)
          await charge(kind);
        const meter = createTextCreditCharge(ctx, guest);
        const reservations = await Promise.all([
          meter.reserve(10000),
          meter.reserve(10000),
        ]);
        strictEqual(reservations[0].tokens, 10000);
        strictEqual(reservations[1].tokens, 10000);
        await Promise.all(
          reservations.map((reservation) => reservation.settle(10000)),
        );
        strictEqual(events.length, 6);
        for (const event of events) {
          strictEqual(event.usage_limit, "unlimited");
          strictEqual(event.mode, guest ? "guest" : "normal");
        }
        const regular = { ...ctx, from: { id: 2 } } as Context;
        strictEqual(await hasUsageRemaining(db, chatId, 2), false);
        strictEqual(await hasUsageRemaining(db, chatId), false);
        await rejects(() => createCreditCharge(regular, guest)("request"));
        await rejects(() => createCreditCharge(regular, guest)("tool"));
        await rejects(() => createTextCreditCharge(regular, guest).reserve(1));
        const status = await getUsageStatus(db, chatId);
        strictEqual(status.quota, 0);
        strictEqual(status.unlimited, false);
        strictEqual(status.used > 0, true);
      }
    }
  } finally {
    await db.destroy();
  }
});

test("reservations last as long as the request and are freed when the bot restarts", async () => {
  const db = await database();
  try {
    await handleUsageCommand(db, -1, "-49", true, t);
    await textCharge(db).reserve(TOKENS_PER_CREDIT);
    // A long-running request keeps holding its balance well past two minutes.
    const [row] = await db
      .selectFrom("credit_text_reservations")
      .select(sql<number>`julianday(expires_at) - julianday('now')`.as("days"))
      .execute();
    strictEqual(row.days > 0.99, true);
    strictEqual(await hasUsageRemaining(db, -1), false);
    // Startup migration: the previous process is gone, so its hold is too.
    await migrateUsage(db);
    strictEqual(await hasUsageRemaining(db, -1), true);
  } finally {
    await db.destroy();
  }
});
