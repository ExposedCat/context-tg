export type LlmToolContext = {
  chatId: number;
  messageId: number;
  replyMessageId?: number;
};

export type FunctionToolResult = {
  output: string;
  htmlReport?: {
    htmlString: string;
    filename: string;
  };
};

export type FunctionToolRunner = (
  args: Record<string, unknown> | null,
  context?: LlmToolContext,
) => FunctionToolResult | string | Promise<FunctionToolResult | string>;
