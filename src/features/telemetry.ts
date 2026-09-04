export type LlmCallChatType = "private" | "group";
export type LlmCallMode = "normal" | "guest";
export type LlmCallStatus = "success" | "with_errors" | "failed";

export type LlmCallTelemetryPayload = {
  chat_type: LlmCallChatType;
  input_tokens: number;
  output_tokens: number;
  tools: string[];
  mode: LlmCallMode;
  status: LlmCallStatus;
};

export type BotTelemetryEvents = {
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
