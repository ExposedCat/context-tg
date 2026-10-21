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

// A UTF-8 byte is a conservative text-token allowance across tokenizers. Images
// use an allowance instead of counting base64 bytes; their true cost is supplied
// by the provider in response usage, and varies with model and resolution.
export function estimateInputTokens(input: unknown): number {
  let images = 0;
  const serialized = JSON.stringify(input, (key, value) => {
    if (key === "image_url") {
      images++;
      return "[image]";
    }
    return value;
  });
  return new TextEncoder().encode(serialized ?? "").length + images * 8192;
}

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
      input: APP_ENV.LLM_MAX_INPUT_TOKENS,
      output: APP_ENV.LLM_MAX_OUTPUT_TOKENS,
      tools: APP_ENV.LLM_MAX_TOOL_CALLS,
    },
  ) {}

  reserve(input: unknown, outputLimit = this.limits.output) {
    const inputTokens = estimateInputTokens(input);
    if (inputTokens > this.limits.input) {
      throw new LlmBudgetExceededError(
        "The request and its context are too large. Please use a smaller excerpt or start a new thread.",
      );
    }
    const maxOutputTokens = Math.min(
      outputLimit,
      this.limits.output,
      this.limits.total - this.used - this.reserved - inputTokens,
    );
    if (maxOutputTokens < 256) throw new LlmBudgetExceededError();
    const reservation = inputTokens + maxOutputTokens;
    this.reserved += reservation;
    let settled = false;
    return {
      maxOutputTokens,
      settle: (usage?: TokenUsage) => {
        if (settled) return;
        settled = true;
        this.reserved -= reservation;
        // Failed attempts and providers without usage keep their full allowance.
        this.used +=
          validTokens(usage?.input_tokens, inputTokens) +
          validTokens(usage?.output_tokens, maxOutputTokens);
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
    this.used +=
      validTokens(usage.input_tokens, 0) + validTokens(usage.output_tokens, 0);
    if (this.used + this.reserved >= this.limits.total)
      throw new LlmBudgetExceededError();
  }
}

export function limitToolOutput(output: string): string {
  const limit = Math.min(16000, Math.floor(APP_ENV.LLM_MAX_INPUT_TOKENS / 2));
  const bytes = new TextEncoder().encode(output);
  if (bytes.length <= limit) return output;
  return (
    new TextDecoder().decode(bytes.subarray(0, limit)) +
    "\n[Tool result truncated to fit the request budget. Use a narrower query for the relevant section.]"
  );
}
