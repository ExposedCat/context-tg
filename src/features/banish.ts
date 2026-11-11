import { createDebug } from "@grammyjs/debug";
import { Composer } from "grammy";
import type { Context } from "../bot.ts";
import { canConfigureChat } from "./authorization.ts";
import type { Database } from "./database.ts";

type BanishMessage = {
  chat?: { type?: string; is_forum?: boolean };
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: {
    message_thread_id?: number;
    is_topic_message?: boolean;
  };
};

export type BanishedAutomaticResponsesTable = {
  chat_id: number;
  topic_id: number;
};

export async function migrateBanishedAutomaticResponses(database: Database) {
  await database.schema
    .createTable("banished_automatic_responses")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("topic_id", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("banished_automatic_responses_pk", [
      "chat_id",
      "topic_id",
    ])
    .execute();
}

function getBanishTopicId(message: BanishMessage): number {
  const reply = message.reply_to_message;
  const forum =
    message.chat?.type === "supergroup" &&
    (message.chat.is_forum === true ||
      message.is_topic_message === true ||
      reply?.is_topic_message === true);
  // General is topic 1, including messages where Telegram omits its ID.
  // Ordinary reply-chain IDs and private chat topics do not narrow the ban.
  return forum
    ? (message.message_thread_id ?? reply?.message_thread_id ?? 1)
    : 0;
}

export async function banishAutomaticResponses(
  database: Database,
  chatId: number,
  message: BanishMessage,
): Promise<void> {
  await database
    .insertInto("banished_automatic_responses")
    .values({ chat_id: chatId, topic_id: getBanishTopicId(message) })
    .onConflict((conflict) =>
      conflict.columns(["chat_id", "topic_id"]).doNothing(),
    )
    .execute();
}

export async function areAutomaticResponsesBanished(
  database: Database,
  chatId: number,
  message: BanishMessage,
): Promise<boolean> {
  const row = await database
    .selectFrom("banished_automatic_responses")
    .select("chat_id")
    .where("chat_id", "=", chatId)
    .where("topic_id", "=", getBanishTopicId(message))
    .executeTakeFirst();
  return row !== undefined;
}

const logError = createDebug("app:banish:error");
export const banishComposer = new Composer<Context>();

// Match manually typed commands too, but never consume another bot's command.
banishComposer.hears(/^\/banish(?:@([\w]+))?\s*$/i, async (ctx, next) => {
  const username = ctx.match[1];
  if (username && username.toLowerCase() !== ctx.me.username.toLowerCase()) {
    await next();
    return;
  }
  if (!ctx.from || ctx.from.is_bot) return;

  const message = ctx.message;
  if (!message) return;
  if (message.ephemeral_message_id === undefined && message.message_id > 0) {
    try {
      await ctx.deleteMessage();
    } catch (error) {
      logError("Could not delete the public banish command", { error });
    }
  }

  const allowed = ctx.chat.type === "private" || (await canConfigureChat(ctx));
  if (allowed) {
    await banishAutomaticResponses(ctx.database, ctx.chat.id, message);
  }
  await ctx.reply(
    ctx.t(allowed ? "banish-confirmation" : "settings-admin-warning-chat"),
    {
      ephemeral_message_parameters: { receiver_user_id: ctx.from.id },
      ...(message.message_thread_id !== undefined
        ? { message_thread_id: message.message_thread_id }
        : {}),
      ...(message.ephemeral_message_id !== undefined
        ? {
            reply_parameters: {
              ephemeral_message_id: message.ephemeral_message_id,
            },
          }
        : {}),
    },
  );
});
