import type { ToolName } from "../llm.ts";

export type AgentId = "normal" | "trader" | "researcher" | "ultimate";

export type AgentDefinition = {
  id: AgentId;
  name: string[];
  tools: ToolName[];
  buildInstructions: () => string;
};
