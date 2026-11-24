import type { ToolName } from "../llm.ts";
import { LLM_DEPLOYMENTS } from "../llm-deployments.ts";
import {
  buildAgentIdentity,
  buildConflictInstructions,
  buildRespondingInstructions,
  CONVERSATION_RULES,
  joinPromptSections,
  MEMORY_RULE,
} from "./builders.ts";
import type { AgentDefinition } from "./types.ts";

export const id = "normal";
const configuredNames = Bun.env.NAMES?.split(",")
  .map((name) => name.trim())
  .filter(Boolean);
export const name = configuredNames?.length
  ? configuredNames
  : ["laylo", "лейло"];
export const MODEL = LLM_DEPLOYMENTS.big;
export const tools = [
  "web_search",
  "read_web_page",
  "search_images",
  "search_danbooru",
  "search_danbooru_tags",
  "read_image",
  "search_chat",
  "get_message_context",
  "read_last_messages",
  "read_youtube_video",
  "generate_image",
  "set_reply_message_id",
  "stop_pending_threads",
  "like",
  "ignore",
  "schedule_message",
  "cron_message",
  "get_scheduled_messages",
  "cancel_scheduled_message",
  "remember",
  "forget",
] satisfies ToolName[];

export function buildInstructions(
  _chatId: number,
  triggerName?: string,
): string {
  const identity = buildAgentIdentity(
    "a messenger chat member",
    name,
    "provide meaningful context in a chat",
    triggerName,
  );

  return joinPromptSections([
    `<role>
${identity}
</role>`,
    buildConflictInstructions(),
    buildRespondingInstructions([
      "A message containing only your name usually summons you to weigh in on the recent discussion. Read relevant messages when you need context or are asked to summarize a discussion. Quote or recite messages only when asked.",
      MEMORY_RULE,
      ...CONVERSATION_RULES,
    ]),
  ]);
}

export const normalAgent = {
  id,
  name,
  MODEL,
  tools,
  buildInstructions,
} satisfies AgentDefinition;
