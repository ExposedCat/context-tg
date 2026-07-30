import { createDebug } from "@grammyjs/debug";
import { InputFile } from "grammy";
import type { Context } from "../bot.ts";
import { encodeLlmInputDump, type LlmInputDump } from "./llm-debug.ts";

const logError = createDebug("app:llm-debug:error");

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function sendLlmInputDump(
  ctx: Context,
  chatId: number,
  messageId: number,
  dump: LlmInputDump,
): Promise<void> {
  if (dump.length === 0) {
    return;
  }

  try {
    await ctx.replyWithDocument(
      new InputFile(
        encodeLlmInputDump(dump),
        `llm-inputs-${chatId}-${messageId}.jsonl`,
      ),
      {
        reply_parameters: { message_id: messageId },
      },
    );
  } catch (error) {
    logError("Failed to send LLM input dump:", {
      chatId,
      messageId,
      error: getErrorMessage(error),
    });

    try {
      await ctx.reply("Failed to send LLM input dump.", {
        reply_parameters: { message_id: messageId },
      });
    } catch (replyError) {
      logError("Failed to report LLM input dump error:", {
        chatId,
        messageId,
        error: getErrorMessage(replyError),
      });
    }
  }
}
