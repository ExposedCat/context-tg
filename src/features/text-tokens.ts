import { getEncoding } from "js-tiktoken";

const encoding = getEncoding("o200k_base");
export const TOKENS_PER_CREDIT = Number(
  Deno.env.get("TOKENS_PER_CREDIT") ?? 618,
);
if (!Number.isSafeInteger(TOKENS_PER_CREDIT) || TOKENS_PER_CREDIT <= 0) {
  throw new Error("TOKENS_PER_CREDIT must be a positive safe integer");
}

export function countTextTokens(text: string): number {
  return encoding.encode(text).length;
}

export function truncateTextTokens(text: string, limit: number): string {
  return encoding
    .decode(encoding.encode(text).slice(0, Math.max(0, limit)))
    .replace(/\uFFFD+$/u, "");
}
