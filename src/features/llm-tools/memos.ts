import {
  forgetMemo,
  type Memo,
  MemoValidationError,
  saveMemo,
} from "../memos.ts";
import type { FunctionToolRunner } from "./types.ts";
import {
  getFiniteNumber,
  getMissingContextResponse,
  getMissingDatabaseResponse,
  getString,
} from "./utils.ts";

export const saveMemoToolDefinition = {
  type: "function",
  name: "remember",
  description:
    "Remember a long-term memo about something that is useful to always know cross-dialog. Only you see memos, so use it as own memory in your brain. Always use this to remember long-term facts when asked or when you think of something long-term important to remember.",
  parameters: {
    type: "object",
    properties: {
      memo: {
        type: "string",
        description: "The concise memo text to remember long-term.",
      },
    },
    required: ["memo"],
    additionalProperties: false,
  },
  strict: true,
} as const;

export const forgetMemoToolDefinition = {
  type: "function",
  name: "forget",
  description:
    "Forget one of your current memories from your head. Use ID from the # Memos metadata section.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The stable numeric memo id to remove.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  strict: true,
} as const;

function formatMemo(memo: Memo): Record<string, unknown> {
  return {
    id: memo.id,
    agent: memo.agent_id,
    memo: memo.text,
    created_at: memo.created_at,
  };
}

function formatMemoError(error: unknown, action: string): string {
  if (error instanceof MemoValidationError) {
    return `Cannot ${action}: ${error.message}`;
  }

  const details = error instanceof Error ? error.message : String(error);
  return `Cannot ${action}: ${details}`;
}

export const executeSaveMemo: FunctionToolRunner = async (
  args,
  context,
  options,
) => {
  const missingContext = getMissingContextResponse("save memo", context);
  if (missingContext || !context) {
    return missingContext ?? "";
  }

  const missingDatabase = getMissingDatabaseResponse(
    "save memo",
    options?.database,
  );
  if (missingDatabase || !options?.database) {
    return missingDatabase ?? "";
  }

  if (!options.agentId) {
    return "Cannot save memo: agent context is unavailable.";
  }

  try {
    const memo = await saveMemo(
      options.database,
      context.chatId,
      options.agentId,
      getString(args?.memo),
    );

    return JSON.stringify({
      saved: formatMemo(memo),
    });
  } catch (error) {
    return formatMemoError(error, "save memo");
  }
};

export const executeForgetMemo: FunctionToolRunner = async (
  args,
  context,
  options,
) => {
  const missingContext = getMissingContextResponse("forget memo", context);
  if (missingContext || !context) {
    return missingContext ?? "";
  }

  const missingDatabase = getMissingDatabaseResponse(
    "forget memo",
    options?.database,
  );
  if (missingDatabase || !options?.database) {
    return missingDatabase ?? "";
  }

  if (!options.agentId) {
    return "Cannot forget memo: agent context is unavailable.";
  }

  const id = getFiniteNumber(args?.id);
  if (id === undefined || !Number.isInteger(id) || id < 1) {
    return "Cannot forget memo: id must be a positive integer.";
  }

  const removed = await forgetMemo(
    options.database,
    context.chatId,
    options.agentId,
    id,
  );

  return JSON.stringify({
    id,
    removed,
  });
};
