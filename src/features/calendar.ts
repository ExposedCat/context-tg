import { Composer, GrammyError } from "grammy";
import type { Context } from "../bot.ts";
import { escapeHtml } from "../utils/text.ts";
import { canConfigureChat } from "./authorization.ts";
import {
  beginCalendarSetup,
  type CalendarChallengeTable,
  getCalendarChallenge,
  verifyCalendarSetup,
} from "./calendar-settings.ts";
import { getGoogleCalendarApi } from "./google-calendar.ts";

export const calendarComposer = new Composer<Context>();

async function canSetCalendar(ctx: Context): Promise<boolean> {
  return Boolean(
    ctx.from &&
      ctx.chat &&
      (ctx.chat.type === "private" || (await canConfigureChat(ctx))),
  );
}

function replyOptions(ctx: Context) {
  return {
    ...(ctx.msg?.message_thread_id
      ? { message_thread_id: ctx.msg.message_thread_id }
      : {}),
    ...(ctx.message?.ephemeral_message_id !== undefined
      ? {
          reply_parameters: {
            ephemeral_message_id: ctx.message.ephemeral_message_id,
          },
        }
      : {}),
    ...(ctx.from &&
    (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup")
      ? {
          ephemeral_message_parameters: { receiver_user_id: ctx.from.id },
        }
      : {}),
  };
}

async function reply(ctx: Context, text: string) {
  return ctx.replyWithRichMessage(
    { html: `<p>${escapeHtml(text)}</p>`, skip_entity_detection: true },
    replyOptions(ctx),
  );
}

function calendarHelp(ctx: Context, email?: string) {
  const t = (key: string) => escapeHtml(ctx.t(key));
  return {
    html: [
      `<h3>${t("calendar-help-title")}</h3>`,
      `<p><b>${t("calendar-help-share-title")}</b><br>${t("calendar-help-share")}</p>`,
      email
        ? `<pre><code>${escapeHtml(email)}</code></pre>`
        : `<p><i>${t("calendar-help-no-account")}</i></p>`,
      `<p><b>${t("calendar-help-id-title")}</b><br>${t("calendar-help-id")}</p>`,
      `<p><b>${t("calendar-help-connect-title")}</b></p>`,
      "<pre><code>/calendar ID</code></pre>",
      `<p>${t("calendar-help-enable")} <b>Calendar MCP</b> · <code>/settings</code></p>`,
    ].join("\n"),
    skip_entity_detection: true as const,
  };
}

function calendarChallengeMessage(
  ctx: Context,
  challenge: CalendarChallengeTable,
  error?: string,
) {
  return {
    html: [
      `<h3>${escapeHtml(ctx.t("calendar-challenge-title"))}</h3>`,
      `<p>${escapeHtml(ctx.t("calendar-challenge", { day: challenge.day }))}</p>`,
      `<pre><code>${escapeHtml(challenge.title)}</code></pre>`,
      `<ul><li>${escapeHtml(ctx.t("calendar-challenge-event"))}</li><li>${escapeHtml(ctx.t("calendar-challenge-expiry"))}</li></ul>`,
      ...(error
        ? [
            `<p><b>${escapeHtml(ctx.t("calendar-verification-failed"))}</b><br>${escapeHtml(error)}</p>`,
          ]
        : []),
      `<p><i>${escapeHtml(ctx.t("calendar-challenge-access"))}</i></p>`,
      `<p><tg-button type="callback_data" style="primary" data="calverify:${challenge.token}">${escapeHtml(ctx.t("calendar-verify"))}</tg-button></p>`,
    ].join("\n"),
    skip_entity_detection: true as const,
  };
}

async function editCalendarMessage(
  ctx: Context,
  message: { html: string; skip_entity_detection: true },
) {
  try {
    if (ctx.msg?.ephemeral_message_id !== undefined)
      await ctx.editEphemeralMessageText(message);
    else await ctx.editMessageText(message);
  } catch (error) {
    if (
      !(error instanceof GrammyError) ||
      !error.description.includes("message is not modified")
    )
      throw error;
  }
}

calendarComposer.command("calendar", async (ctx) => {
  if (!ctx.chat || !ctx.from) return;
  if (!(await canSetCalendar(ctx))) {
    await reply(ctx, ctx.t("settings-admin-warning-chat"));
    return;
  }
  const calendarId = ctx.match.trim();
  if (!calendarId) {
    let email: string | undefined;
    try {
      const api = await getGoogleCalendarApi();
      email = api.email;
    } catch {
      // Usage remains available before the administrator installs credentials.
    }
    await ctx.replyWithRichMessage(calendarHelp(ctx, email), replyOptions(ctx));
    return;
  }
  try {
    const api = await getGoogleCalendarApi();
    const challenge = await beginCalendarSetup(
      ctx.database,
      ctx.chat.id,
      ctx.from.id,
      calendarId,
      api,
    );
    const message = await ctx.replyWithRichMessage(
      calendarChallengeMessage(ctx, challenge),
      replyOptions(ctx),
    );
    await ctx.database
      .updateTable("calendar_challenges")
      .set({ message_id: message.ephemeral_message_id ?? message.message_id })
      .where("chat_id", "=", ctx.chat.id)
      .where("token", "=", challenge.token)
      .execute();
  } catch (error) {
    await reply(
      ctx,
      ctx.t("calendar-error", {
        error:
          error instanceof Error ? error.message : "Calendar setup failed.",
      }),
    );
  }
});

calendarComposer.callbackQuery(/^calverify:([a-f0-9]{32})$/, async (ctx) => {
  if (!ctx.chat || !ctx.from) return;
  const token = ctx.match[1];
  const challenge = await getCalendarChallenge(ctx.database, ctx.chat.id);
  if (
    !challenge ||
    challenge.token !== token ||
    challenge.user_id !== ctx.from.id ||
    challenge.message_id === null ||
    challenge.message_id !==
      (ctx.msg?.ephemeral_message_id ?? ctx.msg?.message_id)
  ) {
    await ctx.answerCallbackQuery({
      text: ctx.t("calendar-wrong-verification"),
      show_alert: true,
    });
    return;
  }
  if (!(await canSetCalendar(ctx))) {
    await ctx.answerCallbackQuery({
      text: ctx.t("settings-admin-warning-chat"),
      show_alert: true,
    });
    return;
  }
  await ctx.answerCallbackQuery({ text: ctx.t("calendar-verifying") });
  try {
    const binding = await verifyCalendarSetup(
      ctx.database,
      ctx.chat.id,
      ctx.from.id,
      token,
      await getGoogleCalendarApi(),
    );
    const message = {
      html: `<p>${escapeHtml(ctx.t("calendar-configured", { name: binding.name }))}</p>`,
      skip_entity_detection: true as const,
    };
    // Replacing the complete message also removes its Verify button.
    await editCalendarMessage(ctx, message);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Calendar verification failed.";
    try {
      await editCalendarMessage(
        ctx,
        calendarChallengeMessage(ctx, challenge, detail),
      );
    } catch {
      // A missing/uneditable setup message must not hide the verification error.
      // Callback messages are bot messages, not valid ephemeral reply targets.
      await reply(ctx, ctx.t("calendar-error", { error: detail }));
    }
  }
});
