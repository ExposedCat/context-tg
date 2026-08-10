import type { ColumnType, Selectable } from "@kysely/kysely";
import type OpenAI from "@openai/openai";
import type { Database } from "./database.ts";

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

// The SQLite table name is retained so existing installations keep their history.
export type LlmResponseHistoryTable = {
  response_id: string;
  previous_response_id: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  messages: string;
  created_at: string;
  updated_at: string;
};

export type LlmResponseHistory = Selectable<LlmResponseHistoryTable>;

export async function migrateLlmResponseHistory(database: Database) {
  await database.schema
    .createTable("llm_chat_responses")
    .ifNotExists()
    .addColumn("response_id", "text", (column) => column.primaryKey().notNull())
    .addColumn("previous_response_id", "text")
    .addColumn("messages", "text", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.notNull())
    .addColumn("updated_at", "text", (column) => column.notNull())
    .execute();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getLegacyTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = value
    .flatMap((part) => {
      if (!isRecord(part)) {
        return [];
      }

      if (part.type === "text" && typeof part.text === "string") {
        return [part.text];
      }

      if (part.type === "refusal" && typeof part.refusal === "string") {
        return [part.refusal];
      }

      return [];
    })
    .join("");

  return text || undefined;
}

function getImageDetail(value: unknown): "low" | "high" | "auto" | "original" {
  return value === "low" ||
    value === "high" ||
    value === "auto" ||
    value === "original"
    ? value
    : "auto";
}

function convertLegacyUserContent(
  value: unknown,
): OpenAI.Responses.ResponseInputMessageContentList | string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const content: OpenAI.Responses.ResponseInputMessageContentList = [];

  for (const part of value) {
    if (!isRecord(part)) {
      continue;
    }

    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "input_text", text: part.text });
      continue;
    }

    if (part.type !== "image_url" || !isRecord(part.image_url)) {
      continue;
    }

    const imageUrl = part.image_url.url;
    if (typeof imageUrl !== "string") {
      continue;
    }

    content.push({
      type: "input_image",
      image_url: imageUrl,
      detail: getImageDetail(part.image_url.detail),
    });
  }

  return content.length > 0 ? content : undefined;
}

function convertLegacyFunctionCalls(value: unknown): ResponseInputItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: ResponseInputItem[] = [];

  for (const call of value) {
    if (
      !isRecord(call) ||
      call.type !== "function" ||
      typeof call.id !== "string" ||
      !isRecord(call.function) ||
      typeof call.function.name !== "string" ||
      typeof call.function.arguments !== "string"
    ) {
      continue;
    }

    items.push({
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }

  return items;
}

function convertLegacyChatMessage(value: unknown): ResponseInputItem[] {
  if (!isRecord(value) || typeof value.role !== "string") {
    return [];
  }

  if (value.role === "tool") {
    const output = getLegacyTextContent(value.content);
    return typeof value.tool_call_id === "string" && output !== undefined
      ? [
          {
            type: "function_call_output",
            call_id: value.tool_call_id,
            output,
          },
        ]
      : [];
  }

  if (value.role === "assistant") {
    const items: ResponseInputItem[] = [];
    const content =
      getLegacyTextContent(value.content) ??
      (typeof value.refusal === "string" ? value.refusal : undefined);

    if (content !== undefined) {
      items.push({ type: "message", role: "assistant", content });
    }

    items.push(...convertLegacyFunctionCalls(value.tool_calls));
    return items;
  }

  if (
    value.role !== "user" &&
    value.role !== "system" &&
    value.role !== "developer"
  ) {
    return [];
  }

  const content = convertLegacyUserContent(value.content);
  return content === undefined
    ? []
    : [{ type: "message", role: value.role, content }];
}

export function parseLlmResponseInputItems(
  value: string,
): ResponseInputItem[] | undefined {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    return parsed.flatMap((item) => {
      if (isRecord(item) && typeof item.type === "string") {
        return [item as unknown as ResponseInputItem];
      }

      return convertLegacyChatMessage(item);
    });
  } catch {
    return undefined;
  }
}

export async function getLlmResponseInputItems(
  database: Database,
  responseId: string,
): Promise<ResponseInputItem[] | undefined> {
  const row = await database
    .selectFrom("llm_chat_responses")
    .select("messages")
    .where("response_id", "=", responseId)
    .executeTakeFirst();

  return row ? parseLlmResponseInputItems(row.messages) : undefined;
}

export async function saveLlmResponseInputItems(
  database: Database,
  response: {
    responseId: string;
    previousResponseId?: string | null;
    inputItems: ResponseInputItem[];
  },
): Promise<void> {
  const now = new Date().toISOString();
  const messages = JSON.stringify(response.inputItems);
  const previous_response_id = response.previousResponseId ?? null;

  await database
    .insertInto("llm_chat_responses")
    .values({
      response_id: response.responseId,
      previous_response_id,
      messages,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict.column("response_id").doUpdateSet({
        previous_response_id,
        messages,
        updated_at: now,
      }),
    )
    .execute();
}
