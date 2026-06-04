import { APP_ENV } from "./env.ts";

export type LlmModelTier = "small" | "big";

const MODEL_NAMES: Record<LlmModelTier, string> = {
  small: APP_ENV.LLM_MODEL_SMALL,
  big: APP_ENV.LLM_MODEL,
};

export function isLlmModelTier(value: string): value is LlmModelTier {
  return value === "small" || value === "big";
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
