import type { AgentId } from "../agents/index.ts";
import type { Database } from "../database.ts";

export type LlmToolContext = {
  chatId: number;
  messageId: number;
  userId?: number;
  userName?: string;
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

export type LlmSticker = {
  emoji: string;
};

export type FunctionToolResult = {
  output: string;
  image?: LlmGeneratedImage;
  sticker?: LlmSticker;
  handoffAgentId?: AgentId;
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
    agentId?: AgentId;
  },
) => FunctionToolResult | string | Promise<FunctionToolResult | string>;
