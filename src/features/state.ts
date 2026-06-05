import { Composer } from "grammy";
import type { Context } from "../bot.ts";
import { replyWithResumeTask } from "./chat.ts";
import { APP_ENV } from "./env.ts";
import {
  getLlmModelNames,
  getReasoningEfforts,
  getWebSearchSetting,
  isLlmModelTier,
  isWebSearchSetting,
  parseReasoningSetting,
  persistLlmModelName,
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

function getModelCommandUsage(): string {
  return [
    "Usage: /model small NAME",
    "Usage: /model big NAME",
    "",
    `Current: small=${getLlmModelNames().small}, big=${getLlmModelNames().big}`,
  ].join("\n");
}

function getReasoningCommandUsage(): string {
  const reasoningEfforts = getReasoningEfforts();

  return [
    "Usage: /reasoning small null|none|minimal|low|medium|high|xhigh",
    "Usage: /reasoning big null|none|minimal|low|medium|high|xhigh",
    "",
    `Current: small=${reasoningEfforts.small ?? "null"}, big=${
      reasoningEfforts.big ?? "null"
    }`,
  ].join("\n");
}

function getWebSearchCommandUsage(): string {
  return [
    "Usage: /websearch off|low|medium|high",
    "",
    `Current: websearch=${getWebSearchSetting()}`,
  ].join("\n");
}

function getUsageCommandUsage(): string {
  return ["Usage: /usage", `Usage: /usage ${USAGE_KEYS.join("|")} QUOTA`].join(
    "\n",
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

stateComposer.command("model", async (ctx) => {
  const args = typeof ctx.match === "string" ? ctx.match.trim() : "";

  if (!args) {
    await ctx.reply(getModelCommandUsage());
    return;
  }

  const [tier, ...modelNameParts] = args.split(/\s+/);
  const modelName = modelNameParts.join(" ").trim();

  if (!isLlmModelTier(tier) || !modelName) {
    await ctx.reply(getModelCommandUsage());
    return;
  }

  const updatedModelName = await persistLlmModelName(
    ctx.database,
    tier,
    modelName,
  );

  await ctx.reply(`Updated ${tier} model to ${updatedModelName}`);
});

stateComposer.command("reasoning", async (ctx) => {
  const args = typeof ctx.match === "string" ? ctx.match.trim() : "";

  if (!args) {
    await ctx.reply(getReasoningCommandUsage());
    return;
  }

  const [tier, rawEffort, ...extraParts] = args.split(/\s+/);

  if (!isLlmModelTier(tier) || !rawEffort || extraParts.length > 0) {
    await ctx.reply(getReasoningCommandUsage());
    return;
  }

  const effort = parseReasoningSetting(rawEffort);

  if (effort === undefined) {
    await ctx.reply(getReasoningCommandUsage());
    return;
  }

  const updatedEffort = await persistReasoningEffort(
    ctx.database,
    tier,
    effort,
  );

  await ctx.reply(`Updated ${tier} reasoning to ${updatedEffort ?? "null"}`);
});

stateComposer.command("websearch", async (ctx) => {
  const setting = typeof ctx.match === "string" ? ctx.match.trim() : "";

  if (!setting) {
    await ctx.reply(getWebSearchCommandUsage());
    return;
  }

  if (!isWebSearchSetting(setting)) {
    await ctx.reply(getWebSearchCommandUsage());
    return;
  }

  const updatedSetting = await persistWebSearchSetting(ctx.database, setting);

  await ctx.reply(`Updated websearch to ${updatedSetting}`);
});
