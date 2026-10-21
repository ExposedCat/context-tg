import { APP_ENV } from "./env.ts";

export class LlmBudgetExceededError extends Error {
  constructor(
    message = "This request reached its token budget. Please ask for a smaller task.",
  ) {
    super(message);
    this.name = "LlmBudgetExceededError";
  }
}

type TokenUsage = { input_tokens?: number; output_tokens?: number };

function validTokens(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

export class LlmTokenBudget {
  private used = 0;
  private reserved = 0;
  private toolCalls = 0;

  constructor(
    private readonly limits = {
      total: APP_ENV.LLM_REQUEST_TOKEN_BUDGET,
      output: APP_ENV.LLM_MAX_OUTPUT_TOKENS,
      tools: APP_ENV.LLM_MAX_TOOL_CALLS,
    },
  ) {}

  reserve(outputLimit = this.limits.output) {
    const maxOutputTokens = Math.min(
      outputLimit,
      this.limits.output,
      this.limits.total - this.used - this.reserved,
    );
    if (maxOutputTokens < 256) throw new LlmBudgetExceededError();
    const reservation = maxOutputTokens;
    this.reserved += reservation;
    let settled = false;
    return {
      maxOutputTokens,
      settle: (usage?: TokenUsage) => {
        if (settled) return;
        settled = true;
        this.reserved -= reservation;
        // Failed attempts and providers without usage keep their full allowance.
        this.used += validTokens(usage?.output_tokens, maxOutputTokens);
      },
    };
  }

  useTools(count: number) {
    if (
      this.toolCalls + count > this.limits.tools ||
      this.used + this.reserved >= this.limits.total
    ) {
      throw new LlmBudgetExceededError(
        "This request reached its tool or token budget. Please ask for a smaller task.",
      );
    }
    this.toolCalls += count;
  }

  addToolUsage(usage: TokenUsage) {
    this.used += validTokens(usage.output_tokens, 0);
    if (this.used + this.reserved >= this.limits.total)
      throw new LlmBudgetExceededError();
  }
}

export function limitToolOutput(output: string): string {
  const limit = 16000;
  const bytes = new TextEncoder().encode(output);
  if (bytes.length <= limit) return output;
  return (
    new TextDecoder().decode(bytes.subarray(0, limit)) +
    "\n[Tool result truncated to fit the request budget. Use a narrower query for the relevant section.]"
  );
}
