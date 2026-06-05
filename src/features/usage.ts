import type { Insertable, Selectable } from "@kysely/kysely";
import type { Context } from "../bot.ts";
import type { Database } from "./database.ts";

export type UsageKey = "text_responses" | "tool_usages" | "image_responses";

export type ChatUsageLimitsTable = {
  chat_id: number;
  key: UsageKey;
  quota: number;
};

export type ChatUsageTable = {
  chat_id: number;
  usage_date: string;
  key: UsageKey;
  used: number;
};

type ChatUsageLimit = Selectable<ChatUsageLimitsTable>;
type ChatUsage = Selectable<ChatUsageTable>;
type CreateChatUsageLimit = Insertable<ChatUsageLimitsTable>;
type CreateChatUsage = Insertable<ChatUsageTable>;

export type UsageStatus = {
  key: UsageKey;
  used: number;
  quota: number;
};

export type UsageConsumeResult = UsageStatus & {
  ok: boolean;
};

export const USAGE_KEYS = [
  "text_responses",
  "tool_usages",
  "image_responses",
] as const satisfies readonly UsageKey[];

export const DEFAULT_USAGE_LIMITS = {
  text_responses: 15,
  tool_usages: 20,
  image_responses: 3,
} as const satisfies Record<UsageKey, number>;

const USAGE_KEY_ALIASES: Record<string, UsageKey> = {
  text: "text_responses",
  texts: "text_responses",
  text_response: "text_responses",
  text_responses: "text_responses",
  tool: "tool_usages",
  tools: "tool_usages",
  tool_usage: "tool_usages",
  tool_usages: "tool_usages",
  image: "image_responses",
  images: "image_responses",
  image_response: "image_responses",
  image_responses: "image_responses",
} as const satisfies Record<string, UsageKey>;

export async function migrateUsage(database: Database) {
  await database.schema
    .createTable("chat_usage_limits")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("key", "text", (column) => column.notNull())
    .addColumn("quota", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("chat_usage_limits_primary_key", [
      "chat_id",
      "key",
    ])
    .execute();

  await database.schema
    .createTable("chat_usage")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("usage_date", "text", (column) => column.notNull())
    .addColumn("key", "text", (column) => column.notNull())
    .addColumn("used", "integer", (column) => column.notNull().defaultTo(0))
    .addPrimaryKeyConstraint("chat_usage_primary_key", [
      "chat_id",
      "usage_date",
      "key",
    ])
    .execute();
}

export function getUsageDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function parseUsageKey(value: string): UsageKey | undefined {
  return USAGE_KEY_ALIASES[value.toLocaleLowerCase()];
}

export async function getUsageSnapshot(
  database: Database,
  chatId: number,
  usageDate = getUsageDate(),
): Promise<UsageStatus[]> {
  const [limitRows, usageRows] = await Promise.all([
    database
      .selectFrom("chat_usage_limits")
      .selectAll()
      .where("chat_id", "=", chatId)
      .execute(),
    database
      .selectFrom("chat_usage")
      .selectAll()
      .where("chat_id", "=", chatId)
      .where("usage_date", "=", usageDate)
      .execute(),
  ]);
  const limits = new Map<UsageKey, ChatUsageLimit>(
    limitRows.map((row) => [row.key, row]),
  );
  const usage = new Map<UsageKey, ChatUsage>(
    usageRows.map((row) => [row.key, row]),
  );

  return USAGE_KEYS.map((key) => ({
    key,
    used: usage.get(key)?.used ?? 0,
    quota: limits.get(key)?.quota ?? DEFAULT_USAGE_LIMITS[key],
  }));
}

export async function getUsageStatus(
  database: Database,
  chatId: number,
  key: UsageKey,
  usageDate = getUsageDate(),
): Promise<UsageStatus> {
  const snapshot = await getUsageSnapshot(database, chatId, usageDate);
  const status = snapshot.find((item) => item.key === key);

  if (!status) {
    throw new Error(`Unknown usage key: ${key}`);
  }

  return status;
}

export async function hasUsageRemaining(
  database: Database,
  chatId: number,
  key: UsageKey,
): Promise<boolean> {
  const status = await getUsageStatus(database, chatId, key);
  return status.used < status.quota;
}

export async function consumeUsage(
  database: Database,
  chatId: number,
  key: UsageKey,
  amount = 1,
): Promise<UsageConsumeResult> {
  if (amount <= 0) {
    return { ...(await getUsageStatus(database, chatId, key)), ok: true };
  }

  const status = await getUsageStatus(database, chatId, key);

  if (status.used + amount > status.quota) {
    return { ...status, ok: false };
  }

  await recordUsage(database, chatId, key, amount);

  return { ...status, used: status.used + amount, ok: true };
}

export async function recordUsage(
  database: Database,
  chatId: number,
  key: UsageKey,
  amount = 1,
): Promise<void> {
  if (amount <= 0) {
    return;
  }

  const usageDate = getUsageDate();
  const row: CreateChatUsage = {
    chat_id: chatId,
    usage_date: usageDate,
    key,
    used: amount,
  };
  const current = await database
    .selectFrom("chat_usage")
    .select("used")
    .where("chat_id", "=", chatId)
    .where("usage_date", "=", usageDate)
    .where("key", "=", key)
    .executeTakeFirst();

  if (!current) {
    await database.insertInto("chat_usage").values(row).execute();
    return;
  }

  await database
    .updateTable("chat_usage")
    .set({ used: current.used + amount })
    .where("chat_id", "=", chatId)
    .where("usage_date", "=", usageDate)
    .where("key", "=", key)
    .execute();
}

export async function refundUsage(
  database: Database,
  chatId: number,
  key: UsageKey,
  amount = 1,
): Promise<void> {
  if (amount <= 0) {
    return;
  }

  const usageDate = getUsageDate();
  const current = await database
    .selectFrom("chat_usage")
    .select("used")
    .where("chat_id", "=", chatId)
    .where("usage_date", "=", usageDate)
    .where("key", "=", key)
    .executeTakeFirst();

  if (!current) {
    return;
  }

  await database
    .updateTable("chat_usage")
    .set({ used: Math.max(0, current.used - amount) })
    .where("chat_id", "=", chatId)
    .where("usage_date", "=", usageDate)
    .where("key", "=", key)
    .execute();
}

export async function setUsageQuota(
  database: Database,
  chatId: number,
  key: UsageKey,
  quota: number,
): Promise<UsageStatus> {
  const normalizedQuota = Math.trunc(quota);

  if (!Number.isFinite(normalizedQuota) || normalizedQuota < 0) {
    throw new Error("Quota must be a non-negative integer.");
  }

  const row: CreateChatUsageLimit = {
    chat_id: chatId,
    key,
    quota: normalizedQuota,
  };

  await database
    .insertInto("chat_usage_limits")
    .values(row)
    .onConflict((conflict) =>
      conflict.columns(["chat_id", "key"]).doUpdateSet({ quota: row.quota }),
    )
    .execute();

  return await getUsageStatus(database, chatId, key);
}

export function formatUsageSnapshot(
  snapshot: UsageStatus[],
  usageDate = getUsageDate(),
): string {
  return [
    `Usage for ${usageDate}`,
    ...snapshot.map((item) => `${item.key}: ${item.used}/${item.quota}`),
  ].join("\n");
}

export async function replyWithUsage(ctx: Context): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const usageDate = getUsageDate();
  const snapshot = await getUsageSnapshot(ctx.database, ctx.chat.id, usageDate);

  await ctx.reply(formatUsageSnapshot(snapshot, usageDate));
}
