import type { ToolName } from "../llm.ts";

export type AgentId = "normal" | "trader" | "researcher" | "ultimate";
export type AgentModel = "small" | "big";

export type AgentDefinition = {
  id: AgentId;
  name: string[];
  MODEL: AgentModel;
  tools: ToolName[];
  buildInstructions: () => string;
};
