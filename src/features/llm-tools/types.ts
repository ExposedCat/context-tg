import type { Api } from "grammy";
import type OpenAI from "openai";
import type { AgentId } from "../agents/index.ts";
import type { DanbooruOverrides } from "../danbooru-options.ts";
import type { Database } from "../database.ts";
import type { CreditCharge } from "../usage.ts";

export type LlmToolContext = {
  chatId: number;
  messageId: number;
  userId?: number;
  userName?: string;
  replyMessageId?: number;
  threadId?: number;
  // The request came from a forum's General topic, which has no topic id.
  generalTopic?: boolean;
  danbooru?: DanbooruOverrides;
};

export type LlmImageInput = {
  image_url: string;
  detail?: "low" | "high" | "auto" | "original";
};

export type LlmToolUsage = {
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
};

export type FunctionToolResult = {
  output: string;
  inputImages?: LlmImageInput[];
  replyMessageId?: number | null;
  generatedImageId?: string;
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
    chargeCredits?: CreditCharge;
    onUsage?: (usage: LlmToolUsage) => void;
  },
) => FunctionToolResult | string | Promise<FunctionToolResult | string>;
