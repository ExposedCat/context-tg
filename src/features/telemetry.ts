export type LlmCallChatType = "private" | "group";
export type LlmCallMode = "normal" | "guest";
export type LlmCallStatus = "success" | "with_errors" | "failed";

export type LlmCallTimingPayload = {
  duration_ms: number;
  progress_intervals_ms: number[];
  progress_count: number;
  progress_total_ms: number;
  progress_median_ms: number;
  progress_min_ms: number;
  progress_max_ms: number;
};

/** Measures a complete request, including tools, retries and waits between model steps. */
export function createLlmCallTiming(
  now: () => number = () => performance.now(),
) {
  const started = now();
  let previousProgress = started;
  const intervals: number[] = [];
  return {
    progress() {
      const current = now();
      intervals.push(Math.max(0, current - previousProgress));
      previousProgress = current;
    },
    snapshot(): LlmCallTimingPayload {
      const sorted = [...intervals].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return {
        duration_ms: Math.max(0, now() - started),
        progress_intervals_ms: [...intervals],
        progress_count: intervals.length,
        progress_total_ms: intervals.reduce(
          (total, interval) => total + interval,
          0,
        ),
        progress_median_ms: sorted.length
          ? sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2
          : 0,
        progress_min_ms: sorted[0] ?? 0,
        progress_max_ms: sorted.at(-1) ?? 0,
      };
    },
  };
}

export type LlmCallTelemetryPayload = LlmCallTimingPayload & {
  chat_type: LlmCallChatType;
  input_tokens: number;
  /** Cached input tokens, already included in input_tokens. */
  cached_tokens: number;
  output_tokens: number;
  tools: string[];
  mode: LlmCallMode;
  status: LlmCallStatus;
};

export type BotTelemetryEvents = {
  message_checked: {
    chat_type: LlmCallChatType;
    mode: LlmCallMode;
    mentioned: boolean;
  };
  credit_usage: {
    credits: number;
    credit_kind: string;
    usage_owner: number;
    usage_limit: "limited" | "unlimited";
    chat_type: LlmCallChatType;
    mode: LlmCallMode;
    tools: string[];
  };
  llm_call: LlmCallTelemetryPayload;
};

export type LlmCallTelemetry = {
  chatType: LlmCallChatType;
  mode: LlmCallMode;
  emit: (payload: LlmCallTelemetryPayload) => void;
};

export function createLlmCallTelemetry(
  telegramChatType: string | undefined,
  mode: LlmCallMode,
  emitEvent: (eventName: "llm_call", payload: LlmCallTelemetryPayload) => void,
): LlmCallTelemetry {
  return {
    chatType: telegramChatType === "private" ? "private" : "group",
    mode,
    emit: (payload) => emitEvent("llm_call", payload),
  };
}
