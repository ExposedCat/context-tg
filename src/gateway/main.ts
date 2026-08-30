import { loadGatewayConfig } from "./config.ts";
import { LoylexDatabase } from "./database.ts";
import { stopResultMessage } from "./presentation.ts";
import { GatewayServer } from "./server.ts";
import { sendTasks } from "./tasks.ts";
import { TelegramClient } from "./telegram.ts";
import { detectTrigger, isStopCommand, isTasksCommand } from "./triggers.ts";

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

async function poll(): Promise<void> {
  while (!stopping) {
    try {
      const updates = await telegram.getUpdates(offset, config.pollTimeoutSeconds);
      for (const update of updates) {
        const message = database.archiveUpdate(update);
        offset = update.update_id + 1;
        if (!message || message.from?.is_bot) {
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
            replyTo: message.message_id,
            threadId: message.message_thread_id ?? null,
          });
          continue;
        }
        if (isTasksCommand(message, bot.username)) {
          await sendTasks(database, telegram, message);
          continue;
        }
        const trigger = detectTrigger(message, bot.id);
        if (!trigger) {
          continue;
        }
        const resumeThreadId = database.resumeThread(
          message.chat.id,
          message.reply_to_message?.message_id,
        );
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
