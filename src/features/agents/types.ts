import type { ToolName } from "../llm.ts";
import type { LlmDeployment } from "../llm-deployments.ts";

export type AgentId = "normal" | "tofu" | "guest" | "troll";
export type AgentModel = LlmDeployment;

export type AgentDefinition = {
  id: AgentId;
  name: string[];
  MODEL: AgentModel;
  tools: ToolName[];
  usesMemory?: boolean;
  buildInstructions: (chatId: number) => string;
};
