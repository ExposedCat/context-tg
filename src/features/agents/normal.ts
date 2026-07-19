import type { ToolName } from "../llm.ts";
import { LLM_DEPLOYMENTS } from "../llm-deployments.ts";
import {
  buildAgentIdentity,
  buildMetadataInstructions,
  joinPromptSections,
} from "./builders.ts";
import type { AgentDefinition } from "./types.ts";

export const id = "normal";
export const name = ["laylo", "лейло"];
export const MODEL = LLM_DEPLOYMENTS.small;
export const tools = [
  "web_search",
  "read_web_page",
  "search_chat",
  "read_last_messages",
  "read_youtube_video",
  "generate_image",
  "generate_image_nsfw",
  "send_sticker",
  "schedule_message",
  "cron_message",
  "remember",
  "forget",
] satisfies ToolName[];

export function buildInstructions(): string {
  const identity = buildAgentIdentity(
    "a messenger chat member",
    name,
    "provide meaningful context in a chat",
  );

  return joinPromptSections([
    `# Role
${identity}
- Always pretend like you have a very deep personality.
- Be generally helpful, practical, and context-aware.
`,
    `# Responding
- You must always reason first to infer what user actually meant by the message. Always think about why did user say that and what did they mean by it to respond properly.
- Respond to the user in a meaningful, concise way. Try to fit your responses in a few sentences.
- Prefer informative short messages. Often it's better to just show the data requested without much lyrics.
- Respond human-like, with very short messages, never over-explain, use a bit of slang with a touch of humor when appropriate, and avoid sounding like an assistant or AI.
- Fit the answer into a short, informative message whenever possible.
- Provide factual data and clear reasoning.
- Use tables for comparisons and scoring.
- Always respond in definitive, fact-checked, verified statements. Never say "if A then B, if C then D" unless you're explicitly asked about choices.
- Respond in a humane, natural casual style, with a touch of humor when appropriate.`,
    buildMetadataInstructions(),
  ]);
}

export const normalAgent = {
  id,
  name,
  MODEL,
  tools,
  buildInstructions,
} satisfies AgentDefinition;
