import type { TranslateFunction } from "@grammyjs/i18n";
import { type Generated, sql } from "kysely";
import type { Context } from "../bot.ts";
import { isBotAdmin, isBotAdminId } from "./authorization.ts";
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
export type TextCreditCharge = {
  charge: (tokens: number) => Promise<boolean>;
  hasRemaining: () => Promise<boolean>;
};
export class CreditLimitError extends Error {
  constructor(status: UsageStatus, amount: number) {
    super(
      status.used >= status.quota
        ? `Daily credit limit reached (${status.used.toFixed(2)}/${status.quota}). Resets at 00:00 UTC.`
        : `Not enough credits for this action: ${Math.max(0, status.quota - status.used).toFixed(2)} available; ${amount.toFixed(2)} required. Resets at 00:00 UTC.`,
    );
    this.name = "CreditLimitError";
  }
}
export type UsageStatus = { used: number; quota: number; unlimited: boolean };
export type CreditKind = "request" | "tool" | "web_search" | "image_attempt";
export type CreditCharge = (kind: CreditKind, tool?: string) => Promise<void>;
export const CREDIT_PRICES = {
  request: 1,
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
  // Reservations are obsolete. Drop legacy holds without changing balances.
  await database.schema
    .dropTable("credit_text_reservations")
    .ifExists()
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
  userId?: number,
): Promise<boolean> {
  if (isBotAdminId(userId)) return true;
  const status = await getUsageStatus(database, chatId);
  return status.unlimited || status.used < status.quota;
}

function availableTextTokens(chatId: number, date: string, unlimited = false) {
  if (unlimited) return sql<number>`cast(9007199254740991 as real)`;
  const n = TOKENS_PER_CREDIT;
  return sql<number>`cast(case when coalesce((select unlimited from credit_limits where chat_id = ${chatId}), 0) = 1
    then 9007199254740991 else
    coalesce((select quota from credit_limits where chat_id = ${chatId}), ${defaultQuota(chatId)}) * ${n}
    - coalesce((select used * ${n} + text_tokens from credit_usage where chat_id = ${chatId} and usage_date = ${date}), 0) end as real)`;
}

export function createTextCreditCharge(
  ctx: Context,
  guest = false,
): TextCreditCharge {
  if (!ctx.chat) throw new Error("Credit usage requires a chat.");
  const chatId = ctx.chat.id;
  const unlimited = isBotAdmin(ctx);
  return {
    hasRemaining: () => hasUsageRemaining(ctx.database, chatId, ctx.from?.id),
    charge: async (tokens) => {
      if (!Number.isSafeInteger(tokens) || tokens < 0)
        throw new Error("Invalid token usage.");
      // Serialize the read and debit so parallel batches share one balance.
      // Only real output is charged; excess output and final wrap-ups are free
      // once a finite balance reaches its quota.
      const result = await ctx.database.transaction().execute(async (db) => {
        const date = getUsageDate();
        const status = await getUsageStatus(db, chatId, date);
        const exempt = unlimited || status.unlimited;
        const balance = await sql<{
          remaining: number;
        }>`select ${availableTextTokens(chatId, date, unlimited)} as remaining`.execute(
          db,
        );
        const remaining = balance.rows[0].remaining;
        const charged = exempt
          ? tokens
          : Math.min(tokens, Math.max(0, remaining));
        if (charged > 0) {
          await sql`insert into credit_usage (chat_id, usage_date, used, text_tokens)
            values (${chatId}, ${date}, 0, ${charged})
            on conflict (chat_id, usage_date) do update set text_tokens = credit_usage.text_tokens + ${charged}`.execute(
            db,
          );
        }
        return {
          charged,
          exempt,
          remaining: exempt || remaining > charged,
        };
      });
      if (result.charged > 0)
        ctx.telemetry.event("credit_usage", {
          credits: result.charged / TOKENS_PER_CREDIT,
          credit_kind: "text",
          usage_owner: chatId,
          usage_limit: result.exempt ? "unlimited" : "limited",
          chat_type: ctx.chat?.type === "private" ? "private" : "group",
          mode: guest ? "guest" : "normal",
          tools: [],
        });
      return result.remaining;
    },
  };
}
export async function consumeUsage(
  database: Database,
  chatId: number,
  amount = 1,
  unlimited = false,
) {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("Invalid credit amount.");
  const date = getUsageDate();
  // The exemption belongs to this request; it never changes the chat limit.
  // Conditional UPSERT keeps ordinary parallel calls within the same balance.
  const remaining = availableTextTokens(chatId, date, unlimited);
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
  const unlimited = isBotAdmin(ctx);
  return async (kind, tool) => {
    const amount = CREDIT_PRICES[kind];
    const status = await consumeUsage(ctx.database, owner, amount, unlimited);
    if (!status.ok) throw new CreditLimitError(status, amount);
    ctx.telemetry.event("credit_usage", {
      credits: amount,
      credit_kind: kind,
      usage_owner: owner,
      usage_limit: unlimited || status.unlimited ? "unlimited" : "limited",
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
      used: s.used.toFixed(2),
      quota: s.unlimited ? "∞" : s.quota,
    }),
    "",
    translate("settings-usage-prices", { tokens: TOKENS_PER_CREDIT }),
  ].join("\n");
}
