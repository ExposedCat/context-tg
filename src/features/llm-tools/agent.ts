import type { Database } from "../database.ts";
import type { FunctionToolRunner, LlmToolContext } from "./types.ts";
import { getJsonError, getString } from "./utils.ts";

export const toolDefinition = {
  type: "function",
  name: "call_agent",
  description:
    "Delegate a bounded subtask to another focused agent and return its result. Available agents are normal, tofu, guest, trader, researcher, politician, and troll. Use this only when a focused agent is better suited for part of the user's request.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: [
          "normal",
          "tofu",
          "guest",
          "trader",
          "researcher",
          "politician",
          "troll",
        ],
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
    database?: Database,
  ) => ReturnType<FunctionToolRunner>,
): FunctionToolRunner {
  return async (args, context, options) => {
    const agentId = getString(args?.agent);
    const task = getString(args?.task);

    if (!agentId || !task) {
      return getJsonError("agent and task must not be empty.");
    }

    return await delegate(
      agentId,
      task,
      context,
      options?.signal,
      options?.database,
    );
  };
}
