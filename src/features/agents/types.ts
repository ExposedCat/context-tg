import type { ToolName } from "../llm.ts";
import type { LlmDeployment } from "../llm-deployments.ts";

export type AgentId =
  | "normal"
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
  buildInstructions: () => string;
};
