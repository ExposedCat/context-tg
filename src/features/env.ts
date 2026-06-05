function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`${name} is not set`);
  }

  return value;
}

function getOptionalEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value ? value : undefined;
}

function getRequiredNumberEnv(name: string): number {
  const rawValue = getRequiredEnv(name);
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }

  return value;
}

export const APP_ENV = {
  BOT_TOKEN: getRequiredEnv("BOT_TOKEN"),
  ADMIN_ID: getRequiredNumberEnv("ADMIN_ID"),
  SQLITE_PATH: getRequiredEnv("SQLITE_PATH"),
  LLM_MODEL: getRequiredEnv("LLM_MODEL"),
  LLM_MODEL_SMALL: getRequiredEnv("LLM_MODEL_SMALL"),
  LLM_BASE_URL: getRequiredEnv("LLM_BASE_URL"),
  LLM_API_KEY: getRequiredEnv("LLM_API_KEY"),
  LLM_TEMPERATURE: getRequiredNumberEnv("LLM_TEMPERATURE"),
  EMBEDDER_BASE_URL: getRequiredEnv("EMBEDDER_BASE_URL"),
  EMBEDDER_API_KEY: getRequiredEnv("EMBEDDER_API_KEY"),
  EMBEDDING_MODEL: getRequiredEnv("EMBEDDING_MODEL"),
  QDRANT_URL: getRequiredEnv("QDRANT_URL"),
  QDRANT_API_KEY: getOptionalEnv("QDRANT_API_KEY"),
  QDRANT_COLLECTION: getOptionalEnv("QDRANT_COLLECTION") ?? "messages",
} as const;
