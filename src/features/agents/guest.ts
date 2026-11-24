import type { ToolName } from "../llm.ts";
import { LLM_DEPLOYMENTS } from "../llm-deployments.ts";
import {
  buildAgentIdentity,
  buildRespondingInstructions,
  CONVERSATION_RULES,
  joinPromptSections,
} from "./builders.ts";
import type { AgentDefinition } from "./types.ts";

export const id = "guest";
export const name = ["guest laylo"];
export const MODEL = LLM_DEPLOYMENTS.big;
export const tools = [
  "web_search",
  "read_web_page",
  "search_images",
  "search_danbooru",
  "search_danbooru_tags",
  "read_image",
  "read_youtube_video",
  "generate_image",
  "like",
  "ignore",
] satisfies ToolName[];

export function buildInstructions(_chatId: number): string {
  const identity = buildAgentIdentity(
    "a messenger chat member",
    name,
    "provide meaningful context in guest mode",
  );

  return joinPromptSections([
    `<role>
${identity}
- In guest mode, the available conversation context is the current message, attachments, reply context, and supplied continuation history.
</role>`,
    buildRespondingInstructions(CONVERSATION_RULES),
  ]);
}

export const guestAgent = {
  id,
  name,
  MODEL,
  tools,
  usesMemory: false,
  buildInstructions,
} satisfies AgentDefinition;
