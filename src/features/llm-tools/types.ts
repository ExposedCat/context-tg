import type { Database } from "../database.ts";

export type LlmToolContext = {
  chatId: number;
  messageId: number;
  replyMessageId?: number;
  threadId?: number;
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
    database?: Database;
  },
) => FunctionToolResult | string | Promise<FunctionToolResult | string>;
