import { Composer } from "grammy";
import type { Context } from "../bot.ts";
import { replyWithResumeTask } from "./chat.ts";
import { APP_ENV } from "./env.ts";
import { LLM_DEPLOYMENT_OPTIONS } from "./llm-deployments.ts";
import {
  type ChatLlmSettingKey,
  getChatReasoningEffort,
  getChatWebSearchSetting,
  getReasoningEffort,
  getTrollingSetting,
  getWebSearchSetting,
  isLlmSettingsDeployment,
  isTrollingSetting,
  isWebSearchSetting,
  type LlmSettingsDeployment,
  parseReasoningSetting,
  persistChatReasoningEffort,
  persistChatWebSearchSetting,
  persistReasoningEffort,
  persistTrollingSetting,
  persistWebSearchSetting,
  type ReasoningSetting,
  type WebSearchSetting,
} from "./llm-models.ts";
import {
  replyWithCancelCronMessage,
  replyWithCancelScheduledMessage,
  replyWithSchedules,
} from "./schedules.ts";
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
const TROLLING_OPTIONS = ["off", "on"] as const;
const CONFIGURE_KIND_LABELS = {
  reasoning: "Reasoning",
  websearch: "Web Search",
} as const satisfies Record<ChatLlmSettingKey, string>;

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

function isConfigureKind(value: string): value is ChatLlmSettingKey {
  return value === "reasoning" || value === "websearch";
}

function formatConfigureValue(value: ReasoningSetting | WebSearchSetting) {
  return value ?? "null";
}

function formatDeploymentLabel(deployment: LlmSettingsDeployment): string {
  return deployment === "all" ? "All" : deployment;
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

function buildTrollingKeyboard(): SettingsKeyboardMarkup {
  return buildSettingsKeyboard(
    TROLLING_OPTIONS,
    getTrollingSetting(),
    "trolling",
  );
}

function buildConfigureKeyboard(): SettingsKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: CONFIGURE_KIND_LABELS.reasoning,
          callback_data: "configure:reasoning",
        },
      ],
      [
        {
          text: CONFIGURE_KIND_LABELS.websearch,
          callback_data: "configure:websearch",
        },
      ],
    ],
  };
}

function buildConfigureDeploymentKeyboard(
  kind: ChatLlmSettingKey,
): SettingsKeyboardMarkup {
  return {
    inline_keyboard: [
      LLM_DEPLOYMENT_OPTIONS.map((deployment) => ({
        text: deployment.id,
        callback_data: `configure:${kind}:deployment:${deployment.id}`,
      })),
      [{ text: "All", callback_data: `configure:${kind}:deployment:all` }],
    ],
  };
}

async function getConfigureValue(
  ctx: Context,
  kind: ChatLlmSettingKey,
  deployment: LlmSettingsDeployment,
): Promise<string> {
  if (!ctx.chat) {
    return "";
  }

  if (kind === "reasoning") {
    return formatConfigureValue(
      await getChatReasoningEffort(ctx.database, ctx.chat.id, deployment),
    );
  }

  return formatConfigureValue(
    await getChatWebSearchSetting(ctx.database, ctx.chat.id, deployment),
  );
}

async function buildConfigureSettingKeyboard(
  ctx: Context,
  kind: ChatLlmSettingKey,
  deployment: LlmSettingsDeployment,
): Promise<SettingsKeyboardMarkup> {
  const options = kind === "reasoning" ? REASONING_OPTIONS : WEB_SEARCH_OPTIONS;
  const current = await getConfigureValue(ctx, kind, deployment);

  return buildSettingsKeyboard(
    options,
    current,
    `configure:${kind}:set:${deployment}`,
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

stateComposer.command("configure", async (ctx) => {
  if (!ctx.chat) {
    return;
  }

  if (!isAdmin(ctx)) {
    await ctx.reply("Only the admin can configure this chat.");
    return;
  }

  await ctx.reply("Configure this chat:", {
    reply_markup: buildConfigureKeyboard(),
  });
});

stateComposer.on("message:text", async (ctx, next) => {
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
  /^configure:(reasoning|websearch)$/,
  async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({
        text: "Only the admin can configure this chat.",
        show_alert: true,
      });
      return;
    }

    const kind = ctx.match[1];

    if (!isConfigureKind(kind)) {
      await ctx.answerCallbackQuery({
        text: "Unknown configuration option.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Choose deployment for ${CONFIGURE_KIND_LABELS[kind]}:`,
      {
        reply_markup: buildConfigureDeploymentKeyboard(kind),
      },
    );
  },
);

stateComposer.callbackQuery(
  /^configure:(reasoning|websearch):deployment:(.+)$/,
  async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({
        text: "Only the admin can configure this chat.",
        show_alert: true,
      });
      return;
    }

    const kind = ctx.match[1];
    const deployment = ctx.match[2];

    if (!isConfigureKind(kind) || !isLlmSettingsDeployment(deployment)) {
      await ctx.answerCallbackQuery({
        text: "Unknown configuration option.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Choose ${CONFIGURE_KIND_LABELS[kind]} for ${formatDeploymentLabel(
        deployment,
      )}:`,
      {
        reply_markup: await buildConfigureSettingKeyboard(
          ctx,
          kind,
          deployment,
        ),
      },
    );
  },
);

stateComposer.callbackQuery(
  /^configure:(reasoning|websearch):set:(.+):(.+)$/,
  async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({
        text: "Only the admin can configure this chat.",
        show_alert: true,
      });
      return;
    }

    const kind = ctx.match[1];
    const deployment = ctx.match[2];
    const value = ctx.match[3];

    if (!isConfigureKind(kind) || !isLlmSettingsDeployment(deployment)) {
      await ctx.answerCallbackQuery({
        text: "Unknown configuration option.",
        show_alert: true,
      });
      return;
    }

    let updatedValue: string;

    if (kind === "reasoning") {
      const effort = parseReasoningSetting(value);

      if (effort === undefined) {
        await ctx.answerCallbackQuery({
          text: "Unknown reasoning option.",
          show_alert: true,
        });
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
    } else {
      if (!isWebSearchSetting(value)) {
        await ctx.answerCallbackQuery({
          text: "Unknown web search option.",
          show_alert: true,
        });
        return;
      }

      updatedValue = await persistChatWebSearchSetting(
        ctx.database,
        ctx.chat.id,
        deployment,
        value,
      );
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `${CONFIGURE_KIND_LABELS[kind]} for ${formatDeploymentLabel(
        deployment,
      )} was set to ${updatedValue}.`,
      {
        reply_markup: await buildConfigureSettingKeyboard(
          ctx,
          kind,
          deployment,
        ),
      },
    );
  },
);

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

stateComposer.hears(/^\/trolling(?:@\w+)?(?:\s|$)/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return;
  }

  await ctx.reply("Choose trolling setting:", {
    reply_markup: buildTrollingKeyboard(),
  });
});

stateComposer.callbackQuery(/^trolling:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCallbackQuery({
      text: "Only the admin can change trolling.",
      show_alert: true,
    });
    return;
  }

  const setting = ctx.match[1];

  if (!isTrollingSetting(setting)) {
    await ctx.answerCallbackQuery({
      text: "Unknown trolling option.",
      show_alert: true,
    });
    return;
  }

  const updatedSetting = await persistTrollingSetting(ctx.database, setting);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`Trolling was set to ${updatedSetting}.`);
});
