import { readFileSync } from "node:fs";

export type GatewayConfig = {
  botToken: string;
  bridgeToken: string;
  databasePath: string;
  listenHost: string;
  listenPort: number;
  pollTimeoutSeconds: number;
  contextMessages: number;
};

function requiredSecret(fileEnvironmentName: string, valueEnvironmentName: string): string {
  const secretPath = process.env[fileEnvironmentName];
  const value = secretPath
    ? readFileSync(secretPath, "utf8").trim()
    : process.env[valueEnvironmentName];
  if (!value) {
    throw new Error(`${fileEnvironmentName} or ${valueEnvironmentName} is required`);
  }
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadGatewayConfig(): GatewayConfig {
  return {
    botToken: requiredSecret("TELEGRAM_BOT_TOKEN_FILE", "TELEGRAM_BOT_TOKEN"),
    bridgeToken: requiredSecret("LOYLEX_BRIDGE_TOKEN_FILE", "LOYLEX_BRIDGE_TOKEN"),
    databasePath: process.env.LOYLEX_DATABASE_PATH ?? "/data/loylex.sqlite",
    listenHost: process.env.LOYLEX_LISTEN_HOST ?? "0.0.0.0",
    listenPort: integer("LOYLEX_LISTEN_PORT", 8787),
    pollTimeoutSeconds: integer("LOYLEX_POLL_TIMEOUT_SECONDS", 45),
    contextMessages: integer("LOYLEX_CONTEXT_MESSAGES", 80),
  };
}
