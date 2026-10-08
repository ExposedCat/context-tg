import type { Database } from "./database.ts";

export type UserSettingsTable = {
  user_id: number;
  finance_mcp_enabled: number;
};

export async function migrateUserSettings(database: Database): Promise<void> {
  await database.schema
    .createTable("user_settings")
    .ifNotExists()
    .addColumn("user_id", "integer", (column) => column.primaryKey())
    .addColumn("finance_mcp_enabled", "integer", (column) =>
      column.notNull().defaultTo(0),
    )
    .execute();
}

export async function getFinanceMcpEnabled(
  database: Database,
  userId: number,
): Promise<boolean> {
  const row = await database
    .selectFrom("user_settings")
    .select("finance_mcp_enabled")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.finance_mcp_enabled === 1;
}

export async function setFinanceMcpEnabled(
  database: Database,
  userId: number,
  enabled: boolean,
): Promise<void> {
  await database
    .insertInto("user_settings")
    .values({ user_id: userId, finance_mcp_enabled: enabled ? 1 : 0 })
    .onConflict((conflict) =>
      conflict
        .column("user_id")
        .doUpdateSet({ finance_mcp_enabled: enabled ? 1 : 0 }),
    )
    .execute();
}
