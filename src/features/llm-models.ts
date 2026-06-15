import type { Database } from "./database.ts";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type ReasoningSetting = ReasoningEffort | null;
export type WebSearchSetting = "off" | "low" | "medium" | "high";
export type WebSearchContextSize = Exclude<WebSearchSetting, "off">;
export type LlmSettingsTable = {
  key: string;
  value: string | null;
};

type LlmSettingsDatabase = Database;
type LlmSettingKey = "reasoning" | "websearch";

let reasoningEffort: ReasoningSetting = "high";
let webSearchSetting: WebSearchSetting = "high";

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

export function parseReasoningSetting(
  value: string,
): ReasoningSetting | undefined {
  if (value === "null") {
    return null;
  }

  return isReasoningEffort(value) ? value : undefined;
}

export function isWebSearchSetting(value: string): value is WebSearchSetting {
  return (
    value === "off" || value === "low" || value === "medium" || value === "high"
  );
}

export function getReasoningEffort(): ReasoningSetting {
  return reasoningEffort;
}

export function setReasoningEffort(effort: ReasoningSetting): ReasoningSetting {
  reasoningEffort = effort;
  return reasoningEffort;
}

export async function persistReasoningEffort(
  database: LlmSettingsDatabase,
  effort: ReasoningSetting,
): Promise<ReasoningSetting> {
  await persistLlmSetting(database, "reasoning", effort);
  return setReasoningEffort(effort);
}

export function getWebSearchSetting(): WebSearchSetting {
  return webSearchSetting;
}

export function isWebSearchEnabled(): boolean {
  return webSearchSetting !== "off";
}

export function getWebSearchContextSize(): WebSearchContextSize {
  return webSearchSetting === "off" ? "low" : webSearchSetting;
}

export function setWebSearchSetting(
  setting: WebSearchSetting,
): WebSearchSetting {
  webSearchSetting = setting;
  return webSearchSetting;
}

export async function persistWebSearchSetting(
  database: LlmSettingsDatabase,
  setting: WebSearchSetting,
): Promise<WebSearchSetting> {
  await persistLlmSetting(database, "websearch", setting);
  return setWebSearchSetting(setting);
}

export async function migrateLlmSettings(database: LlmSettingsDatabase) {
  await database.schema
    .createTable("llm_settings")
    .ifNotExists()
    .addColumn("key", "text", (column) => column.primaryKey().notNull())
    .addColumn("value", "text")
    .execute();
}

export async function loadLlmSettings(database: LlmSettingsDatabase) {
  const rows = await database.selectFrom("llm_settings").selectAll().execute();

  for (const row of rows) {
    loadLlmSetting(row.key, row.value);
  }
}

async function persistLlmSetting(
  database: LlmSettingsDatabase,
  key: LlmSettingKey,
  value: string | null,
) {
  await database
    .insertInto("llm_settings")
    .values({ key, value })
    .onConflict((conflict) => conflict.column("key").doUpdateSet({ value }))
    .execute();
}

function loadLlmSetting(key: string, value: string | null) {
  switch (key) {
    case "reasoning":
      loadReasoningSetting(value);
      break;
    case "websearch":
      if (value && isWebSearchSetting(value)) {
        setWebSearchSetting(value);
      }
      break;
  }
}

function loadReasoningSetting(value: string | null) {
  if (value === null || isReasoningEffort(value)) {
    setReasoningEffort(value);
  }
}
