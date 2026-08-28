import type OpenAI from "@openai/openai";
import type { Api } from "grammy";
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

export type LlmImageInput = {
  image_url: string;
  detail?: "low" | "high" | "auto" | "original";
};

export type LlmSticker = {
  emoji: string;
};

export type FunctionToolResult = {
  output: string;
  inputImages?: LlmImageInput[];
  replyMessageId?: number | null;
  generatedImageId?: string;
  sticker?: LlmSticker;
  stickers?: LlmSticker[];
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
    client?: OpenAI;
    api?: Api;
  },
) => FunctionToolResult | string | Promise<FunctionToolResult | string>;
