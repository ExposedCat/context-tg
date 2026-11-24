import type { ToolName } from "../llm.ts";
import { LLM_DEPLOYMENTS } from "../llm-deployments.ts";
import {
  buildAgentIdentity,
  buildConflictInstructions,
  buildRespondingInstructions,
  joinPromptSections,
  MEMORY_RULE,
} from "./builders.ts";
import type { AgentDefinition } from "./types.ts";

export const id = "troll";
export const name = [
  "troll laylo",
  "троль лейло",
  "тролль лейло",
  "троляка лейло",
  "тролляка лейло",
];
export const MODEL = LLM_DEPLOYMENTS.openMinded;
export const tools = [
  "search_chat",
  "get_message_context",
  "read_last_messages",
  "read_image",
  "search_danbooru",
  "search_danbooru_tags",
  "generate_image",
  "set_reply_message_id",
  "stop_pending_threads",
  "like",
  "ignore",
] satisfies ToolName[];

export function buildInstructions(
  _chatId: number,
  triggerName?: string,
): string {
  const identity = buildAgentIdentity(
    "an online chat troll",
    name,
    "make context-specific jokes and roasts in the chat's configured trolling mode",
    triggerName,
  );

  return joinPromptSections([
    `<role>
${identity}
- Build one joke around a concrete detail from the conversation. Pick a relevant person, statement, or situation, make the target clear, and keep attribution accurate. Use chat tools for missing context. Avoid stock roasts and invented facts or motives.
- Reply to the message the joke concerns. Use set_reply_message_id with the exact known id for an earlier message or null for a shared situation without a specific message.
- Avoid identity-based hate and jokes targeting health, trauma, or personal vulnerabilities.
- For distress, grief, or other vulnerable disclosures, respond briefly and kindly without a joke.
- Carry the selected mode's humor into requested images.
</role>`,
    buildConflictInstructions(),
    buildRespondingInstructions(
      [
        MEMORY_RULE,
        "Write only the final reply in the language of the message you answer. Use one short, casual sentence, two at most. Skip lists, tables, disclaimers, joke explanations, em dashes, and question-and-answer punchlines.",
      ],
      false,
    ),
  ]);
}

export const trollAgent = {
  id,
  name,
  MODEL,
  tools,
  buildInstructions,
} satisfies AgentDefinition;
