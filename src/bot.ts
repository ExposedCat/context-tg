import { createDebug } from "@grammyjs/debug";
import { Bot, type Context as GrammyContext, type Transformer } from "grammy";
import { I18n, type I18nFlavor } from "grammy-i18n";
import { run } from "grammy-runner";
import {
  chatComposer,
  safelyMaybeSendProactiveAgentResponse,
} from "./features/chat.ts";
import type { Database } from "./features/database.ts";
import {
  createEmojiPackTransformer,
  emojiPacksComposer,
} from "./features/emoji-packs.ts";
import {
  messagesComposer,
  setIndexedTextMessageHandler,
} from "./features/messages.ts";
import { startScheduleDispatcher } from "./features/schedules.ts";
import { stateComposer } from "./features/state.ts";
import { safelyMaybeSendPeriodicTroll } from "./features/trolling.ts";
import { delay } from "./utils/async.ts";

const RUNNER_CONCURRENCY = 500;
const TELEGRAM_RATE_LIMIT_RETRY_DELAY_MS = 3000;
const TELEGRAM_RATE_LIMIT_MAX_RETRIES = 5;
const BOT_COMMANDS = [
  { command: "configure", description: "Configure chat settings" },
  { command: "debug", description: "Toggle debug details" },
  { command: "stickers", description: "List sticker packs" },
  { command: "packs", description: "List emoji packs" },
  { command: "tasks", description: "Show recent tasks" },
  { command: "schedule", description: "Show scheduled messages" },
  { command: "usage", description: "Show usage quotas" },
] as const;

const logDebug = createDebug("app:bot:debug");
const logError = createDebug("app:bot:error");

export type Context = GrammyContext &
  I18nFlavor & {
    database: Database;
  };

function createTelegramRateLimitRetryTransformer(): Transformer {
  return async (prev, method, payload, signal) => {
    for (
      let retries = 0;
      retries <= TELEGRAM_RATE_LIMIT_MAX_RETRIES;
      retries++
    ) {
      const response = await prev(method, payload, signal);

      if (
        response.ok ||
        response.error_code !== 429 ||
        retries === TELEGRAM_RATE_LIMIT_MAX_RETRIES
      ) {
        return response;
      }

      logDebug("Telegram rate limit hit, retrying API request", {
        method,
        retry: retries + 1,
        maxRetries: TELEGRAM_RATE_LIMIT_MAX_RETRIES,
        delayMs: TELEGRAM_RATE_LIMIT_RETRY_DELAY_MS,
      });

      await delay(
        TELEGRAM_RATE_LIMIT_RETRY_DELAY_MS,
        signal,
        new Error("Telegram API retry aborted"),
      );
    }

    throw new Error("Telegram API retry loop exited unexpectedly");
  };
}

export function initBot(token: string, database: Database) {
  const bot = new Bot<Context>(token);
  bot.api.config.use(createTelegramRateLimitRetryTransformer());
  bot.api.config.use(createEmojiPackTransformer(database, bot.api));
  setIndexedTextMessageHandler(async (ctx, message, sender, chatId) => {
    await safelyMaybeSendPeriodicTroll(ctx, message, sender, chatId);
    await safelyMaybeSendProactiveAgentResponse(ctx, message, chatId);
  });

  const i18n = new I18n<Context>({
    directory: "locales",
    defaultLocale: "en",
  });

  bot.use((ctx, next) => {
    ctx.database = database;
    return next();
  });

  bot.use(i18n);

  bot.use(emojiPacksComposer);
  bot.use(stateComposer);
  bot.use(messagesComposer);
  bot.use(chatComposer);

  bot.catch((error) => logError("Grammy error", { error }));

  return async () => {
    await bot.init();
    await bot.api.setMyCommands(BOT_COMMANDS);
    await startScheduleDispatcher(database, bot.api);
    await bot.api.deleteWebhook({ drop_pending_updates: true });

    run(bot, {
      runner: { fetch: { allowed_updates: [] } },
      sink: { concurrency: RUNNER_CONCURRENCY },
    });
  };
}
