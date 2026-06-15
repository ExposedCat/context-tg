import type { FunctionToolRunner, LlmToolContext } from "./types.ts";

export const toolDefinition = {
  type: "function",
  name: "call_agent",
  description:
    "Delegate a bounded subtask to another focused agent and return its result. Available agents are normal, trader, researcher, and politician. Use this only when a focused agent is better suited for part of the user's request.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: ["normal", "trader", "researcher", "politician"],
        description: "The focused agent to call.",
      },
      task: {
        type: "string",
        description:
          "A clear self-contained task for the target agent. Include relevant constraints and expected output.",
      },
    },
    required: ["agent", "task"],
    additionalProperties: false,
  },
  strict: true,
} as const;

export function createRunner(
  delegate: (
    agentId: string,
    task: string,
    context?: LlmToolContext,
    signal?: AbortSignal,
  ) => ReturnType<FunctionToolRunner>,
): FunctionToolRunner {
  return async (args, context, options) => {
    const agentId = typeof args?.agent === "string" ? args.agent : "";
    const task = typeof args?.task === "string" ? args.task.trim() : "";

    if (!agentId || !task) {
      return JSON.stringify({ error: "agent and task must not be empty." });
    }

    return await delegate(agentId, task, context, options?.signal);
  };
}
