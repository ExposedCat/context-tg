import type { ColumnType, Selectable } from "@kysely/kysely";
import type OpenAI from "@openai/openai";
import type { Database } from "./database.ts";

type ChatCompletionMessageParam = OpenAI.Chat.ChatCompletionMessageParam;

export type LlmChatResponsesTable = {
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

export type LlmChatResponse = Selectable<LlmChatResponsesTable>;

export async function migrateLlmChatResponses(database: Database) {
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

function parseMessages(
  value: string,
): ChatCompletionMessageParam[] | undefined {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? (parsed as ChatCompletionMessageParam[])
      : undefined;
  } catch {
    return undefined;
  }
}

export async function getLlmChatResponseMessages(
  database: Database,
  responseId: string,
): Promise<ChatCompletionMessageParam[] | undefined> {
  const row = await database
    .selectFrom("llm_chat_responses")
    .select("messages")
    .where("response_id", "=", responseId)
    .executeTakeFirst();

  return row ? parseMessages(row.messages) : undefined;
}

export async function saveLlmChatResponseMessages(
  database: Database,
  response: {
    responseId: string;
    previousResponseId?: string | null;
    messages: ChatCompletionMessageParam[];
  },
): Promise<void> {
  const now = new Date().toISOString();
  const messages = JSON.stringify(response.messages);
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
