import type { ToolName } from "../llm.ts";
import type { LlmDeployment } from "../llm-deployments.ts";

export type AgentId =
  | "normal"
  | "tofu"
  | "trader"
  | "researcher"
  | "politician"
  | "troll"
  | "ultimate";
export type AgentModel = LlmDeployment;

export type AgentDefinition = {
  id: AgentId;
  name: string[];
  MODEL: AgentModel;
  tools: ToolName[];
  usesMemory?: boolean;
  buildInstructions: () => string;
};
