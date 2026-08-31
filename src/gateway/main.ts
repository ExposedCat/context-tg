import type { TelegramMessage } from "../shared/types.ts";
import { loadGatewayConfig } from "./config.ts";
import { LoylexDatabase } from "./database.ts";
import { responseOptions } from "./message-options.ts";
import { helpMessage, resumeUnavailableMessage, stopResultMessage } from "./presentation.ts";
import { GatewayServer } from "./server.ts";
import { sendTasks } from "./tasks.ts";
import { TelegramClient } from "./telegram.ts";
import {
  cancelTaskMessageId,
  detectTrigger,
  isHelpCommand,
  isNewChatCommand,
  isStopCommand,
  isTasksCommand,
  newChatPrompt,
  resumeTaskMessageId,
} from "./triggers.ts";

const config = loadGatewayConfig();
const database = new LoylexDatabase(config.databasePath);
const telegram = new TelegramClient(config.botToken);
const bot = await telegram.getMe();
const server = new GatewayServer(config, database, telegram);

await telegram.call("deleteWebhook", { drop_pending_updates: false });
await telegram.setCommands();
server.start();

let stopping = false;
let offset = database.nextUpdateOffset();

function acknowledgeWork(message: TelegramMessage): void {
  void Promise.allSettled([
    telegram.sendTyping(message.chat.id, message.message_thread_id ?? null),
    telegram.setThinkingReaction(message.chat.id, message.message_id),
  ]).then((results) => {
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      console.log(
        JSON.stringify({
          level: "warn",
          component: "poller",
          event: "telegram_activity_unavailable",
          messageId: message.message_id,
          failures: failures.map((result) =>
            result.reason instanceof Error ? result.reason.message : String(result.reason),
          ),
        }),
      );
    }
  });
}

async function poll(): Promise<void> {
  while (!stopping) {
    try {
      const updates = await telegram.getUpdates(offset, config.pollTimeoutSeconds);
      for (const update of updates) {
        const message = database.archiveUpdate(update);
        offset = update.update_id + 1;
        const stopped = update.stopped_message_generation;
        if (stopped && Number.isSafeInteger(stopped.draft_id)) {
          const cancelledJobIds = database.cancelJobsForDraft(stopped.chat.id, stopped.draft_id);
          if (cancelledJobIds.length > 0) {
            console.log(
              JSON.stringify({
                level: "info",
                component: "poller",
                event: "draft_jobs_cancelled",
                jobIds: cancelledJobIds,
              }),
            );
          }
          await telegram.sendRich(
            stopped.chat.id,
            stopResultMessage(cancelledJobIds.length),
            responseOptions(stopped.chat.type, undefined, stopped.message_thread_id ?? null),
          );
          continue;
        }
        if (!message || message.from?.is_bot) {
          continue;
        }
        const cancelledMessageId = cancelTaskMessageId(message, bot.username);
        if (cancelledMessageId !== null) {
          const cancelledJobIds = database.cancelJobsForMessage(
            message.chat.id,
            cancelledMessageId,
          );
          if (cancelledJobIds.length > 0) {
            console.log(
              JSON.stringify({
                level: "info",
                component: "poller",
                event: "jobs_cancelled",
                jobIds: cancelledJobIds,
              }),
            );
          }
          await telegram.sendRich(message.chat.id, stopResultMessage(cancelledJobIds.length), {
            ...responseOptions(
              message.chat.type,
              message.message_id,
              message.message_thread_id ?? null,
            ),
          });
          continue;
        }
        if (isStopCommand(message, bot.id, bot.username)) {
          const cancelledJobIds = message.reply_to_message
            ? database.cancelJobsForMessage(message.chat.id, message.reply_to_message.message_id)
            : [];
          if (cancelledJobIds.length > 0) {
            console.log(
              JSON.stringify({
                level: "info",
                component: "poller",
                event: "jobs_cancelled",
                jobIds: cancelledJobIds,
              }),
            );
          }
          await telegram.sendRich(message.chat.id, stopResultMessage(cancelledJobIds.length), {
            ...responseOptions(
              message.chat.type,
              message.message_id,
              message.message_thread_id ?? null,
            ),
          });
          continue;
        }
        if (isTasksCommand(message, bot.username)) {
          await sendTasks(database, telegram, message);
          continue;
        }
        if (isHelpCommand(message, bot.username)) {
          await telegram.sendRich(message.chat.id, helpMessage(), {
            ...responseOptions(
              message.chat.type,
              message.message_id,
              message.message_thread_id ?? null,
            ),
          });
          continue;
        }
        const resumeMessageId = resumeTaskMessageId(message, bot.username);
        if (resumeMessageId !== null) {
          const resumeThreadId = database.resumableThread(message.chat.id, resumeMessageId);
          if (resumeThreadId === null) {
            await telegram.sendRich(message.chat.id, resumeUnavailableMessage(), {
              ...responseOptions(
                message.chat.type,
                message.message_id,
                message.message_thread_id ?? null,
              ),
            });
          } else {
            acknowledgeWork(message);
            database.enqueue(
              update.update_id,
              message,
              "Продолжи предыдущую задачу с того места, где она остановилась.",
              resumeThreadId,
            );
          }
          continue;
        }
        if (message.chat.type === "private" && isNewChatCommand(message)) {
          const prompt = newChatPrompt(message, bot.username);
          if (prompt !== null) {
            acknowledgeWork(message);
            database.enqueue(update.update_id, message, prompt, null);
          }
          continue;
        }
        const trigger = detectTrigger(message, bot.id);
        if (!trigger) {
          continue;
        }
        acknowledgeWork(message);
        const repliedThreadId = database.resumeThread(
          message.chat.id,
          message.reply_to_message?.message_id,
        );
        const resumeThreadId =
          repliedThreadId ??
          (message.chat.type === "private" ? database.latestThread(message.chat.id) : null);
        database.enqueue(update.update_id, message, trigger.prompt, resumeThreadId);
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          component: "poller",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      await Bun.sleep(2_000);
    }
  }
}

function shutdown(): void {
  stopping = true;
  server.stop();
  database.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(JSON.stringify({ level: "info", bot: bot.username, offset }));
await poll();
