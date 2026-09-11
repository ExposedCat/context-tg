import { Composer, GrammyError } from "grammy";
import type { Context } from "../bot.ts";
import { escapeHtml, escapeHtmlAttribute } from "../utils/text.ts";
import { canConfigureChat, isBotAdmin } from "./authorization.ts";
import { listEmojiPacks, removeEmojiPack } from "./emoji-packs.ts";
import { LLM_DEPLOYMENT_OPTIONS } from "./llm-deployments.ts";
import {
  getChatDebugMode,
  getChatReasoningEffort,
  isLlmSettingsDeployment,
  type LlmSettingsDeployment,
  parseReasoningSetting,
  persistChatDebugMode,
  persistChatReasoningEffort,
} from "./llm-models.ts";
import {
  getProactiveResponseSettings,
  setProactiveResponseEnabled,
} from "./proactive.ts";
import { getTrollingSettings, setTrollingEnabled } from "./trolling.ts";

export const configureComposer = new Composer<Context>();
const EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
type Page = "menu" | "emoji" | "models" | "trolling" | "proactive" | "effort";

function button(label: string, action: string, style?: string): string {
  return `<tg-button type="callback_data"${style ? ` style="${style}"` : ""} data="cfg:${escapeHtmlAttribute(action)}">${escapeHtml(label)}</tg-button>`;
}

function toggle(ctx: Context, action: string, enabled: boolean): string {
  return button(
    ctx.t(enabled ? "configure-enabled" : "configure-disabled"),
    action,
    enabled ? "success" : "danger",
  );
}

async function packKey(name: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(name),
  );
  return Array.from(new Uint8Array(hash).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function buildRichConfigureMessage(
  ctx: Context,
  page: Page = "menu",
  selected?: LlmSettingsDeployment,
): Promise<{ html: string; skip_entity_detection: true }> {
  if (!ctx.chat) throw new Error("Configure requires a chat");
  const chatId = ctx.chat.id;
  const t = (key: string) => escapeHtml(ctx.t(key));
  const configure = (target: string, active = false) =>
    button(ctx.t("configure-button"), target, active ? "primary" : undefined);
  let html: string;
  if (page === "menu") {
    const rows = [`<p>${t("configure-emoji")} ${configure("emoji")}</p>`];
    if (isBotAdmin(ctx)) {
      rows.push(`<p>${t("configure-models")} ${configure("models")}</p>`);
      const enabled = await getChatDebugMode(ctx.database, ctx.chat.id);
      rows.push(
        `<p>${t("settings-kind-debug")} ${toggle(ctx, `debug:${enabled ? "off" : "on"}`, enabled)}</p>`,
      );
    }
    rows.push(`<p>${t("configure-trolling")} ${configure("trolling")}</p>`);
    rows.push(`<p>${t("configure-proactive")} ${configure("proactive")}</p>`);
    if (isBotAdmin(ctx))
      rows.push(`<p>${t("configure-effort")} ${configure("effort")}</p>`);
    html = rows.join("\n");
  } else if (page === "emoji") {
    const packs = await listEmojiPacks(ctx.database);
    const items = await Promise.all(
      packs.map(
        async (pack) =>
          `<li>${escapeHtml(pack.name)} ${button(ctx.t("configure-remove"), `remove:${await packKey(pack.name)}`)}</li>`,
      ),
    );
    html = items.length
      ? `<ul>${items.join("")}</ul>`
      : `<p>${t("configure-no-emoji")}</p>`;
  } else if (page === "models") {
    html = `<table><tr><th>${t("configure-kind")}</th><th>${t("configure-deployment")}</th></tr>${LLM_DEPLOYMENT_OPTIONS.map((model) => `<tr><td>${escapeHtml(model.id.startsWith("image") ? ctx.t(`settings-model-${model.id}`) : model.id)}</td><td>${escapeHtml(model.deploymentName || ctx.t("settings-model-not-set"))}</td></tr>`).join("")}</table><p>${t("configure-model-usage")}</p>`;
  } else if (page === "trolling" || page === "proactive") {
    const status =
      page === "trolling"
        ? await getTrollingSettings(ctx.database, ctx.chat.id)
        : await getProactiveResponseSettings(ctx.database, ctx.chat.id);
    html = `<p>${escapeHtml(ctx.t(`configure-${page}-description`, { count: status.intervalMessageCount }))}</p><p>${toggle(ctx, `${page}:${status.enabled ? "off" : "on"}`, status.enabled)}${status.enabled ? ` · <code>/${page} ${status.intervalMessageCount}</code>` : ""}</p>`;
  } else {
    const rows = await Promise.all(
      LLM_DEPLOYMENT_OPTIONS.map(async (model) => {
        const effort = await getChatReasoningEffort(
          ctx.database,
          chatId,
          model.id,
        );
        const active = selected === "all" || selected === model.id;
        const cell = (value: string) =>
          `<td>${active ? `<mark>${escapeHtml(value)}</mark>` : escapeHtml(value)}</td>`;
        return `<tr>${cell(model.id)}${cell(ctx.t(`settings-value-${effort ?? "null"}`))}<td>${configure(`effort:${model.id}`, active)}</td></tr>`;
      }),
    );
    html = `<table><tr><th>${t("configure-kind")}</th><th>${t("configure-effort")}</th><th>${t("configure-button")}</th></tr>${rows.join("")}</table><p>${button(ctx.t("configure-all"), "effort:all", selected === "all" ? "primary" : undefined)}</p>`;
    if (selected) {
      const values = await Promise.all(
        LLM_DEPLOYMENT_OPTIONS.map((model) =>
          getChatReasoningEffort(ctx.database, chatId, model.id),
        ),
      );
      const current =
        selected === "all"
          ? values.every((value) => value === values[0])
            ? values[0]
            : undefined
          : await getChatReasoningEffort(ctx.database, ctx.chat.id, selected);
      html += `<tg-button-row>${EFFORTS.map((effort) => button(ctx.t(`settings-value-${effort}`), `set:${selected}:${effort}`, effort === current ? "primary" : undefined)).join("")}</tg-button-row>`;
    }
  }
  if (page !== "menu")
    html += `<p>${button(ctx.t("configure-back"), "menu")}</p>`;
  return { html, skip_entity_detection: true };
}

configureComposer.command("settings", async (ctx) => {
  if (!ctx.chat) return;
  if (!(await canConfigureChat(ctx))) {
    await ctx.reply(ctx.t("settings-admin-warning-chat"));
    return;
  }
  await ctx.replyWithRichMessage(await buildRichConfigureMessage(ctx));
});

configureComposer.callbackQuery(/^cfg:/, async (ctx) => {
  if (!ctx.chat || !(await canConfigureChat(ctx))) {
    await ctx.answerCallbackQuery({
      text: ctx.t("settings-admin-warning-chat"),
      show_alert: true,
    });
    return;
  }
  const [action, target, value, extra] = ctx.callbackQuery.data
    .slice(4)
    .split(":");
  if (
    ["models", "debug", "effort", "set"].includes(action) &&
    !isBotAdmin(ctx)
  ) {
    await ctx.answerCallbackQuery({
      text: ctx.t("settings-error-debug-reasoning-admin-only"),
      show_alert: true,
    });
    return;
  }
  let page: Page = "menu";
  let selected: LlmSettingsDeployment | undefined;
  const invalid = async () => {
    await ctx.answerCallbackQuery({
      text: ctx.t("settings-error-unknown-configuration"),
      show_alert: true,
    });
  };
  if (extra || (value && action !== "set")) return await invalid();
  if (action === "debug" && (target === "on" || target === "off")) {
    await persistChatDebugMode(ctx.database, ctx.chat.id, target === "on");
  } else if (
    (action === "trolling" || action === "proactive") &&
    (!target || target === "on" || target === "off")
  ) {
    page = action;
    if (target) {
      const setEnabled =
        action === "trolling"
          ? setTrollingEnabled
          : setProactiveResponseEnabled;
      await setEnabled(ctx.database, ctx.chat.id, target === "on");
    }
  } else if (action === "remove" && target) {
    const packs = await listEmojiPacks(ctx.database);
    const keys = await Promise.all(packs.map((pack) => packKey(pack.name)));
    const pack = packs[keys.indexOf(target)];
    if (pack) await removeEmojiPack(ctx.database, pack.name, "emoji_packs");
    page = "emoji";
  } else if (
    action === "effort" &&
    (!target || isLlmSettingsDeployment(target))
  ) {
    page = "effort";
    selected = target as LlmSettingsDeployment | undefined;
  } else if (
    action === "set" &&
    target &&
    isLlmSettingsDeployment(target) &&
    EFFORTS.some((effort) => effort === value)
  ) {
    const effort = parseReasoningSetting(value);
    if (effort === undefined) return await invalid();
    await persistChatReasoningEffort(ctx.database, ctx.chat.id, target, effort);
    page = "effort";
    selected = target;
  } else if (["menu", "emoji", "models"].includes(action) && !target) {
    page = action as Page;
  } else {
    return await invalid();
  }
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(
      await buildRichConfigureMessage(ctx, page, selected),
    );
  } catch (error) {
    if (
      !(error instanceof GrammyError) ||
      !error.description.includes("message is not modified")
    )
      throw error;
  }
});
