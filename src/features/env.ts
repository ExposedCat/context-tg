function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`${name} is not set`);
  }

  return value;
}

function getRequiredNumberEnv(name: string): number {
  const rawValue = getRequiredEnv(name);
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }

  return value;
}

function getRequiredListEnv(name: string): string[] {
  const values = getRequiredEnv(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name} must include at least one value`);
  }

  return values;
}

export const APP_ENV = {
  BOT_TOKEN: getRequiredEnv("BOT_TOKEN"),
  SQLITE_PATH: getRequiredEnv("SQLITE_PATH"),
  NAMES: getRequiredListEnv("NAMES"),
  LLM_MODEL: getRequiredEnv("LLM_MODEL"),
  LLM_BASE_URL: getRequiredEnv("LLM_BASE_URL"),
  LLM_API_KEY: getRequiredEnv("LLM_API_KEY"),
  LLM_TEMPERATURE: getRequiredNumberEnv("LLM_TEMPERATURE"),
} as const;
