import { createDebug } from "@grammyjs/debug";
import { sql } from "@kysely/kysely";
import type { Context } from "../bot.ts";
import { trollAgent } from "./agents/index.ts";
import type { Database } from "./database.ts";
import { readLastMessages } from "./last-messages.ts";
import { requestLlm, requestTrollingValidation } from "./llm.ts";
import {
  formatPromptMessageXml,
  formatSystemPromptMessageXml,
  getPromptDateTimeFromEpochSeconds,
} from "./llm-prompt.ts";
import type { MessageMetadata } from "./messages.ts";
import { createLlmCallTelemetry } from "./telemetry.ts";
import { DEFAULT_TROLLING_MODE, parseStoredTrollingMode, type TrollingMode } from "./trolling-mode.ts";
import { createCreditCharge, hasUsageRemaining } from "./usage.ts";

type Sender = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
};

export type ChatTrollingTable = {
  chat_id: number;
  message_count: number;
  interval_message_count: number;
  enabled: number;
  trolling_mode: TrollingMode;
};

export type TrollingSettings = {
  enabled: boolean;
  intervalMessageCount: number;
  mode: TrollingMode;
};

const logError = createDebug("app:trolling:error");

export const DEFAULT_TROLLING_INTERVAL_MESSAGE_COUNT = 100;
const TROLLING_CONTEXT_MESSAGE_COUNT = 11;

export async function migrateTrolling(database: Database) {
  await database.schema
    .createTable("chat_trolling")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.primaryKey().notNull())
    .addColumn("message_count", "integer", (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn("interval_message_count", "integer", (column) =>
      column.notNull().defaultTo(DEFAULT_TROLLING_INTERVAL_MESSAGE_COUNT),
    )
    .addColumn("enabled", "integer", (column) => column.notNull().defaultTo(1))
    .addColumn(
      "trolling_mode",
      "text",
      (column) => column.notNull().defaultTo(DEFAULT_TROLLING_MODE),
    )
    .execute();

  try {
    await database.schema
      .alterTable("chat_trolling")
      .addColumn("interval_message_count", "integer", (column) =>
        column.notNull().defaultTo(DEFAULT_TROLLING_INTERVAL_MESSAGE_COUNT),
      )
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
  }

  const tables = await database.introspection.getTables();
  const table = tables.find((table) => table.name === "chat_trolling");
  if (!table) throw new Error("chat_trolling table is missing after migration");
  if (!table.columns.some((column) => column.name === "trolling_mode")) {
    await database.transaction().execute(async (transaction) => {
      await transaction.schema
        .alterTable("chat_trolling")
        .addColumn(
          "trolling_mode",
          "text",
          (column) => column.notNull().defaultTo(DEFAULT_TROLLING_MODE),
        )
        .execute();
      if (table.columns.some((column) => column.name === "allow_insults")) {
        const invalid = await sql`select chat_id from chat_trolling where allow_insults not in (0, 1) or allow_insults is null limit 1`.execute(transaction);
        if (invalid.rows.length) {
          throw new Error("Cannot migrate invalid chat_trolling.allow_insults; expected 0 or 1");
        }
        // Upgrade the previously stored two-mode preference once, atomically.
        await sql`update chat_trolling set trolling_mode = case when allow_insults = 1 then 'mild' else 'clean' end`.execute(transaction);
      }
    });
  }

  try {
    await database.schema
      .alterTable("chat_trolling")
      .addColumn("enabled", "integer", (column) =>
        column.notNull().defaultTo(1),
      )
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
  }
}

function formatSenderName(sender: Sender): string {
  const name = [sender.first_name, sender.last_name].filter(Boolean).join(" ");
  if (name && sender.username) {
    return `${name} (@${sender.username})`;
  }

  return name || (sender.username ? `@${sender.username}` : String(sender.id));
}

function formatContextMessage(message: MessageMetadata): string {
  const dateTime = getPromptDateTimeFromEpochSeconds(message.date_timestamp);

  return formatPromptMessageXml(
    {
      id: message.message_id,
      sender: message.sender_name,
      sender_id: message.sender_id,
      media_group_id: message.media_group_id,
      date: dateTime?.date,
      time: dateTime?.time,
    },
    message.text.replaceAll(/\s+/g, " ").trim(),
  );
}

async function incrementTrollingMessageCount(
  database: Database,
  chatId: number,
): Promise<{ messageCount: number } & TrollingSettings> {
  return await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("chat_trolling")
      .values({
        chat_id: chatId,
        message_count: 0,
        interval_message_count: DEFAULT_TROLLING_INTERVAL_MESSAGE_COUNT,
        enabled: 1,
        trolling_mode: DEFAULT_TROLLING_MODE,
      })
      .onConflict((conflict) => conflict.column("chat_id").doNothing())
      .execute();

    await transaction
      .updateTable("chat_trolling")
      .set({ message_count: sql<number>`message_count + 1` })
      .where("chat_id", "=", chatId)
      .execute();

    const row = await transaction
      .selectFrom("chat_trolling")
      .select([
        "message_count",
        "interval_message_count",
        "enabled",
        "trolling_mode",
      ])
      .where("chat_id", "=", chatId)
      .executeTakeFirst();

    return {
      messageCount: row?.message_count ?? 0,
      enabled: row?.enabled !== 0,
      mode: row ? parseStoredTrollingMode(row.trolling_mode) : DEFAULT_TROLLING_MODE,
      intervalMessageCount: row?.interval_message_count ??
        DEFAULT_TROLLING_INTERVAL_MESSAGE_COUNT,
    };
  });
}

export async function setTrollingInterval(
  database: Database,
  chatId: number,
  intervalMessageCount: number,
): Promise<void> {
  await database
    .insertInto("chat_trolling")
    .values({
      chat_id: chatId,
      message_count: 0,
      interval_message_count: intervalMessageCount,
      enabled: 1,
      trolling_mode: DEFAULT_TROLLING_MODE,
    })
    .onConflict((conflict) =>
      conflict.column("chat_id").doUpdateSet({
        message_count: 0,
        interval_message_count: intervalMessageCount,
        enabled: 1,
      }),
    )
    .execute();
}

export async function setTrollingEnabled(
  database: Database,
  chatId: number,
  enabled: boolean,
): Promise<void> {
  await database
    .insertInto("chat_trolling")
    .values({
      chat_id: chatId,
      message_count: 0,
      interval_message_count: DEFAULT_TROLLING_INTERVAL_MESSAGE_COUNT,
      enabled: enabled ? 1 : 0,
      trolling_mode: DEFAULT_TROLLING_MODE,
    })
    .onConflict((conflict) =>
      conflict.column("chat_id").doUpdateSet({
        message_count: 0,
        enabled: enabled ? 1 : 0,
      }),
    )
    .execute();
}

export async function getTrollingSettings(
  database: Database,
  chatId: number,
): Promise<TrollingSettings> {
  const row = await database
    .selectFrom("chat_trolling")
    .select(["interval_message_count", "enabled", "trolling_mode"])
    .where("chat_id", "=", chatId)
    .executeTakeFirst();

  return {
    enabled: row?.enabled !== 0,
    mode: row ? parseStoredTrollingMode(row.trolling_mode) : DEFAULT_TROLLING_MODE,
    intervalMessageCount: row?.interval_message_count ??
      DEFAULT_TROLLING_INTERVAL_MESSAGE_COUNT,
  };
}

export async function setTrollingMode(
  database: Database,
  chatId: number,
  mode: TrollingMode,
): Promise<void> {
  parseStoredTrollingMode(mode);
  await database
    .insertInto("chat_trolling")
    .values({
      chat_id: chatId,
      message_count: 0,
      interval_message_count: DEFAULT_TROLLING_INTERVAL_MESSAGE_COUNT,
      enabled: 1,
      trolling_mode: mode,
    })
    .onConflict((conflict) =>
      conflict.column("chat_id").doUpdateSet({
        trolling_mode: mode,
      })
    )
    .execute();
}

function shouldTriggerTrolling(
  messageCount: number,
  enabled: boolean,
  intervalMessageCount: number,
): boolean {
  return (
    enabled &&
    messageCount > 0 &&
    intervalMessageCount > 0 &&
    messageCount % intervalMessageCount === 0
  );
}

function buildTrollingRequest(
  triggerSenderName: string,
  messages: MessageMetadata[],
): string[] {
  return [
    formatSystemPromptMessageXml(
      [
        `Write a trolling reply that fits the ongoing conversation, in the chat's configured trolling_mode. The request was triggered by the last message from ${triggerSenderName}.`,
        "The final context message is the trigger, not a required target. Choose one participant, statement, or situation from the recent conversation with a concrete hook for the joke. The person being teased can differ from the sender of the message you reply to. Make it clear who or what the joke concerns, and attribute statements to the person who actually made them.",
        "Reply to the message the joke is about. If it is an earlier context message, call set_reply_message_id with its exact id before your final response. For a joke about the shared situation without a specific target message, call set_reply_message_id with null to send without a reply. Never invent a message id.",
        "Use one brief, context-specific roast, joke, wordplay, or sarcastic observation. The trolling_mode setting determines whether profanity, name-calling, and aggressive roasting are allowed. Keep the reply relevant to the ongoing conversation; do not drag in unrelated people or invent facts to create a target.",
        "If the message expresses distress, grief, or asks to stop teasing, respond briefly and kindly without a joke.",
      ].join("\n"),
    ),
    ...messages.map(formatContextMessage),
  ];
}

export async function maybeSendPeriodicTroll(
  ctx: Context,
  message: { message_id: number; message_thread_id?: number },
  sender: Sender,
  chatId: number,
): Promise<void> {
  if (!(await hasUsageRemaining(ctx.database, chatId))) return;
  const { messageCount, enabled, intervalMessageCount } =
    await incrementTrollingMessageCount(ctx.database, chatId);

  if (!shouldTriggerTrolling(messageCount, enabled, intervalMessageCount)) {
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

  const chargeCredits = createCreditCharge(ctx);
  try {
    await chargeCredits("request");
  } catch {
    return;
  }
  const telemetry = createLlmCallTelemetry(
    ctx.chat?.type,
    "normal",
    ctx.telemetry.event,
  );
  const response = await requestLlm(
    buildTrollingRequest(formatSenderName(sender), messages),
    ["set_reply_message_id"],
    undefined,
    {
      database: ctx.database,
      context: {
        chatId,
        messageId: message.message_id,
        threadId: message.message_thread_id,
      },
      agentId: trollAgent.id,
      telemetry,
    },
    trollAgent.buildInstructions(chatId),
    trollAgent.MODEL,
  );

  const text = response.response?.trim();

  if (!text) {
    return;
  }

  const replyMessageId =
    response.replyMessageId === undefined
      ? message.message_id
      : response.replyMessageId;
  // Only attach to messages supplied from this chat and topic.
  if (
    replyMessageId !== null &&
    replyMessageId !== message.message_id &&
    !messages.some(
      (contextMessage) => contextMessage.message_id === replyMessageId,
    )
  )
    return;

  const { mode } = await getTrollingSettings(ctx.database, chatId);
  try {
    await chargeCredits("request");
  } catch {
    return;
  }
  const { valid } = await requestTrollingValidation(
    {
      messages: messages.map(formatContextMessage),
      candidate: text,
      mode,
      replyMessageId,
    },
    { telemetry },
  );
  if (!valid) return;

  await ctx.reply(text, {
    link_preview_options: { is_disabled: true },
    ...(message.message_thread_id !== undefined
      ? { message_thread_id: message.message_thread_id }
      : {}),
    ...(replyMessageId === null
      ? {}
      : { reply_parameters: { message_id: replyMessageId } }),
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
