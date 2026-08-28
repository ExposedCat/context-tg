import { Composer } from "grammy";
import type { Context } from "../bot.ts";
import { canConfigureChat, isBotAdmin } from "./authorization.ts";
import { replyWithResumeTask } from "./chat.ts";
import {
  isLlmDeploymentId,
  LLM_DEPLOYMENT_OPTIONS,
} from "./llm-deployments.ts";
import {
  type ChatLlmSettingKey,
  getChatDebugMode,
  getChatReasoningEffort,
  getGlobalDebugMode,
  getGlobalReasoningEffort,
  isLlmSettingsDeployment,
  type LlmSettingsDeployment,
  parseDebugModeSetting,
  parseReasoningSetting,
  persistChatDebugMode,
  persistChatReasoningEffort,
  persistGlobalDebugMode,
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
import { handleUsageCommand } from "./usage.ts";

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

type ConfigureScope = "configure" | "global";

const CONFIGURE_KIND_KEYS = {
  debug: {
    configure: "settings-kind-debug",
    global: "settings-kind-debug-global",
  },
  reasoning: {
    configure: "settings-kind-reasoning",
    global: "settings-kind-reasoning-global",
  },
} as const satisfies Record<ChatLlmSettingKey, Record<ConfigureScope, string>>;

const SETTING_VALUE_KEYS: Record<string, string> = {
  null: "settings-value-null",
  none: "settings-value-none",
  minimal: "settings-value-minimal",
  low: "settings-value-low",
  medium: "settings-value-medium",
  high: "settings-value-high",
  xhigh: "settings-value-xhigh",
  off: "settings-value-off",
  on: "settings-value-on",
};

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

function getModelCommandUsage(translate: Context["t"]): string {
  const options = LLM_DEPLOYMENT_OPTIONS.map(({ id }) => id).join("|");
  return translate("settings-model-usage", { options });
}

function getDebugCommandUsage(translate: Context["t"]): string {
  return translate("settings-debug-usage");
}

function getIntervalCommandUsage(
  translate: Context["t"],
  command: "/trolleach" | "/trolling" | "/proactive",
): string {
  return translate("settings-interval-usage", {
    command,
    max: String(MAX_RESPONSE_INTERVAL_MESSAGE_COUNT),
  });
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

function formatMessageIntervalStatus(
  translate: Context["t"],
  status: MessageIntervalStatus,
): string {
  return status.enabled
    ? translate("settings-interval-status-enabled", {
        count: status.intervalMessageCount,
      })
    : translate("settings-interval-status-disabled", {
        count: status.intervalMessageCount,
      });
}

function formatSettingValue(translate: Context["t"], value: string): string {
  const key = SETTING_VALUE_KEYS[value];
  return key ? translate(key) : value;
}

function isConfigureKind(value: string): value is ChatLlmSettingKey {
  return value === "debug" || value === "reasoning";
}

function isConfigureScope(value: string): value is ConfigureScope {
  return value === "configure" || value === "global";
}

function formatConfigureValue(value: ReasoningSetting) {
  return value ?? "null";
}

function formatDebugMode(enabled: boolean): string {
  return enabled ? "on" : "off";
}

function formatConfigureKindLabel(
  translate: Context["t"],
  scope: ConfigureScope,
  kind: ChatLlmSettingKey,
): string {
  return translate(CONFIGURE_KIND_KEYS[kind][scope]);
}

export function formatConfigureMenu(
  translate: Context["t"],
  scope: ConfigureScope,
  includeBotAdminCommands: boolean,
): string {
  if (scope === "global") {
    return translate("settings-configure-global-title");
  }

  return translate(
    includeBotAdminCommands
      ? "settings-configure-menu-admin"
      : "settings-configure-menu",
  );
}

function formatConfigureAdminWarning(
  translate: Context["t"],
  scope: ConfigureScope,
): string {
  return translate(
    scope === "global"
      ? "settings-admin-warning-global"
      : "settings-admin-warning-chat",
  );
}

function formatDeploymentLabel(
  translate: Context["t"],
  deployment: LlmSettingsDeployment,
): string {
  return deployment === "all"
    ? translate("settings-deployment-all")
    : formatModelDisplayName(translate, deployment);
}

function formatModelDisplayName(translate: Context["t"], id: string): string {
  switch (id) {
    case "small":
      return translate("settings-model-small");
    case "big":
      return translate("settings-model-big");
    case "openminded":
      return translate("settings-model-openminded");
    case "image":
      return translate("settings-model-image");
    default:
      return id;
  }
}

function formatModelCommandStatus(translate: Context["t"]): string {
  return [
    translate("settings-model-status-title"),
    ...LLM_DEPLOYMENT_OPTIONS.map(
      (deployment) =>
        `${formatModelDisplayName(translate, deployment.id)} - ${
          deployment.deploymentName || translate("settings-model-not-set")
        }`,
    ),
    getModelCommandUsage(translate),
  ].join("\n");
}

function buildSettingsKeyboard(
  translate: Context["t"],
  options: readonly string[],
  current: string,
  callbackPrefix: string,
): SettingsKeyboardMarkup {
  const rows: SettingsKeyboardButton[][] = [];
  let row: SettingsKeyboardButton[] = [];

  for (const [index, option] of options.entries()) {
    row.push({
      text: formatSettingValue(translate, option),
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

function buildConfigureKeyboard(
  translate: Context["t"],
  scope: ConfigureScope,
): SettingsKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: translate(CONFIGURE_KIND_KEYS.debug.configure),
          callback_data: `${scope}:debug`,
        },
        {
          text: translate(CONFIGURE_KIND_KEYS.reasoning.configure),
          callback_data: `${scope}:reasoning`,
        },
      ],
    ],
  };
}

function buildConfigureDeploymentKeyboard(
  translate: Context["t"],
  scope: ConfigureScope,
  kind: ChatLlmSettingKey,
): SettingsKeyboardMarkup {
  return {
    inline_keyboard: [
      LLM_DEPLOYMENT_OPTIONS.map((deployment) => ({
        text: formatModelDisplayName(translate, deployment.id),
        callback_data: `${scope}:${kind}:deployment:${deployment.id}`,
      })),
      [
        {
          text: translate("settings-deployment-all"),
          callback_data: `${scope}:${kind}:deployment:all`,
        },
      ],
    ],
  };
}

async function getConfigureDebugValue(
  ctx: Context,
  scope: ConfigureScope,
): Promise<string> {
  if (scope === "global") {
    return formatDebugMode(await getGlobalDebugMode(ctx.database));
  }

  if (!ctx.chat) {
    return "";
  }

  return formatDebugMode(await getChatDebugMode(ctx.database, ctx.chat.id));
}

async function buildConfigureDebugKeyboard(
  ctx: Context,
  scope: ConfigureScope,
): Promise<SettingsKeyboardMarkup> {
  return buildSettingsKeyboard(
    ctx.t,
    ["off", "on"],
    await getConfigureDebugValue(ctx, scope),
    `${scope}:debug:set`,
  );
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
    ctx.t,
    REASONING_OPTIONS,
    current,
    `${scope}:${kind}:set:${deployment}`,
  );
}

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
  const response = await handleUsageCommand(
    ctx.database,
    ctx.chat.id,
    args,
    isBotAdmin(ctx),
    ctx.t,
  );

  await ctx.reply(response);
});

stateComposer.command("model", async (ctx) => {
  if (!isBotAdmin(ctx)) {
    await ctx.reply(ctx.t("settings-model-admin-only"));
    return;
  }

  const args = typeof ctx.match === "string" ? ctx.match.trim() : "";

  if (!args) {
    await ctx.reply(formatModelCommandStatus(ctx.t));
    return;
  }

  const [rawName, deploymentName, ...extraParts] = args.split(/\s+/);

  if (
    !rawName ||
    !isLlmDeploymentId(rawName) ||
    !deploymentName ||
    extraParts.length > 0
  ) {
    await ctx.reply(getModelCommandUsage(ctx.t));
    return;
  }

  const updatedName = await persistLlmDeploymentName(
    ctx.database,
    rawName,
    deploymentName,
  );

  await ctx.reply(
    ctx.t("settings-model-updated", {
      model: formatModelDisplayName(ctx.t, rawName),
      deployment: updatedName,
    }),
  );
});

stateComposer.command("configure", async (ctx) => {
  if (!ctx.chat) {
    return;
  }

  if (!(await canConfigureChat(ctx))) {
    await ctx.reply(formatConfigureAdminWarning(ctx.t, "configure"));
    return;
  }

  const botAdmin = isBotAdmin(ctx);

  await ctx.reply(
    formatConfigureMenu(ctx.t, "configure", botAdmin),
    botAdmin
      ? { reply_markup: buildConfigureKeyboard(ctx.t, "configure") }
      : undefined,
  );
});

stateComposer.hears(/^\/debug(?:@\w+)?(?:\s+(.+))?$/, async (ctx) => {
  if (!ctx.chat) {
    return;
  }

  if (!isBotAdmin(ctx)) {
    await ctx.reply(ctx.t("settings-debug-admin-only"));
    return;
  }

  const rawValue = ctx.match[1]?.trim();
  const setting = rawValue ? parseDebugModeSetting(rawValue) : undefined;

  if (setting === undefined) {
    const current = await getChatDebugMode(ctx.database, ctx.chat.id);
    await ctx.reply(
      `${getDebugCommandUsage(ctx.t)}\n${ctx.t("settings-debug-current", {
        value: formatSettingValue(ctx.t, formatDebugMode(current)),
      })}`,
    );
    return;
  }

  const updated = await persistChatDebugMode(
    ctx.database,
    ctx.chat.id,
    setting,
  );

  await ctx.reply(
    ctx.t("settings-debug-updated", {
      value: formatSettingValue(ctx.t, formatDebugMode(updated)),
    }),
  );
});

stateComposer.command("global", async (ctx) => {
  if (!isBotAdmin(ctx)) {
    await ctx.reply(formatConfigureAdminWarning(ctx.t, "global"));
    return;
  }

  await ctx.reply(formatConfigureMenu(ctx.t, "global", true), {
    reply_markup: buildConfigureKeyboard(ctx.t, "global"),
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

stateComposer.callbackQuery(
  /^(configure|global):(debug|reasoning)$/,
  async (ctx) => {
    const scope = ctx.match[1];
    const kind = ctx.match[2];

    if (!isConfigureScope(scope) || !isConfigureKind(kind)) {
      await ctx.answerCallbackQuery({
        text: ctx.t("settings-error-unknown-configuration"),
        show_alert: true,
      });
      return;
    }

    if (!isBotAdmin(ctx)) {
      await ctx.answerCallbackQuery({
        text: ctx.t("settings-error-debug-reasoning-admin-only"),
        show_alert: true,
      });
      return;
    }

    if (scope === "configure" && !ctx.chat) {
      return;
    }

    await ctx.answerCallbackQuery();

    if (kind === "debug") {
      await ctx.editMessageText(
        ctx.t("settings-choose-debug-mode", {
          setting: formatConfigureKindLabel(ctx.t, scope, kind),
        }),
        {
          reply_markup: await buildConfigureDebugKeyboard(ctx, scope),
        },
      );
      return;
    }

    await ctx.editMessageText(
      ctx.t("settings-choose-deployment", {
        setting: formatConfigureKindLabel(ctx.t, scope, kind),
      }),
      {
        reply_markup: buildConfigureDeploymentKeyboard(ctx.t, scope, kind),
      },
    );
  },
);

stateComposer.callbackQuery(
  /^(configure|global):debug:set:(on|off)$/,
  async (ctx) => {
    const scope = ctx.match[1];
    const value = ctx.match[2];

    if (!isConfigureScope(scope)) {
      await ctx.answerCallbackQuery({
        text: ctx.t("settings-error-unknown-configuration"),
        show_alert: true,
      });
      return;
    }

    if (!isBotAdmin(ctx)) {
      await ctx.answerCallbackQuery({
        text: ctx.t("settings-error-debug-reasoning-admin-only"),
        show_alert: true,
      });
      return;
    }

    const enabled = parseDebugModeSetting(value);

    if (enabled === undefined) {
      await ctx.answerCallbackQuery({
        text: ctx.t("settings-error-unknown-debug"),
        show_alert: true,
      });
      return;
    }

    let updatedValue: string;

    if (scope === "global") {
      updatedValue = formatDebugMode(
        await persistGlobalDebugMode(ctx.database, enabled),
      );
    } else {
      if (!ctx.chat) {
        return;
      }

      updatedValue = formatDebugMode(
        await persistChatDebugMode(ctx.database, ctx.chat.id, enabled),
      );
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `${ctx.t("settings-debug-set", {
        setting: formatConfigureKindLabel(ctx.t, scope, "debug"),
        value: formatSettingValue(ctx.t, updatedValue),
      })}\n\n${formatConfigureMenu(ctx.t, scope, isBotAdmin(ctx))}`,
      {
        reply_markup: buildConfigureKeyboard(ctx.t, scope),
      },
    );
  },
);

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
        text: ctx.t("settings-error-unknown-configuration"),
        show_alert: true,
      });
      return;
    }

    if (!isBotAdmin(ctx)) {
      await ctx.answerCallbackQuery({
        text: ctx.t("settings-error-debug-reasoning-admin-only"),
        show_alert: true,
      });
      return;
    }

    if (scope === "configure" && !ctx.chat) {
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      ctx.t("settings-choose-reasoning", {
        setting: formatConfigureKindLabel(ctx.t, scope, kind),
        deployment: formatDeploymentLabel(ctx.t, deployment),
      }),
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
        text: ctx.t("settings-error-unknown-configuration"),
        show_alert: true,
      });
      return;
    }

    if (!isBotAdmin(ctx)) {
      await ctx.answerCallbackQuery({
        text: ctx.t("settings-error-debug-reasoning-admin-only"),
        show_alert: true,
      });
      return;
    }

    const effort = parseReasoningSetting(value);

    if (effort === undefined) {
      await ctx.answerCallbackQuery({
        text: ctx.t("settings-error-unknown-reasoning"),
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
      `${ctx.t("settings-reasoning-set", {
        setting: formatConfigureKindLabel(ctx.t, scope, kind),
        deployment: formatDeploymentLabel(ctx.t, deployment),
        value: formatSettingValue(ctx.t, updatedValue),
      })}\n\n${formatConfigureMenu(ctx.t, scope, isBotAdmin(ctx))}`,
      {
        reply_markup: buildConfigureKeyboard(ctx.t, scope),
      },
    );
  },
);

async function replyWithTrollingIntervalCommand(
  ctx: Context,
  command: "/trolleach" | "/trolling",
  value: string | undefined,
) {
  if (!ctx.chat || !(await canConfigureChat(ctx))) {
    return;
  }

  const setting = parseMessageIntervalSetting(value);

  if (setting === undefined) {
    const current = await getTrollingSettings(ctx.database, ctx.chat.id);
    await ctx.reply(
      [
        ctx.t("settings-trolling-description"),
        getIntervalCommandUsage(ctx.t, command),
        ctx.t("settings-current-value", {
          value: formatMessageIntervalStatus(ctx.t, current),
        }),
      ].join("\n\n"),
    );
    return;
  }

  if (setting === "off") {
    await setTrollingEnabled(ctx.database, ctx.chat.id, false);
    await ctx.reply(ctx.t("settings-trolling-disabled"));
    return;
  }

  await setTrollingInterval(ctx.database, ctx.chat.id, setting);
  await ctx.reply(ctx.t("settings-trolling-updated", { count: setting }));
}

stateComposer.hears(/^\/trolling(?:@\w+)?(?:\s+(.+))?$/, async (ctx) => {
  await replyWithTrollingIntervalCommand(ctx, "/trolling", ctx.match[1]);
});

stateComposer.hears(/^\/trolleach(?:@\w+)?(?:\s+(.+))?$/, async (ctx) => {
  await replyWithTrollingIntervalCommand(ctx, "/trolleach", ctx.match[1]);
});

stateComposer.hears(/^\/proactive(?:@\w+)?(?:\s+(.+))?$/, async (ctx) => {
  if (!ctx.chat || !(await canConfigureChat(ctx))) {
    return;
  }

  const setting = parseMessageIntervalSetting(ctx.match[1]);

  if (setting === undefined) {
    const current = await getProactiveResponseSettings(
      ctx.database,
      ctx.chat.id,
    );
    await ctx.reply(
      [
        ctx.t("settings-proactive-description"),
        getIntervalCommandUsage(ctx.t, "/proactive"),
        ctx.t("settings-current-value", {
          value: formatMessageIntervalStatus(ctx.t, current),
        }),
      ].join("\n\n"),
    );
    return;
  }

  if (setting === "off") {
    await setProactiveResponseEnabled(ctx.database, ctx.chat.id, false);
    await ctx.reply(ctx.t("settings-proactive-disabled"));
    return;
  }

  await setProactiveResponseInterval(ctx.database, ctx.chat.id, setting);
  await ctx.reply(ctx.t("settings-proactive-updated", { count: setting }));
});
