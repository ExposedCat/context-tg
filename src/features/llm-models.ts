import type { Database } from "./database.ts";
import {
  isLlmDeploymentId,
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
export type WebSearchSetting = "off" | "low" | "medium" | "high";
export type WebSearchContextSize = Exclude<WebSearchSetting, "off">;
export type TrollingSetting = "off" | "on";
export type ChatLlmSettingKey = "reasoning" | "websearch";
export type LlmSettingsDeployment = LlmDeploymentId | "all";
export type LlmSettingsTable = {
  key: string;
  value: string | null;
};
export type ChatLlmSettingsTable = {
  chat_id: number;
  deployment: LlmSettingsDeployment;
  key: ChatLlmSettingKey;
  value: string | null;
};

type LlmSettingsDatabase = Database;
type LlmModelSettingKey = `model:${LlmDeploymentId}`;
type LlmSettingKey =
  | "reasoning"
  | "websearch"
  | "trolling"
  | LlmModelSettingKey;

let reasoningEffort: ReasoningSetting = "high";
let webSearchSetting: WebSearchSetting = "high";
let trollingSetting: TrollingSetting = "off";

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

export function isTrollingSetting(value: string): value is TrollingSetting {
  return value === "off" || value === "on";
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
  await persistLlmSetting(database, "reasoning", effort);
  return setReasoningEffort(effort);
}

export function getWebSearchSetting(): WebSearchSetting {
  return webSearchSetting;
}

export function isWebSearchEnabled(
  setting: WebSearchSetting = webSearchSetting,
): boolean {
  return setting !== "off";
}

export function getWebSearchContextSize(
  setting: WebSearchSetting = webSearchSetting,
): WebSearchContextSize {
  return setting === "off" ? "low" : setting;
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

export function getTrollingSetting(): TrollingSetting {
  return trollingSetting;
}

export function isTrollingEnabled(): boolean {
  return trollingSetting === "on";
}

export function setTrollingSetting(setting: TrollingSetting): TrollingSetting {
  trollingSetting = setting;
  return trollingSetting;
}

export async function persistTrollingSetting(
  database: LlmSettingsDatabase,
  setting: TrollingSetting,
): Promise<TrollingSetting> {
  await persistLlmSetting(database, "trolling", setting);
  return setTrollingSetting(setting);
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
  const persist = (target: LlmSettingsDatabase) =>
    target
      .insertInto("chat_llm_settings")
      .values({ chat_id: chatId, deployment, key, value })
      .onConflict((conflict) =>
        conflict
          .columns(["chat_id", "deployment", "key"])
          .doUpdateSet({ value }),
      )
      .execute();

  if (deployment !== "all") {
    await persist(database);
    return;
  }

  await database.transaction().execute(async (transaction) => {
    await transaction
      .deleteFrom("chat_llm_settings")
      .where("chat_id", "=", chatId)
      .where("key", "=", key)
      .where("deployment", "!=", "all")
      .execute();

    await persist(transaction);
  });
}

function parseStoredReasoningSetting(
  value: string | null,
): ReasoningSetting | undefined {
  if (value === null) {
    return null;
  }

  return isReasoningEffort(value) ? value : undefined;
}

function parseStoredWebSearchSetting(
  value: string | null,
): WebSearchSetting | undefined {
  return value && isWebSearchSetting(value) ? value : undefined;
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

  return setting === undefined ? getReasoningEffort() : setting;
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

export async function getChatWebSearchSetting(
  database: LlmSettingsDatabase,
  chatId: number,
  deployment: LlmSettingsDeployment,
): Promise<WebSearchSetting> {
  const stored = await getResolvedChatLlmSetting(
    database,
    chatId,
    deployment,
    "websearch",
  );
  const setting =
    stored === undefined ? undefined : parseStoredWebSearchSetting(stored);

  return setting ?? getWebSearchSetting();
}

export async function persistChatWebSearchSetting(
  database: LlmSettingsDatabase,
  chatId: number,
  deployment: LlmSettingsDeployment,
  setting: WebSearchSetting,
): Promise<WebSearchSetting> {
  await persistChatLlmSetting(
    database,
    chatId,
    deployment,
    "websearch",
    setting,
  );
  return setting;
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
    case "websearch":
      if (value && isWebSearchSetting(value)) {
        setWebSearchSetting(value);
      }
      break;
    case "trolling":
      if (value && isTrollingSetting(value)) {
        setTrollingSetting(value);
      }
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
