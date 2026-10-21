import { APP_ENV } from "./env.ts";

export class LlmToolBudget {
  private used = 0;

  constructor(private readonly limit = APP_ENV.LLM_MAX_TOOL_CALLS) {}

  get exhausted(): boolean {
    return this.used >= this.limit;
  }

  take(): boolean {
    if (this.exhausted) return false;
    this.used++;
    return true;
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
