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

export const APP_ENV = {
	BOT_TOKEN: getRequiredEnv("BOT_TOKEN"),
	SQLITE_PATH: getRequiredEnv("SQLITE_PATH"),
	LLM_MODEL: getRequiredEnv("LLM_MODEL"),
	LLM_BASE_URL: getRequiredEnv("LLM_BASE_URL"),
	LLM_API_KEY: getRequiredEnv("LLM_API_KEY"),
	LLM_TEMPERATURE: getRequiredNumberEnv("LLM_TEMPERATURE"),
} as const;
