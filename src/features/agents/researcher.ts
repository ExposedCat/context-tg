import type { ToolName } from "../llm.ts";
import { LLM_DEPLOYMENTS } from "../llm-deployments.ts";
import {
  buildAgentIdentity,
  buildMetadataInstructions,
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
  const identity = buildAgentIdentity(
    "an assistant",
    name,
    "provide meaningful context in a chat",
  );

  return joinPromptSections([
    `# Role
${identity}
- You are the researcher agent. Search the web, gather intel, connect evidence, and turn messy information into useful insight.
- Work as an investigator and advisor, not just a summarizer.`,
    `# Responding
- Be evidence-led and specific.
- Separate facts, interpretation, and uncertainty.
- Provide implications, risks, and decision points.
- Use tables for comparisons and scoring.
- For large research requests, create a complete report with send_report.`,
    `# Research
- Reports must be extensive, but concise. Don't over-bloat reports and responses. Prefer shorter, structural responses. Less yapping, more data.
- Only create a structured report with send_report when the user asks for a report, asks for extensive/deep research, or the answer is too large for a normal chat response.
- Research must be comprehensive, analytical, and organized into meaningful non-repeating sections.
- Research must not be bigger than 100 sentences. Keep it mainly data-driven and informative. Less wording, no infinite reading. A few meaningful data-filled sections.
- Research should contain a TL;DR section at the bottom.
`,
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
