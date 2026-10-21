import { type Generated, sql } from "@kysely/kysely";
import type { TranslateFunction } from "grammy-i18n";
import type { Context } from "../bot.ts";
import type { Database } from "./database.ts";
import { TOKENS_PER_CREDIT } from "./text-tokens.ts";

export type ChatUsageLimitsTable = {
  chat_id: number;
  quota: number;
  unlimited: number;
};
export type ChatUsageTable = {
  chat_id: number;
  usage_date: string;
  used: number;
  text_tokens: Generated<number>;
};
export type TextCreditReservationsTable = {
  id: string;
  chat_id: number;
  usage_date: string;
  tokens: number;
  expires_at: string;
};
export type TextCreditReservation = {
  tokens: number;
  settle: (tokens: number) => Promise<void>;
};
export type TextCreditCharge = {
  reserve: (tokens: number) => Promise<TextCreditReservation>;
};
export class TextCreditLimitError extends Error {
  constructor() {
    super(
      "Your text credit allowance is exhausted. Try again after the daily reset.",
    );
    this.name = "TextCreditLimitError";
  }
}
export type UsageStatus = { used: number; quota: number; unlimited: boolean };
export type CreditKind = "request" | "tool" | "web_search" | "image_attempt";
export type CreditCharge = (kind: CreditKind, tool?: string) => Promise<void>;
export const CREDIT_PRICES = {
  request: 0,
  tool: 1,
  web_search: 1,
  image_attempt: 5,
} as const;

export async function migrateUsage(database: Database) {
  // New accounting starts fresh; legacy per-kind history stays untouched.
  await database.schema
    .createTable("credit_limits")
    .ifNotExists()
    .addColumn("chat_id", "integer", (c) => c.primaryKey())
    .addColumn("quota", "integer", (c) => c.notNull())
    .addColumn("unlimited", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
  await database.schema
    .createTable("credit_usage")
    .ifNotExists()
    .addColumn("chat_id", "integer", (c) => c.notNull())
    .addColumn("usage_date", "text", (c) => c.notNull())
    .addColumn("used", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("text_tokens", "integer", (c) => c.notNull().defaultTo(0))
    .addPrimaryKeyConstraint("credit_usage_pk", ["chat_id", "usage_date"])
    .execute();
  const tables = await database.introspection.getTables();
  if (
    !tables
      .find((table) => table.name === "credit_usage")
      ?.columns.some((column) => column.name === "text_tokens")
  ) {
    await database.schema
      .alterTable("credit_usage")
      .addColumn("text_tokens", "integer", (c) => c.notNull().defaultTo(0))
      .execute();
  }
  await database.schema
    .createTable("credit_text_reservations")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("chat_id", "integer", (c) => c.notNull())
    .addColumn("usage_date", "text", (c) => c.notNull())
    .addColumn("tokens", "integer", (c) => c.notNull())
    .addColumn("expires_at", "text", (c) => c.notNull())
    .execute();
  await database
    .deleteFrom("credit_text_reservations")
    .where("expires_at", "<=", sql<string>`datetime('now')`)
    .execute();
}
export function getUsageDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
export function defaultQuota(chatId: number): number {
  return chatId < 0 ? 50 : 20;
}
export async function getUsageStatus(
  database: Database,
  chatId: number,
  date = getUsageDate(),
): Promise<UsageStatus> {
  const [limit, usage] = await Promise.all([
    database
      .selectFrom("credit_limits")
      .selectAll()
      .where("chat_id", "=", chatId)
      .executeTakeFirst(),
    database
      .selectFrom("credit_usage")
      .selectAll()
      .where("chat_id", "=", chatId)
      .where("usage_date", "=", date)
      .executeTakeFirst(),
  ]);
  return {
    used: (usage?.used ?? 0) + (usage?.text_tokens ?? 0) / TOKENS_PER_CREDIT,
    quota: limit?.quota ?? defaultQuota(chatId),
    unlimited: limit?.unlimited === 1,
  };
}
export async function hasUsageRemaining(
  database: Database,
  chatId: number,
): Promise<boolean> {
  const rows = await sql<{
    remaining: number;
  }>`select ${availableTextTokens(chatId, getUsageDate())} as remaining`.execute(
    database,
  );
  return rows.rows[0].remaining > 0;
}

function availableTextTokens(chatId: number, date: string) {
  const n = TOKENS_PER_CREDIT;
  return sql<number>`cast(case when coalesce((select unlimited from credit_limits where chat_id = ${chatId}), 0) = 1
    then 9007199254740991 else
    coalesce((select quota from credit_limits where chat_id = ${chatId}), ${defaultQuota(chatId)}) * ${n}
    - coalesce((select used * ${n} + text_tokens from credit_usage where chat_id = ${chatId} and usage_date = ${date}), 0)
    - coalesce((select sum(tokens) from credit_text_reservations where chat_id = ${chatId} and usage_date = ${date} and expires_at > datetime('now')), 0) end as real)`;
}

export function createTextCreditCharge(
  ctx: Context,
  guest = false,
): TextCreditCharge {
  if (!ctx.chat) throw new Error("Credit usage requires a chat.");
  const chatId = ctx.chat.id;
  return {
    reserve: async (maxTokens) => {
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)
        throw new Error("Invalid token allowance.");
      const id = crypto.randomUUID();
      const date = getUsageDate();
      const remaining = availableTextTokens(chatId, date);
      const result = await sql<{
        tokens: number;
      }>`insert into credit_text_reservations (id, chat_id, usage_date, tokens, expires_at)
        select ${id}, ${chatId}, ${date}, min(${maxTokens}, ${remaining}), datetime('now', '+120 seconds')
        where ${remaining} > 0 returning tokens`.execute(ctx.database);
      const tokens = result.rows[0]?.tokens;
      if (!tokens) throw new TextCreditLimitError();
      let settlement: Promise<void> | undefined;
      return {
        tokens,
        settle: (used) => {
          if (settlement) return settlement;
          settlement = (async () => {
            if (!Number.isSafeInteger(used) || used < 0)
              throw new Error("Invalid token usage.");
            const charged = Math.min(tokens, used);
            if (charged > 0) {
              await sql`insert into credit_usage (chat_id, usage_date, used, text_tokens)
                values (${chatId}, ${date}, 0, ${charged})
                on conflict (chat_id, usage_date) do update set text_tokens = credit_usage.text_tokens + ${charged}`.execute(
                ctx.database,
              );
            }
            await ctx.database
              .deleteFrom("credit_text_reservations")
              .where("id", "=", id)
              .execute();
            if (charged > 0)
              ctx.telemetry.event("credit_usage", {
                credits: charged / TOKENS_PER_CREDIT,
                credit_kind: "text",
                usage_owner: chatId,
                usage_limit: (await getUsageStatus(ctx.database, chatId, date))
                  .unlimited
                  ? "unlimited"
                  : "limited",
                chat_type: ctx.chat?.type === "private" ? "private" : "group",
                mode: guest ? "guest" : "normal",
                tools: [],
              });
          })();
          return settlement;
        },
      };
    },
  };
}
export async function consumeUsage(
  database: Database,
  chatId: number,
  amount = 1,
) {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("Invalid credit amount.");
  const date = getUsageDate();
  // Conditional UPSERT keeps parallel tool calls from overspending the same balance.
  const remaining = availableTextTokens(chatId, date);
  const result = await sql<{
    used: number;
  }>`insert into credit_usage (chat_id, usage_date, used)
    select ${chatId}, ${date}, ${amount} where ${amount} * ${TOKENS_PER_CREDIT} <= ${remaining}
    on conflict (chat_id, usage_date) do update set used = credit_usage.used + ${amount}
    returning used`.execute(database);
  return {
    ...(await getUsageStatus(database, chatId, date)),
    ok: result.rows.length > 0,
  };
}
export function createCreditCharge(ctx: Context, guest = false): CreditCharge {
  if (!ctx.chat) throw new Error("Credit usage requires a chat.");
  const owner = ctx.chat.id;
  return async (kind, tool) => {
    const amount = CREDIT_PRICES[kind];
    if (amount === 0) {
      if (!(await hasUsageRemaining(ctx.database, owner)))
        throw new TextCreditLimitError();
      return;
    }
    const status = await consumeUsage(ctx.database, owner, amount);
    if (!status.ok)
      throw new Error(
        `Not enough credits: ${status.used}/${status.quota} used today.`,
      );
    ctx.telemetry.event("credit_usage", {
      credits: amount,
      credit_kind: kind,
      usage_owner: owner,
      usage_limit: status.unlimited ? "unlimited" : "limited",
      chat_type: ctx.chat?.type === "private" ? "private" : "group",
      mode: guest ? "guest" : "normal",
      tools: tool ? [tool] : [],
    });
  };
}
export function parseUsageCommand(
  text: string,
  botUsername: string,
): string | undefined {
  const match = text
    .trim()
    .match(/^\/usage(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (
    !match ||
    (match[1] && match[1].toLowerCase() !== botUsername.toLowerCase())
  ) {
    return undefined;
  }
  return match[2]?.trim() ?? "";
}

export function parseGuestUsageCommand(
  text: string,
  botUsername: string,
): string | undefined {
  const [mention, command, ...args] = text.trim().split(/\s+/);
  const normalizedUsername = botUsername.toLocaleLowerCase();

  if (mention?.toLocaleLowerCase() !== `@${normalizedUsername}`) {
    return undefined;
  }

  return parseUsageCommand([command, ...args].join(" "), botUsername);
}

export async function handleUsageCommand(
  database: Database,
  chatId: number,
  args: string,
  canSetQuota: boolean,
  translate: TranslateFunction,
): Promise<string> {
  const arg = args.trim().toLowerCase();
  if (arg) {
    if (!canSetQuota) return translate("settings-usage-admin-only");
    if (!/^[+-](?:[0-9]+|unlimited)$/.test(arg))
      return translate("settings-usage-usage");
    const current = await getUsageStatus(database, chatId);
    const isToggle = arg.endsWith("unlimited");
    const delta = isToggle ? 0 : Number(arg);
    const quota = Math.max(0, current.quota + delta);
    if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(quota))
      return translate("settings-usage-usage");
    await database
      .insertInto("credit_limits")
      .values({
        chat_id: chatId,
        quota,
        unlimited: isToggle
          ? Number(arg[0] === "+")
          : Number(current.unlimited),
      })
      .onConflict((c) =>
        c.column("chat_id").doUpdateSet((eb) => ({
          quota: isToggle
            ? eb.ref("credit_limits.quota")
            : sql<number>`max(0, credit_limits.quota + ${delta})`,
          unlimited: isToggle
            ? Number(arg[0] === "+")
            : eb.ref("credit_limits.unlimited"),
        })),
      )
      .execute();
  }
  const s = await getUsageStatus(database, chatId);
  return [
    translate("settings-usage-title", { date: getUsageDate() }),
    translate("settings-usage-line", {
      used: Number(s.used.toFixed(3)),
      quota: s.unlimited ? "∞" : s.quota,
    }),
    "",
    translate("settings-usage-prices", { tokens: TOKENS_PER_CREDIT }),
  ].join("\n");
}
