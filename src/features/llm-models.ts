import type { Database } from "./database.ts";
import {
  isLlmDeploymentId,
  LLM_DEPLOYMENT_OPTIONS,
  type LlmDeploymentId,
  setLlmDeploymentName,
} from "./llm-deployments.ts";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type ReasoningSetting = ReasoningEffort | null;
export type ChatLlmSettingKey = "reasoning" | "debug";
export type LlmSettingsDeployment = LlmDeploymentId | "all";
export type LlmSettingsTable = {
  key: string;
  value: string | null;
};
export type ChatLlmSettingsTable = {
  chat_id: number;
  deployment: LlmSettingsDeployment;
  key: string;
  value: string | null;
};

type LlmSettingsDatabase = Database;
type LlmModelSettingKey = `model:${LlmDeploymentId}`;
type LlmDeploymentSettingKey = `reasoning:${LlmDeploymentId}`;
type LlmSettingKey =
  | ChatLlmSettingKey
  | LlmDeploymentSettingKey
  | LlmModelSettingKey;

let reasoningEffort: ReasoningSetting = null;
const OBSOLETE_WEB_SEARCH_SETTING_KEYS = [
  "websearch",
  ...LLM_DEPLOYMENT_OPTIONS.map((deployment) => `websearch:${deployment.id}`),
] as const;

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

export function parseDebugModeSetting(value: string): boolean | undefined {
  switch (value.toLocaleLowerCase()) {
    case "on":
      return true;
    case "off":
      return false;
    default:
      return undefined;
  }
}

export function isLlmSettingsDeployment(
  value: string,
): value is LlmSettingsDeployment {
  return value === "all" || isLlmDeploymentId(value);
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
  return await persistGlobalReasoningEffort(database, "all", effort);
}

export async function persistLlmDeploymentName(
  database: LlmSettingsDatabase,
  id: LlmDeploymentId,
  deploymentName: string,
): Promise<string> {
  await persistLlmSetting(database, getLlmModelSettingKey(id), deploymentName);
  setLlmDeploymentName(id, deploymentName);
  return deploymentName;
}

export async function migrateLlmSettings(database: LlmSettingsDatabase) {
  await database.schema
    .createTable("llm_settings")
    .ifNotExists()
    .addColumn("key", "text", (column) => column.primaryKey().notNull())
    .addColumn("value", "text")
    .execute();

  await database.schema
    .createTable("chat_llm_settings")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("deployment", "text", (column) => column.notNull())
    .addColumn("key", "text", (column) => column.notNull())
    .addColumn("value", "text")
    .addPrimaryKeyConstraint("chat_llm_settings_primary_key", [
      "chat_id",
      "deployment",
      "key",
    ])
    .execute();

  await database
    .deleteFrom("llm_settings")
    .where("key", "in", OBSOLETE_WEB_SEARCH_SETTING_KEYS)
    .execute();
  await database
    .deleteFrom("chat_llm_settings")
    .where("key", "=", "websearch")
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

function getGlobalLlmSettingKey(
  key: ChatLlmSettingKey,
  deployment: LlmSettingsDeployment,
): ChatLlmSettingKey | LlmDeploymentSettingKey {
  if (deployment === "all") {
    return key;
  }

  if (key !== "reasoning") {
    throw new Error(`Setting "${key}" is not deployment-scoped.`);
  }

  return `${key}:${deployment}`;
}

async function getDirectGlobalLlmSetting(
  database: LlmSettingsDatabase,
  deployment: LlmSettingsDeployment,
  key: ChatLlmSettingKey,
): Promise<string | null | undefined> {
  const row = await database
    .selectFrom("llm_settings")
    .select("value")
    .where("key", "=", getGlobalLlmSettingKey(key, deployment))
    .executeTakeFirst();

  return row ? row.value : undefined;
}

async function getResolvedGlobalLlmSetting(
  database: LlmSettingsDatabase,
  deployment: LlmSettingsDeployment,
  key: ChatLlmSettingKey,
): Promise<string | null | undefined> {
  if (deployment === "all") {
    return await getDirectGlobalLlmSetting(database, deployment, key);
  }

  const [deploymentValue, allValue] = await Promise.all([
    getDirectGlobalLlmSetting(database, deployment, key),
    getDirectGlobalLlmSetting(database, "all", key),
  ]);

  return deploymentValue !== undefined ? deploymentValue : allValue;
}

async function persistGlobalLlmSetting(
  database: LlmSettingsDatabase,
  deployment: LlmSettingsDeployment,
  key: ChatLlmSettingKey,
  value: string | null,
) {
  const settingKey = getGlobalLlmSettingKey(key, deployment);

  await persistLlmSetting(database, settingKey, value);
}

async function getDirectChatLlmSetting(
  database: LlmSettingsDatabase,
  chatId: number,
  deployment: LlmSettingsDeployment,
  key: ChatLlmSettingKey,
): Promise<string | null | undefined> {
  const row = await database
    .selectFrom("chat_llm_settings")
    .select("value")
    .where("chat_id", "=", chatId)
    .where("deployment", "=", deployment)
    .where("key", "=", key)
    .executeTakeFirst();

  return row ? row.value : undefined;
}

async function getResolvedChatLlmSetting(
  database: LlmSettingsDatabase,
  chatId: number,
  deployment: LlmSettingsDeployment,
  key: ChatLlmSettingKey,
): Promise<string | null | undefined> {
  if (deployment === "all") {
    return await getDirectChatLlmSetting(database, chatId, deployment, key);
  }

  const [deploymentValue, allValue] = await Promise.all([
    getDirectChatLlmSetting(database, chatId, deployment, key),
    getDirectChatLlmSetting(database, chatId, "all", key),
  ]);

  return deploymentValue !== undefined ? deploymentValue : allValue;
}

async function persistChatLlmSetting(
  database: LlmSettingsDatabase,
  chatId: number,
  deployment: LlmSettingsDeployment,
  key: ChatLlmSettingKey,
  value: string | null,
) {
  await database
    .insertInto("chat_llm_settings")
    .values({ chat_id: chatId, deployment, key, value })
    .onConflict((conflict) =>
      conflict.columns(["chat_id", "deployment", "key"]).doUpdateSet({ value }),
    )
    .execute();
}

function parseStoredReasoningSetting(
  value: string | null,
): ReasoningSetting | undefined {
  if (value === null) {
    return null;
  }

  return isReasoningEffort(value) ? value : undefined;
}

function formatStoredDebugMode(enabled: boolean): string {
  return enabled ? "on" : "off";
}

function parseStoredDebugMode(value: string | null): boolean | undefined {
  return value === null ? undefined : parseDebugModeSetting(value);
}

export async function getChatReasoningEffort(
  database: LlmSettingsDatabase,
  chatId: number,
  deployment: LlmSettingsDeployment,
): Promise<ReasoningSetting> {
  const stored = await getResolvedChatLlmSetting(
    database,
    chatId,
    deployment,
    "reasoning",
  );
  const setting =
    stored === undefined ? undefined : parseStoredReasoningSetting(stored);

  return setting === undefined
    ? await getGlobalReasoningEffort(database, deployment)
    : setting;
}

export async function getChatDebugMode(
  database: LlmSettingsDatabase,
  chatId: number,
): Promise<boolean> {
  const stored = await getResolvedChatLlmSetting(
    database,
    chatId,
    "all",
    "debug",
  );
  const setting =
    stored === undefined ? undefined : parseStoredDebugMode(stored);

  return setting === undefined ? await getGlobalDebugMode(database) : setting;
}

export async function getGlobalReasoningEffort(
  database: LlmSettingsDatabase,
  deployment: LlmSettingsDeployment,
): Promise<ReasoningSetting> {
  const stored = await getResolvedGlobalLlmSetting(
    database,
    deployment,
    "reasoning",
  );
  const setting =
    stored === undefined ? undefined : parseStoredReasoningSetting(stored);

  return setting === undefined ? getReasoningEffort() : setting;
}

export async function getGlobalDebugMode(
  database: LlmSettingsDatabase,
): Promise<boolean> {
  const stored = await getDirectGlobalLlmSetting(database, "all", "debug");
  const setting =
    stored === undefined ? undefined : parseStoredDebugMode(stored);

  return setting ?? false;
}

export async function persistGlobalReasoningEffort(
  database: LlmSettingsDatabase,
  deployment: LlmSettingsDeployment,
  effort: ReasoningSetting,
): Promise<ReasoningSetting> {
  await persistGlobalLlmSetting(database, deployment, "reasoning", effort);

  if (deployment === "all") {
    setReasoningEffort(effort);
  }

  return effort;
}

export async function persistGlobalDebugMode(
  database: LlmSettingsDatabase,
  enabled: boolean,
): Promise<boolean> {
  await persistGlobalLlmSetting(
    database,
    "all",
    "debug",
    formatStoredDebugMode(enabled),
  );
  return enabled;
}

export async function persistChatReasoningEffort(
  database: LlmSettingsDatabase,
  chatId: number,
  deployment: LlmSettingsDeployment,
  effort: ReasoningSetting,
): Promise<ReasoningSetting> {
  await persistChatLlmSetting(
    database,
    chatId,
    deployment,
    "reasoning",
    effort,
  );
  return effort;
}

export async function persistChatDebugMode(
  database: LlmSettingsDatabase,
  chatId: number,
  enabled: boolean,
): Promise<boolean> {
  await persistChatLlmSetting(
    database,
    chatId,
    "all",
    "debug",
    formatStoredDebugMode(enabled),
  );
  return enabled;
}

function loadLlmSetting(key: string, value: string | null) {
  const deploymentId = parseLlmModelSettingKey(key);

  if (deploymentId) {
    setLlmDeploymentName(deploymentId, value ?? "");
    return;
  }

  switch (key) {
    case "reasoning":
      loadReasoningSetting(value);
      break;
  }
}

function loadReasoningSetting(value: string | null) {
  if (value === null || isReasoningEffort(value)) {
    setReasoningEffort(value);
  }
}

function getLlmModelSettingKey(id: LlmDeploymentId): LlmModelSettingKey {
  return `model:${id}`;
}

function parseLlmModelSettingKey(key: string): LlmDeploymentId | undefined {
  if (!key.startsWith("model:")) {
    return undefined;
  }

  const id = key.slice("model:".length);
  return isLlmDeploymentId(id) ? id : undefined;
}
