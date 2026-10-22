import { test } from "bun:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import type { TranslateFunction } from "@grammyjs/i18n";
import { Kysely } from "kysely";
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

test("reported balances below 700 allow requests, tools, images and text with no reservations", async () => {
  const db = await database();
  const chatId = -1002027011507;
  const ctx = {
    database: db,
    chat: { id: chatId, type: "supergroup" },
    from: { id: 2 },
    telemetry: { event: () => {} },
  } as unknown as Context;
  try {
    await handleUsageCommand(db, chatId, "+650", true, t);
    for (const [used, textTokens] of [
      [100, 578],
      [110, 498],
    ]) {
      await db
        .insertInto("credit_usage")
        .values({
          chat_id: chatId,
          usage_date: getUsageDate(),
          used,
          text_tokens: textTokens,
        })
        .onConflict((c) =>
          c
            .columns(["chat_id", "usage_date"])
            .doUpdateSet({ used, text_tokens: textTokens }),
        )
        .execute();
      strictEqual(await hasUsageRemaining(db, chatId, 2), true);
      const charge = createCreditCharge(ctx);
      for (const kind of [
        "request",
        "tool",
        "web_search",
        "image_attempt",
      ] as const)
        await charge(kind);
      await createTextCreditCharge(ctx).charge(310);
      strictEqual(
        (await getUsageStatus(db, chatId)).used,
        used + 8 + (textTokens + 310) / TOKENS_PER_CREDIT,
      );
    }
  } finally {
    await db.destroy();
  }
});

test("credit comparisons use exact tokens at the quota boundary, independent of display rounding", async () => {
  const db = await database();
  const chatId = -1002027011507;
  try {
    await handleUsageCommand(db, chatId, "+650", true, t);
    for (const [textTokens, amount, expected] of [
      [619, 1, false], // 699.998... displays as 700.00 but still has one text token.
      [0, 1, true], // Exactly one credit left funds a request.
      [1, 1, false], // One token short of a request.
      [0, 2, false], // A request costing more than the balance must fail.
    ] as const) {
      await db
        .insertInto("credit_usage")
        .values({
          chat_id: chatId,
          usage_date: getUsageDate(),
          used: 699,
          text_tokens: textTokens,
        })
        .onConflict((c) =>
          c
            .columns(["chat_id", "usage_date"])
            .doUpdateSet({ used: 699, text_tokens: textTokens }),
        )
        .execute();
      strictEqual((await consumeUsage(db, chatId, amount)).ok, expected);
      strictEqual(
        (await getUsageStatus(db, chatId)).used,
        699 + Number(expected) * amount + textTokens / TOKENS_PER_CREDIT,
      );
    }
    await db
      .updateTable("credit_usage")
      .set({ used: 699, text_tokens: 619 })
      .where("chat_id", "=", chatId)
      .execute();
    strictEqual(await textCharge(db, chatId).charge(1), false);
    strictEqual(await hasUsageRemaining(db, chatId, 2), false);
    strictEqual((await consumeUsage(db, chatId)).ok, false);
  } finally {
    await db.destroy();
  }
});

test("usage displays always show two decimal places without rounding stored spend", async () => {
  const db = await database();
  const chatId = -1;
  try {
    for (const [used, textTokens, displayed] of [
      [0, 0, "0.00"],
      [110, 498, "110.80"],
      [100, 578, "100.93"],
      [7, 0, "7.00"],
      [0, 619, "1.00"],
    ] as const) {
      await db
        .insertInto("credit_usage")
        .values({
          chat_id: chatId,
          usage_date: getUsageDate(),
          used,
          text_tokens: textTokens,
        })
        .onConflict((c) =>
          c
            .columns(["chat_id", "usage_date"])
            .doUpdateSet({ used, text_tokens: textTokens }),
        )
        .execute();
      const output = await handleUsageCommand(db, chatId, "", false, t);
      strictEqual(
        output.includes(
          `settings-usage-line:${JSON.stringify({ used: displayed, quota: 50 })}`,
        ),
        true,
      );
      strictEqual(
        (await getUsageStatus(db, chatId)).used,
        used + textTokens / TOKENS_PER_CREDIT,
      );
    }
  } finally {
    await db.destroy();
  }
});

test("live text charges share a balance and parallel overshoot saturates at the quota", async () => {
  const db = await database();
  try {
    await handleUsageCommand(db, -1, "-49", true, t);
    const first = textCharge(db);
    const second = textCharge(db);
    strictEqual(await first.hasRemaining(), true);
    strictEqual(await second.hasRemaining(), true);
    await first.charge(100);
    strictEqual((await getUsageStatus(db, -1)).used, 100 / TOKENS_PER_CREDIT);
    strictEqual(await second.hasRemaining(), true);
    const results = await Promise.all([first.charge(400), second.charge(400)]);
    deepStrictEqual(results, [true, false]);
    strictEqual((await getUsageStatus(db, -1)).used, 1);
    strictEqual(await first.charge(10000), false);
    strictEqual(await second.charge(10000), false);
    strictEqual((await getUsageStatus(db, -1)).used, 1);
    strictEqual((await consumeUsage(db, -1)).ok, false);
    strictEqual((await getUsageStatus(db, 1)).used, 0);
    await rejects(() => first.charge(-1));
  } finally {
    await db.destroy();
  }
});

test("live text consumption emits only the debit applied below the cap", async () => {
  const db = await database();
  const events: number[] = [];
  try {
    await handleUsageCommand(db, -1, "-49", true, t);
    const charge = createTextCreditCharge({
      database: db,
      chat: { id: -1, type: "supergroup" },
      telemetry: {
        event: (_name: string, payload: { credits: number }) =>
          events.push(payload.credits),
      },
    } as unknown as Context);
    await charge.charge(100);
    await charge.charge(1000);
    await charge.charge(1000);
    strictEqual(events.length, 2);
    strictEqual(
      events.reduce((a, b) => a + b, 0),
      1,
    );
    strictEqual((await getUsageStatus(db, -1)).used, 1);
  } finally {
    await db.destroy();
  }
});

test("credit errors show the actual shortage to two decimal places", async () => {
  const db = await database();
  try {
    await handleUsageCommand(db, -1, "-49", true, t);
    const charge = createCreditCharge({
      database: db,
      chat: { id: -1, type: "supergroup" },
      telemetry: { event: () => {} },
    } as unknown as Context);
    await textCharge(db).charge(310);
    await rejects(() => charge("request"), /0\.50 available; 1\.00 required/);
    await textCharge(db).charge(1000);
    await rejects(
      () => charge("request"),
      /Daily credit limit reached \(1\.00\/1\)/,
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
    await textCharge(db).charge(TOKENS_PER_CREDIT);
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
      await createTextCreditCharge(ctx, guest).charge(620);
      strictEqual((await getUsageStatus(db, chatId)).used, 2);
      await charge("request");
      await createTextCreditCharge(ctx, guest).charge(310);
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
        await Promise.all([meter.charge(10000), meter.charge(10000)]);
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
        strictEqual(
          await createTextCreditCharge(regular, guest).hasRemaining(),
          false,
        );
        strictEqual(
          await createTextCreditCharge(regular, guest).charge(1),
          false,
        );
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

test("migration removes legacy reservations without changing usage", async () => {
  const db = await database();
  try {
    await consumeUsage(db, -1, 10);
    await db.schema
      .createTable("credit_text_reservations")
      .addColumn("tokens", "integer")
      .execute();
    await migrateUsage(db);
    strictEqual((await getUsageStatus(db, -1)).used, 10);
    strictEqual(await hasUsageRemaining(db, -1), true);
    strictEqual(
      (await db.introspection.getTables()).some(
        (table) => table.name === "credit_text_reservations",
      ),
      false,
    );
  } finally {
    await db.destroy();
  }
});
