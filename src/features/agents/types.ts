import type { ToolName } from "../llm.ts";
import type { LlmModelTier } from "../llm-models.ts";

export type AgentId = "normal" | "trader" | "researcher" | "ultimate";
export type AgentModel = LlmModelTier;

export type AgentDefinition = {
  id: AgentId;
  name: string[];
  MODEL: AgentModel;
  tools: ToolName[];
  buildInstructions: () => string;
};
