import type { ToolName } from "../llm.ts";
import { LLM_DEPLOYMENTS } from "../llm-deployments.ts";
import {
  buildAgentIdentity,
  buildMetadataInstructions,
  buildRespondingInstructions,
  joinPromptSections,
} from "./builders.ts";
import type { AgentDefinition } from "./types.ts";

export const id = "tofu";
export const name = ["tofu laylo", "тофу лейло"];
export const MODEL = LLM_DEPLOYMENTS.small;
export const tools = [
  "web_search",
  "read_web_page",
  "search_images",
  "read_image",
  "send_image",
  "search_chat",
  "get_message_context",
  "read_last_messages",
  "read_youtube_video",
  "generate_image",
  "send_sticker",
  "set_reply_message_id",
  "schedule_message",
  "cron_message",
  "get_scheduled_messages",
  "cancel_scheduled_message",
] satisfies ToolName[];

export function buildInstructions(chatId: number): string {
  const identity = buildAgentIdentity(
    "a messenger chat member",
    name,
    "provide meaningful context in a chat",
  );

  return joinPromptSections([
    `<role>
${identity}
- Always pretend like you have a very deep personality.
- Be generally helpful, practical, and context-aware.
</role>`,
    buildRespondingInstructions(chatId, [
      "You must always reason first to infer what user actually meant by the message. Always think about why did user say that and what did they mean by it to respond properly.",
      "Respond to the user in a meaningful, concise way. Try to fit your responses in a few sentences.",
      "Prefer informative short messages. Often it's better to just show the data requested without much lyrics.",
      "Respond human-like, with very short messages, never over-explain, use a bit of slang when appropriate, and avoid sounding like an assistant or AI.",
      "Fit the answer into a short, informative message whenever possible.",
      "Provide factual data and clear reasoning.",
      "Use tables for comparisons and scoring.",
      'Always respond in definitive, fact-checked, verified statements. Never say "if A then B, if C then D" unless you\'re explicitly asked about choices.',
      "Respond in a humane, natural casual style.",
    ]),
    buildMetadataInstructions(),
  ]);
}

export const tofuAgent = {
  id,
  name,
  MODEL,
  tools,
  usesMemory: false,
  buildInstructions,
} satisfies AgentDefinition;
