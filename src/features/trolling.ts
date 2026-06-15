import { createDebug } from "@grammyjs/debug";
import { sql } from "@kysely/kysely";
import type { Context } from "../bot.ts";
import { trollAgent } from "./agents/index.ts";
import type { Database } from "./database.ts";
import { readLastMessages } from "./last-messages.ts";
import { requestLlm } from "./llm.ts";
import { isTrollingEnabled } from "./llm-models.ts";
import type { MessageMetadata } from "./messages.ts";

type Sender = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
};

export type ChatTrollingTable = {
  chat_id: number;
  message_count: number;
};

const logError = createDebug("app:trolling:error");

const TROLLING_INTERVAL_MESSAGE_COUNT = 100;
const TROLLING_CONTEXT_MESSAGE_COUNT = 11;

export async function migrateTrolling(database: Database) {
  await database.schema
    .createTable("chat_trolling")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.primaryKey().notNull())
    .addColumn("message_count", "integer", (column) =>
      column.notNull().defaultTo(0),
    )
    .execute();
}

function formatSenderName(sender: Sender): string {
  const name = [sender.first_name, sender.last_name].filter(Boolean).join(" ");
  if (name && sender.username) {
    return `${name} (@${sender.username})`;
  }

  return name || (sender.username ? `@${sender.username}` : String(sender.id));
}

function formatContextMessage(message: MessageMetadata): string {
  const content = message.text.replaceAll(/\s+/g, " ").trim();
  return `[${message.message_id}] ${message.sender_name}: ${JSON.stringify(
    content,
  )}`;
}

async function incrementTrollingMessageCount(
  database: Database,
  chatId: number,
): Promise<number> {
  return await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("chat_trolling")
      .values({ chat_id: chatId, message_count: 0 })
      .onConflict((conflict) => conflict.column("chat_id").doNothing())
      .execute();

    await transaction
      .updateTable("chat_trolling")
      .set({ message_count: sql<number>`message_count + 1` })
      .where("chat_id", "=", chatId)
      .execute();

    const row = await transaction
      .selectFrom("chat_trolling")
      .select("message_count")
      .where("chat_id", "=", chatId)
      .executeTakeFirst();

    return row?.message_count ?? 0;
  });
}

function shouldTriggerTrolling(messageCount: number): boolean {
  return (
    messageCount > 0 && messageCount % TROLLING_INTERVAL_MESSAGE_COUNT === 0
  );
}

function buildTrollingRequest(
  targetName: string,
  messages: MessageMetadata[],
): string {
  return [
    `Troll the last user by name: ${targetName}.`,
    "The final context message is the trigger message. Roast that user's last message, not the whole chat.",
    "Never answer the message seriously. Keep it extremely short.",
    "",
    "Chat context, oldest to newest:",
    messages.map(formatContextMessage).join("\n"),
  ].join("\n");
}

export async function maybeSendPeriodicTroll(
  ctx: Context,
  message: { message_id: number; message_thread_id?: number },
  sender: Sender,
  chatId: number,
): Promise<void> {
  if (!isTrollingEnabled()) {
    return;
  }

  const messageCount = await incrementTrollingMessageCount(
    ctx.database,
    chatId,
  );

  if (!shouldTriggerTrolling(messageCount)) {
    return;
  }

  const messages = await readLastMessages(TROLLING_CONTEXT_MESSAGE_COUNT, {
    chatId,
    messageId: message.message_id,
    threadId: message.message_thread_id,
  });

  if (messages.length === 0) {
    return;
  }

  const response = await requestLlm(
    buildTrollingRequest(formatSenderName(sender), messages),
    [],
    undefined,
    {
      context: {
        chatId,
        messageId: message.message_id,
        threadId: message.message_thread_id,
      },
    },
    trollAgent.buildInstructions(),
    trollAgent.MODEL,
  );

  const text = response.response?.trim();

  if (!text) {
    return;
  }

  await ctx.reply(text, {
    link_preview_options: { is_disabled: true },
    reply_parameters: {
      message_id: message.message_id,
    },
  });
}

export async function safelyMaybeSendPeriodicTroll(
  ctx: Context,
  message: { message_id: number; message_thread_id?: number },
  sender: Sender,
  chatId: number,
): Promise<void> {
  try {
    await maybeSendPeriodicTroll(ctx, message, sender, chatId);
  } catch (error) {
    logError("Failed to send periodic troll response", { error });
  }
}
