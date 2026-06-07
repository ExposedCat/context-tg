export type LlmToolContext = {
  chatId: number;
  messageId: number;
  replyMessageId?: number;
};

export type LlmGeneratedImage = {
  prompt: string;
  revisedPrompt?: string;
  url?: string;
  dataUrl?: string;
  mimeType?: string;
};

export type FunctionToolResult = {
  output: string;
  image?: LlmGeneratedImage;
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
