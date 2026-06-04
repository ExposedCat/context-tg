import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";

export type LlmModelTier = "small" | "big";
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
type LlmSettingKey =
  | "model.small"
  | "model.big"
  | "reasoning.small"
  | "reasoning.big"
  | "websearch";

const MODEL_NAMES: Record<LlmModelTier, string> = {
  small: APP_ENV.LLM_MODEL_SMALL,
  big: APP_ENV.LLM_MODEL,
};

const REASONING_EFFORTS: Record<LlmModelTier, ReasoningSetting> = {
  small: "high",
  big: "high",
};

let webSearchSetting: WebSearchSetting = "high";

const MODEL_SETTING_KEYS: Record<LlmModelTier, LlmSettingKey> = {
  small: "model.small",
  big: "model.big",
};

const REASONING_SETTING_KEYS: Record<LlmModelTier, LlmSettingKey> = {
  small: "reasoning.small",
  big: "reasoning.big",
};

export function isLlmModelTier(value: string): value is LlmModelTier {
  return value === "small" || value === "big";
}

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

export function getLlmModelName(tier: LlmModelTier): string {
  return MODEL_NAMES[tier];
}

export function getLlmModelNames(): Readonly<Record<LlmModelTier, string>> {
  return MODEL_NAMES;
}

export function setLlmModelName(tier: LlmModelTier, name: string): string {
  const modelName = name.trim();

  if (!modelName) {
    throw new Error("Model name must not be empty");
  }

  MODEL_NAMES[tier] = modelName;
  return modelName;
}

export async function persistLlmModelName(
  database: LlmSettingsDatabase,
  tier: LlmModelTier,
  name: string,
): Promise<string> {
  const modelName = name.trim();

  if (!modelName) {
    throw new Error("Model name must not be empty");
  }

  await persistLlmSetting(database, MODEL_SETTING_KEYS[tier], modelName);
  return setLlmModelName(tier, modelName);
}

export function getReasoningEffort(tier: LlmModelTier): ReasoningSetting {
  return REASONING_EFFORTS[tier];
}

export function getReasoningEfforts(): Readonly<
  Record<LlmModelTier, ReasoningSetting>
> {
  return REASONING_EFFORTS;
}

export function setReasoningEffort(
  tier: LlmModelTier,
  effort: ReasoningSetting,
): ReasoningSetting {
  REASONING_EFFORTS[tier] = effort;
  return REASONING_EFFORTS[tier];
}

export async function persistReasoningEffort(
  database: LlmSettingsDatabase,
  tier: LlmModelTier,
  effort: ReasoningSetting,
): Promise<ReasoningSetting> {
  await persistLlmSetting(database, REASONING_SETTING_KEYS[tier], effort);
  return setReasoningEffort(tier, effort);
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
    case "model.small":
      if (value) {
        setLlmModelName("small", value);
      }
      break;
    case "model.big":
      if (value) {
        setLlmModelName("big", value);
      }
      break;
    case "reasoning.small":
      loadReasoningSetting("small", value);
      break;
    case "reasoning.big":
      loadReasoningSetting("big", value);
      break;
    case "websearch":
      if (value && isWebSearchSetting(value)) {
        setWebSearchSetting(value);
      }
      break;
  }
}

function loadReasoningSetting(tier: LlmModelTier, value: string | null) {
  if (value === null || isReasoningEffort(value)) {
    setReasoningEffort(tier, value);
  }
}
