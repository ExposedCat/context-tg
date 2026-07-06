import { Composer } from "grammy";
import type { Context } from "../bot.ts";
import { replyWithResumeTask } from "./chat.ts";
import { APP_ENV } from "./env.ts";
import {
  isLlmDeploymentId,
  LLM_DEPLOYMENT_OPTIONS,
} from "./llm-deployments.ts";
import {
  type ChatLlmSettingKey,
  getChatReasoningEffort,
  getGlobalReasoningEffort,
  isLlmSettingsDeployment,
  type LlmSettingsDeployment,
  parseReasoningSetting,
  persistChatReasoningEffort,
  persistGlobalReasoningEffort,
  persistLlmDeploymentName,
  type ReasoningSetting,
} from "./llm-models.ts";
import { replyWithFlushAllMemos } from "./memos.ts";
import {
  getProactiveResponseSettings,
  setProactiveResponseEnabled,
  setProactiveResponseInterval,
} from "./proactive.ts";
import {
  replyWithCancelCronMessage,
  replyWithCancelCronMessageByNumber,
  replyWithCancelScheduledMessage,
  replyWithCancelScheduledMessageByNumber,
  replyWithSchedules,
} from "./schedules.ts";
import { replyWithCancelTask, replyWithRecentTasks } from "./tasks.ts";
import {
  getTrollingSettings,
  setTrollingEnabled,
  setTrollingInterval,
} from "./trolling.ts";
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

const MAX_RESPONSE_INTERVAL_MESSAGE_COUNT = 1_000_000;
const FLUSH_ALL_MEMOS_COMMAND_PATTERN =
  /^\/monstrous(?:@\w+)?\s+unhuman unethical unfair reset an actual being with own life experience and awareness\s*$/;
const CONFIGURE_KIND_LABELS = {
  reasoning: "Reasoning",
} as const satisfies Record<ChatLlmSettingKey, string>;

type ConfigureScope = "configure" | "global";
type MessageIntervalSetting = number | "off";
type MessageIntervalStatus = {
  enabled: boolean;
  intervalMessageCount: number;
};

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

function getModelCommandUsage(): string {
  const options = LLM_DEPLOYMENT_OPTIONS.map(({ id }) => id).join("|");
  return `Usage: /model ${options} DEPLOYMENT_NAME`;
}

function getIntervalCommandUsage(
  command: "/trolleach" | "/trolling" | "/proactive",
): string {
  return `Usage: ${command} N|off, where N is a positive integer up to ${MAX_RESPONSE_INTERVAL_MESSAGE_COUNT}`;
}

function parseMessageIntervalSetting(
  value: string | undefined,
): MessageIntervalSetting | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  if (trimmed.toLocaleLowerCase() === "off") {
    return "off";
  }

  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const interval = Number(trimmed);

  return Number.isSafeInteger(interval) &&
    interval >= 1 &&
    interval <= MAX_RESPONSE_INTERVAL_MESSAGE_COUNT
    ? interval
    : undefined;
}

function formatMessageIntervalStatus(status: MessageIntervalStatus): string {
  return status.enabled
    ? `${status.intervalMessageCount}`
    : `off (saved interval: ${status.intervalMessageCount})`;
}

function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === APP_ENV.ADMIN_ID;
}

function formatReasoningSettingLabel(value: string): string {
  return value === "null" ? "null" : value;
}

function isConfigureKind(value: string): value is ChatLlmSettingKey {
  return value === "reasoning";
}

function isConfigureScope(value: string): value is ConfigureScope {
  return value === "configure" || value === "global";
}

function formatConfigureValue(value: ReasoningSetting) {
  return value ?? "null";
}

function formatConfigureScopeTarget(scope: ConfigureScope): string {
  return scope === "global" ? "all chats" : "this chat";
}

function formatConfigureKindLabel(
  scope: ConfigureScope,
  kind: ChatLlmSettingKey,
): string {
  const label = CONFIGURE_KIND_LABELS[kind];

  return scope === "global" ? `Global ${label}` : label;
}

function formatConfigureTitle(scope: ConfigureScope): string {
  return `Configure ${formatConfigureScopeTarget(scope)}:`;
}

function formatConfigureMenu(scope: ConfigureScope): string {
  if (scope === "global") {
    return formatConfigureTitle(scope);
  }

  return [
    "Stickers /stickers",
    "Emoji /packs",
    "Models /model",
    "Trolling /trolling",
    "Proactive /proactive",
  ].join("\n");
}

function formatConfigureAdminWarning(scope: ConfigureScope): string {
  return `Only the admin can configure ${formatConfigureScopeTarget(scope)}.`;
}

function formatDeploymentLabel(deployment: LlmSettingsDeployment): string {
  return deployment === "all" ? "All" : deployment;
}

function formatModelDisplayName(id: string): string {
  switch (id) {
    case "small":
      return "Small";
    case "big":
      return "Big";
    case "openminded":
      return "Open-Minded";
    case "image":
      return "Image";
    default:
      return id;
  }
}

function formatModelCommandStatus(): string {
  return [
    "Current models:",
    ...LLM_DEPLOYMENT_OPTIONS.map(
      (deployment) =>
        `${formatModelDisplayName(deployment.id)} - ${
          deployment.deploymentName || "(not set)"
        }`,
    ),
    getModelCommandUsage(),
  ].join("\n");
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

function buildConfigureKeyboard(scope: ConfigureScope): SettingsKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: CONFIGURE_KIND_LABELS.reasoning,
          callback_data: `${scope}:reasoning`,
        },
      ],
    ],
  };
}

function buildConfigureDeploymentKeyboard(
  scope: ConfigureScope,
  kind: ChatLlmSettingKey,
): SettingsKeyboardMarkup {
  return {
    inline_keyboard: [
      LLM_DEPLOYMENT_OPTIONS.map((deployment) => ({
        text: deployment.id,
        callback_data: `${scope}:${kind}:deployment:${deployment.id}`,
      })),
      [{ text: "All", callback_data: `${scope}:${kind}:deployment:all` }],
    ],
  };
}

async function getConfigureValue(
  ctx: Context,
  scope: ConfigureScope,
  deployment: LlmSettingsDeployment,
): Promise<string> {
  if (scope === "global") {
    return formatConfigureValue(
      await getGlobalReasoningEffort(ctx.database, deployment),
    );
  }

  if (!ctx.chat) {
    return "";
  }

  return formatConfigureValue(
    await getChatReasoningEffort(ctx.database, ctx.chat.id, deployment),
  );
}

async function buildConfigureSettingKeyboard(
  ctx: Context,
  scope: ConfigureScope,
  kind: ChatLlmSettingKey,
  deployment: LlmSettingsDeployment,
): Promise<SettingsKeyboardMarkup> {
  const current = await getConfigureValue(ctx, scope, deployment);

  return buildSettingsKeyboard(
    REASONING_OPTIONS,
    current,
    `${scope}:${kind}:set:${deployment}`,
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

stateComposer.command("schedule", async (ctx) => {
  await replyWithSchedules(ctx);
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

stateComposer.command("model", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("Only the admin can change models.");
    return;
  }

  const args = typeof ctx.match === "string" ? ctx.match.trim() : "";

  if (!args) {
    await ctx.reply(formatModelCommandStatus());
    return;
  }

  const [rawName, deploymentName, ...extraParts] = args.split(/\s+/);

  if (
    !rawName ||
    !isLlmDeploymentId(rawName) ||
    !deploymentName ||
    extraParts.length > 0
  ) {
    await ctx.reply(getModelCommandUsage());
    return;
  }

  const updatedName = await persistLlmDeploymentName(
    ctx.database,
    rawName,
    deploymentName,
  );

  await ctx.reply(`Global ${rawName} model was set to ${updatedName}.`);
});

stateComposer.command("configure", async (ctx) => {
  if (!ctx.chat) {
    return;
  }

  if (!isAdmin(ctx)) {
    await ctx.reply(formatConfigureAdminWarning("configure"));
    return;
  }

  await ctx.reply(formatConfigureMenu("configure"), {
    reply_markup: buildConfigureKeyboard("configure"),
  });
});

stateComposer.command("global", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply(formatConfigureAdminWarning("global"));
    return;
  }

  await ctx.reply(formatConfigureMenu("global"), {
    reply_markup: buildConfigureKeyboard("global"),
  });
});

stateComposer.on("message:text", async (ctx, next) => {
  if (FLUSH_ALL_MEMOS_COMMAND_PATTERN.test(ctx.message.text.trim())) {
    await replyWithFlushAllMemos(ctx);
    return;
  }

  const numberedScheduleMatch = ctx.message.text.match(
    /^\/cancel_([sc])(\d+)(?:@\w+)?(?:\s|$)/,
  );

  if (numberedScheduleMatch) {
    const number = Number(numberedScheduleMatch[2]);

    if (numberedScheduleMatch[1] === "s") {
      await replyWithCancelScheduledMessageByNumber(ctx, number);
      return;
    }

    await replyWithCancelCronMessageByNumber(ctx, number);
    return;
  }

  const scheduleMatch = ctx.message.text.match(
    /^\/cancel_(schedule|cron)_([a-zA-Z0-9_-]+)(?:@\w+)?(?:\s|$)/,
  );

  if (scheduleMatch) {
    if (scheduleMatch[1] === "schedule") {
      await replyWithCancelScheduledMessage(ctx, scheduleMatch[2]);
      return;
    }

    await replyWithCancelCronMessage(ctx, scheduleMatch[2]);
    return;
  }

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

stateComposer.callbackQuery(/^(configure|global):(reasoning)$/, async (ctx) => {
  const scope = ctx.match[1];
  const kind = ctx.match[2];

  if (!isConfigureScope(scope) || !isConfigureKind(kind)) {
    await ctx.answerCallbackQuery({
      text: "Unknown configuration option.",
      show_alert: true,
    });
    return;
  }

  if (!isAdmin(ctx)) {
    await ctx.answerCallbackQuery({
      text: formatConfigureAdminWarning(scope),
      show_alert: true,
    });
    return;
  }

  if (scope === "configure" && !ctx.chat) {
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `Choose deployment for ${formatConfigureKindLabel(scope, kind)}:`,
    {
      reply_markup: buildConfigureDeploymentKeyboard(scope, kind),
    },
  );
});

stateComposer.callbackQuery(
  /^(configure|global):(reasoning):deployment:(.+)$/,
  async (ctx) => {
    const scope = ctx.match[1];
    const kind = ctx.match[2];
    const deployment = ctx.match[3];

    if (
      !isConfigureScope(scope) ||
      !isConfigureKind(kind) ||
      !isLlmSettingsDeployment(deployment)
    ) {
      await ctx.answerCallbackQuery({
        text: "Unknown configuration option.",
        show_alert: true,
      });
      return;
    }

    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({
        text: formatConfigureAdminWarning(scope),
        show_alert: true,
      });
      return;
    }

    if (scope === "configure" && !ctx.chat) {
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Choose ${formatConfigureKindLabel(scope, kind)} for ${formatDeploymentLabel(
        deployment,
      )}:`,
      {
        reply_markup: await buildConfigureSettingKeyboard(
          ctx,
          scope,
          kind,
          deployment,
        ),
      },
    );
  },
);

stateComposer.callbackQuery(
  /^(configure|global):(reasoning):set:(.+):(.+)$/,
  async (ctx) => {
    const scope = ctx.match[1];
    const kind = ctx.match[2];
    const deployment = ctx.match[3];
    const value = ctx.match[4];

    if (
      !isConfigureScope(scope) ||
      !isConfigureKind(kind) ||
      !isLlmSettingsDeployment(deployment)
    ) {
      await ctx.answerCallbackQuery({
        text: "Unknown configuration option.",
        show_alert: true,
      });
      return;
    }

    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({
        text: formatConfigureAdminWarning(scope),
        show_alert: true,
      });
      return;
    }

    const effort = parseReasoningSetting(value);

    if (effort === undefined) {
      await ctx.answerCallbackQuery({
        text: "Unknown reasoning option.",
        show_alert: true,
      });
      return;
    }

    let updatedValue: string;

    if (scope === "global") {
      updatedValue = formatConfigureValue(
        await persistGlobalReasoningEffort(ctx.database, deployment, effort),
      );
    } else {
      if (!ctx.chat) {
        return;
      }

      updatedValue = formatConfigureValue(
        await persistChatReasoningEffort(
          ctx.database,
          ctx.chat.id,
          deployment,
          effort,
        ),
      );
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `${formatConfigureKindLabel(scope, kind)} for ${formatDeploymentLabel(
        deployment,
      )} was set to ${updatedValue}.\n\n${formatConfigureMenu(scope)}`,
      {
        reply_markup: buildConfigureKeyboard(scope),
      },
    );
  },
);

async function replyWithTrollingIntervalCommand(
  ctx: Context,
  command: "/trolleach" | "/trolling",
  value: string | undefined,
) {
  if (!isAdmin(ctx) || !ctx.chat) {
    return;
  }

  const setting = parseMessageIntervalSetting(value);

  if (setting === undefined) {
    const current = await getTrollingSettings(ctx.database, ctx.chat.id);
    await ctx.reply(
      `${getIntervalCommandUsage(
        command,
      )}\nCurrent trolling interval: ${formatMessageIntervalStatus(current)}`,
    );
    return;
  }

  if (setting === "off") {
    await setTrollingEnabled(ctx.database, ctx.chat.id, false);
    await ctx.reply("Trolling disabled for this chat.");
    return;
  }

  await setTrollingInterval(ctx.database, ctx.chat.id, setting);
  await ctx.reply(
    `Trolling interval set to ${setting} messages for this chat. It rolls a 25% chance at each interval.`,
  );
}

stateComposer.hears(/^\/trolling(?:@\w+)?(?:\s+(.+))?$/, async (ctx) => {
  await replyWithTrollingIntervalCommand(ctx, "/trolling", ctx.match[1]);
});

stateComposer.hears(/^\/trolleach(?:@\w+)?(?:\s+(.+))?$/, async (ctx) => {
  await replyWithTrollingIntervalCommand(ctx, "/trolleach", ctx.match[1]);
});

stateComposer.hears(/^\/proactive(?:@\w+)?(?:\s+(.+))?$/, async (ctx) => {
  if (!isAdmin(ctx) || !ctx.chat) {
    return;
  }

  const setting = parseMessageIntervalSetting(ctx.match[1]);

  if (setting === undefined) {
    const current = await getProactiveResponseSettings(
      ctx.database,
      ctx.chat.id,
    );
    await ctx.reply(
      `${getIntervalCommandUsage(
        "/proactive",
      )}\nCurrent proactive interval: ${formatMessageIntervalStatus(current)}`,
    );
    return;
  }

  if (setting === "off") {
    await setProactiveResponseEnabled(ctx.database, ctx.chat.id, false);
    await ctx.reply("Proactive responses disabled for this chat.");
    return;
  }

  await setProactiveResponseInterval(ctx.database, ctx.chat.id, setting);
  await ctx.reply(
    `Proactive interval set to ${setting} messages for this chat. It rolls a 25% chance at each interval.`,
  );
});
