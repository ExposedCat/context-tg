import type { LlmToolContext } from "./types.ts";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(getString).filter((item) => item.length > 0)
    : [];
}

export function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function getOptionalDate(value: unknown): Date | undefined {
  const text = getString(value);

  if (!text) {
    return undefined;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function getJsonError(
  message: string,
  details: Record<string, unknown> = {},
): string {
  return JSON.stringify({ error: message, ...details });
}

export function getMissingContextResponse(
  tool: string,
  context?: LlmToolContext,
): string | undefined {
  return context
    ? undefined
    : `Cannot ${tool}: current chat context is unavailable.`;
}

export function getMissingDatabaseResponse(
  tool: string,
  database: unknown,
): string | undefined {
  return database ? undefined : `Cannot ${tool}: database is unavailable.`;
}
