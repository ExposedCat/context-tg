import { sql } from "@kysely/kysely";
import type { TranslateFunction } from "grammy-i18n";
import type { Context } from "../bot.ts";
import type { Database } from "./database.ts";

export type ChatUsageLimitsTable = {
  chat_id: number;
  quota: number;
  unlimited: number;
};
export type ChatUsageTable = {
  chat_id: number;
  usage_date: string;
  used: number;
};
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
    .addPrimaryKeyConstraint("credit_usage_pk", ["chat_id", "usage_date"])
    .execute();
}
export function getUsageDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
export function defaultQuota(chatId: number): number {
  return chatId < 0 ? 50 : 20;
}
export function getUsageOwner(
  chatId: number,
  guest: boolean,
  userId?: number,
): number {
  if (!guest || chatId > 0) return chatId;
  if (!userId) throw new Error("Guest usage requires a user ID.");
  return userId;
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
    used: usage?.used ?? 0,
    quota: limit?.quota ?? defaultQuota(chatId),
    unlimited: limit?.unlimited === 1,
  };
}
export async function hasUsageRemaining(
  database: Database,
  chatId: number,
): Promise<boolean> {
  const s = await getUsageStatus(database, chatId);
  return s.unlimited || s.used < s.quota;
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
  const limit = sql<number>`coalesce((select quota from credit_limits where chat_id = ${chatId}), ${defaultQuota(chatId)})`;
  const unlimited = sql<number>`coalesce((select unlimited from credit_limits where chat_id = ${chatId}), 0)`;
  const result = await sql<{
    used: number;
  }>`insert into credit_usage (chat_id, usage_date, used)
    select ${chatId}, ${date}, ${amount} where ${unlimited} = 1 or ${amount} <= ${limit}
    on conflict (chat_id, usage_date) do update set used = credit_usage.used + ${amount}
    where ${unlimited} = 1 or credit_usage.used + ${amount} <= ${limit}
    returning used`.execute(database);
  return {
    ...(await getUsageStatus(database, chatId, date)),
    ok: result.rows.length > 0,
  };
}
export function createCreditCharge(ctx: Context, guest = false): CreditCharge {
  if (!ctx.chat) throw new Error("Credit usage requires a chat.");
  const owner = getUsageOwner(ctx.chat.id, guest, ctx.from?.id);
  return async (kind, tool) => {
    const amount = CREDIT_PRICES[kind];
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
export function parseGuestUsageCommand(
  text: string,
  botUsername: string,
): string | undefined {
  const [mention, command, ...args] = text.trim().split(/\s+/);
  const normalizedUsername = botUsername.toLocaleLowerCase();

  if (mention?.toLocaleLowerCase() !== `@${normalizedUsername}`) {
    return undefined;
  }

  const normalizedCommand = command?.toLocaleLowerCase();
  if (
    normalizedCommand !== "/usage" &&
    normalizedCommand !== `/usage@${normalizedUsername}`
  ) {
    return undefined;
  }

  return args.join(" ");
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
      used: s.used,
      quota: s.unlimited ? "∞" : s.quota,
    }),
    "",
    translate("settings-usage-prices"),
  ].join("\n");
}
