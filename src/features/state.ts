import { Composer } from "grammy";
import type { Context } from "../bot.ts";
import { replyWithResumeTask } from "./chat.ts";
import { APP_ENV } from "./env.ts";
import {
  getReasoningEffort,
  getWebSearchSetting,
  isWebSearchSetting,
  parseReasoningSetting,
  persistReasoningEffort,
  persistWebSearchSetting,
} from "./llm-models.ts";
import { replyWithCancelTask, replyWithRecentTasks } from "./tasks.ts";
import {
  formatUsageSnapshot,
  getUsageDate,
  getUsageSnapshot,
  parseUsageKey,
  setUsageQuota,
  USAGE_KEYS,
} from "./usage.ts";

export const stateComposer = new Composer<Context>();

const REASONING_OPTIONS = [
  "null",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

const WEB_SEARCH_OPTIONS = ["off", "low", "medium", "high"] as const;

type SettingsKeyboardButton = {
  text: string;
  callback_data: string;
  style?: "success";
};

type SettingsKeyboardMarkup = {
  inline_keyboard: SettingsKeyboardButton[][];
};

function getUsageCommandUsage(): string {
  return ["Usage: /usage", `Usage: /usage ${USAGE_KEYS.join("|")} QUOTA`].join(
    "\n",
  );
}

function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === APP_ENV.ADMIN_ID;
}

function formatReasoningSettingLabel(value: string): string {
  return value === "null" ? "null" : value;
}

function buildSettingsKeyboard(
  options: readonly string[],
  current: string,
  callbackPrefix: string,
): SettingsKeyboardMarkup {
  const rows: SettingsKeyboardButton[][] = [];
  let row: SettingsKeyboardButton[] = [];

  for (const [index, option] of options.entries()) {
    row.push({
      text: formatReasoningSettingLabel(option),
      callback_data: `${callbackPrefix}:${option}`,
      ...(option === current ? { style: "success" } : {}),
    });

    if (index % 3 === 2) {
      rows.push(row);
      row = [];
    }
  }

  if (row.length > 0) {
    rows.push(row);
  }

  return { inline_keyboard: rows };
}

function buildReasoningKeyboard(): SettingsKeyboardMarkup {
  return buildSettingsKeyboard(
    REASONING_OPTIONS,
    getReasoningEffort() ?? "null",
    "reasoning",
  );
}

function buildWebSearchKeyboard(): SettingsKeyboardMarkup {
  return buildSettingsKeyboard(
    WEB_SEARCH_OPTIONS,
    getWebSearchSetting(),
    "websearch",
  );
}

stateComposer.chatType("private").command("start", async (ctx) => {
  await ctx.reply(ctx.t("start", { name: ctx.from.first_name }));
});

stateComposer.chatType("private").command("stop", async (ctx) => {
  await ctx.reply(ctx.t("stop", { name: ctx.from.first_name }));
});

stateComposer.command("tasks", async (ctx) => {
  await replyWithRecentTasks(ctx);
});

stateComposer.command("usage", async (ctx) => {
  if (!ctx.chat) {
    return;
  }

  const args = typeof ctx.match === "string" ? ctx.match.trim() : "";

  if (!args) {
    const usageDate = getUsageDate();
    const snapshot = await getUsageSnapshot(
      ctx.database,
      ctx.chat.id,
      usageDate,
    );

    await ctx.reply(formatUsageSnapshot(snapshot, usageDate));
    return;
  }

  if (ctx.from?.id !== APP_ENV.ADMIN_ID) {
    await ctx.reply("Only the admin can set usage quotas.");
    return;
  }

  const [rawKey, rawQuota, ...extraParts] = args.split(/\s+/);
  const key = rawKey ? parseUsageKey(rawKey) : undefined;
  const quota = rawQuota ? Number(rawQuota) : Number.NaN;

  if (!key || extraParts.length > 0 || !Number.isInteger(quota) || quota < 0) {
    await ctx.reply(getUsageCommandUsage());
    return;
  }

  const status = await setUsageQuota(ctx.database, ctx.chat.id, key, quota);

  await ctx.reply(`Updated ${status.key} quota to ${status.quota}`);
});

stateComposer.on("message:text", async (ctx, next) => {
  const match = ctx.message.text.match(
    /^\/(cancel|resume)_(\d+)(?:@\w+)?(?:\s|$)/,
  );

  if (!match) {
    await next();
    return;
  }

  const messageId = Number(match[2]);

  if (match[1] === "resume") {
    await replyWithResumeTask(ctx, messageId);
    return;
  }

  await replyWithCancelTask(ctx, messageId);
});

stateComposer.hears(/^\/reasoning(?:@\w+)?(?:\s|$)/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return;
  }

  await ctx.reply("Choose reasoning effort:", {
    reply_markup: buildReasoningKeyboard(),
  });
});

stateComposer.callbackQuery(/^reasoning:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCallbackQuery({
      text: "Only the admin can change reasoning.",
      show_alert: true,
    });
    return;
  }

  const rawEffort = ctx.match[1];

  const effort = parseReasoningSetting(rawEffort);

  if (effort === undefined) {
    await ctx.answerCallbackQuery({
      text: "Unknown reasoning option.",
      show_alert: true,
    });
    return;
  }

  const updatedEffort = await persistReasoningEffort(ctx.database, effort);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`Reasoning was set to ${updatedEffort ?? "null"}.`);
});

stateComposer.hears(/^\/websearch(?:@\w+)?(?:\s|$)/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return;
  }

  await ctx.reply("Choose web search setting:", {
    reply_markup: buildWebSearchKeyboard(),
  });
});

stateComposer.callbackQuery(/^websearch:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCallbackQuery({
      text: "Only the admin can change web search.",
      show_alert: true,
    });
    return;
  }

  const setting = ctx.match[1];

  if (!isWebSearchSetting(setting)) {
    await ctx.answerCallbackQuery({
      text: "Unknown web search option.",
      show_alert: true,
    });
    return;
  }

  const updatedSetting = await persistWebSearchSetting(ctx.database, setting);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`Web search was set to ${updatedSetting}.`);
});
