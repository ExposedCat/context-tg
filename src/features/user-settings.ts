import type { Generated } from "kysely";
import type { Database } from "./database.ts";

export type UserSettingsTable = {
  user_id: number;
  finance_mcp_enabled: number;
  calendar_mcp_enabled: Generated<number>;
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
  const columns = await database.introspection.getTables();
  if (
    !columns
      .find((table) => table.name === "user_settings")
      ?.columns.some((column) => column.name === "calendar_mcp_enabled")
  )
    await database.schema
      .alterTable("user_settings")
      .addColumn("calendar_mcp_enabled", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .execute();
}

export async function getCalendarMcpEnabled(
  database: Database,
  userId: number,
): Promise<boolean> {
  const row = await database
    .selectFrom("user_settings")
    .select("calendar_mcp_enabled")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.calendar_mcp_enabled === 1;
}

export async function setCalendarMcpEnabled(
  database: Database,
  userId: number,
  enabled: boolean,
): Promise<void> {
  await database
    .insertInto("user_settings")
    .values({
      user_id: userId,
      finance_mcp_enabled: 0,
      calendar_mcp_enabled: enabled ? 1 : 0,
    })
    .onConflict((conflict) =>
      conflict
        .column("user_id")
        .doUpdateSet({ calendar_mcp_enabled: enabled ? 1 : 0 }),
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
