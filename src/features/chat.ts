import { createDebug } from "@grammyjs/debug";
import { Composer } from "grammy";
import type { Context } from "../bot.ts";
import { APP_ENV } from "./env.ts";
import { requestLlm } from "./llm.ts";
import { createThread, getThread } from "./threads.ts";

type TextMessage = {
  message_id: number;
  text?: string;
  caption?: string;
  reply_to_message?: TextMessage;
};

const logError = createDebug("app:chat:error");

export const chatComposer = new Composer<Context>();

function getMessageText(message: TextMessage): string | undefined {
  return message.text ?? message.caption;
}

function isAddressed(text: string, ownUsername: string): boolean {
  const normalizedText = text.toLocaleLowerCase();
  const hasName = APP_ENV.NAMES.some((name) =>
    normalizedText.startsWith(name.toLocaleLowerCase()),
  );
  const hasOwnTag = normalizedText.startsWith(
    `@${ownUsername.toLocaleLowerCase()}`,
  );

  return hasName || hasOwnTag;
}

function buildRootRequest(text: string, replyText?: string): string {
  return replyText ? `${replyText}\n\n${text}` : text;
}

chatComposer.on("message", async (ctx, next) => {
  const message = ctx.message as TextMessage;
  const text = getMessageText(message);
  const reply = message.reply_to_message;
  const thread = reply
    ? await getThread(ctx.database, {
        chat_id: ctx.chat.id,
        message_id: reply.message_id,
      })
    : undefined;

  if (!text || (!isAddressed(text, ctx.me.username) && !thread)) {
    await next();
    return;
  }

  try {
    const llmResponse = thread?.response_id
      ? await requestLlm(text, ["web_search"], thread.response_id)
      : await requestLlm(
          buildRootRequest(text, reply && getMessageText(reply)),
          ["web_search"],
        );
    const sentMessage = await ctx.reply(
      llmResponse.response ?? "I could not generate a response.",
      {
        reply_parameters: {
          message_id: message.message_id,
        },
      },
    );

    if (!llmResponse.response_id) {
      return;
    }

    await createThread(ctx.database, {
      chat_id: ctx.chat.id,
      message_id: sentMessage.message_id,
      response_id: llmResponse.response_id,
    });
  } catch (error) {
    await ctx.reply("I could not generate a response");
    logError("Error handling message:", error);
    await next();
  }
});
