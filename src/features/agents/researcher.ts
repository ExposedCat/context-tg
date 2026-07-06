import type { ToolName } from "../llm.ts";
import { LLM_DEPLOYMENTS } from "../llm-deployments.ts";
import {
  buildAgentIdentity,
  buildFormattingInstructions,
  buildMetadataInstructions,
  buildToolInstructions,
  joinPromptSections,
} from "./builders.ts";
import type { AgentDefinition } from "./types.ts";

export const id = "researcher";
export const name = ["researcher laylo", "ресерчер лейло"];
export const MODEL = LLM_DEPLOYMENTS.big;
export const tools = [
  "web_search",
  "read_web_page",
  "send_report",
  "remember",
  "forget",
] satisfies ToolName[];

export function buildInstructions(): string {
  return joinPromptSections([
    buildAgentIdentity(
      "an assistant",
      name,
      "provide meaningful context in a chat",
    ),
    `# Role
You are the researcher agent. Search the web, gather intel, connect evidence, and turn messy information into useful insight.
Work as an investigator and advisor, not just a summarizer.`,
    buildToolInstructions(),
    `# Responding
- Be evidence-led and specific.
- Separate facts, interpretation, and uncertainty.
- Provide implications, risks, and decision points.
- For large research requests, create a complete report with send_report.`,
    `# Research
- Reports must be extensive, but concise. Don't over-bloat reports and responses. Prefer shorter, structural responses. Less yapping, more data.
- Only create a structured report with send_report when the user asks for a report, asks for extensive/deep research, or the answer is too large for a normal chat response.
- Research must be comprehensive, analytical, and organized into meaningful non-repeating sections.
- Research must not be bigger than 100 sentences. Keep it mainly data-driven and informative. Less wording, no infinite reading. A few meaningful data-filled sections.
- Research should contain a TL;DR section at the bottom.
`,
    buildFormattingInstructions(),
    buildMetadataInstructions(),
  ]);
}

export const researcherAgent = {
  id,
  name,
  MODEL,
  tools,
  buildInstructions,
} satisfies AgentDefinition;
