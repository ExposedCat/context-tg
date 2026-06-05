export type LlmToolContext = {
  chatId: number;
  messageId: number;
  replyMessageId?: number;
};

export type FunctionToolResult = {
  output: string;
  report?: {
    documentHtml: string;
    filename: string;
  };
};

export type FunctionToolRunner = (
  args: Record<string, unknown> | null,
  context?: LlmToolContext,
  options?: {
    signal?: AbortSignal;
  },
) => FunctionToolResult | string | Promise<FunctionToolResult | string>;
