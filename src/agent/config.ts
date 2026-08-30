import { readFileSync } from "node:fs";

export type AgentConfig = {
  bridgeUrl: string;
  bridgeToken: string;
  codexBinary: string;
  codexHome: string;
  model: string;
  reasoningEffort: string;
  repositoryPath: string;
  memoryPath: string;
  pollIntervalMs: number;
  maxConcurrentJobs: number;
};

function secret(): string {
  const path = process.env.LOYLEX_BRIDGE_TOKEN_FILE;
  const value = path ? readFileSync(path, "utf8").trim() : process.env.LOYLEX_BRIDGE_TOKEN;
  if (!value) {
    throw new Error("LOYLEX_BRIDGE_TOKEN_FILE or LOYLEX_BRIDGE_TOKEN is required");
  }
  return value;
}

export function loadAgentConfig(): AgentConfig {
  return {
    bridgeUrl: process.env.LOYLEX_BRIDGE_URL ?? "http://loylex-gateway:8787",
    bridgeToken: secret(),
    codexBinary: process.env.CODEX_BINARY ?? "codex",
    codexHome: process.env.CODEX_HOME ?? "/home/loylex/.codex",
    model: process.env.CODEX_MODEL ?? "gpt-5.6-luna",
    reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "max",
    repositoryPath: process.env.LOYLEX_REPOSITORY_PATH ?? "/workspace/Loylex",
    memoryPath: process.env.LOYLEX_MEMORY_PATH ?? "/memory",
    pollIntervalMs: Number.parseInt(process.env.LOYLEX_POLL_INTERVAL_MS ?? "1000", 10),
    maxConcurrentJobs: Number.parseInt(process.env.LOYLEX_MAX_CONCURRENT_JOBS ?? "50", 10),
  };
}
