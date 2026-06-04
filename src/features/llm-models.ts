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

const MODEL_NAMES: Record<LlmModelTier, string> = {
  small: APP_ENV.LLM_MODEL_SMALL,
  big: APP_ENV.LLM_MODEL,
};

const REASONING_EFFORTS: Record<LlmModelTier, ReasoningSetting> = {
  small: "high",
  big: "high",
};

let webSearchSetting: WebSearchSetting = "high";

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
