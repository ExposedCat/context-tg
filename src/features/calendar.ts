import { Composer, GrammyError } from "grammy";
import type { Context } from "../bot.ts";
import { escapeHtml } from "../utils/text.ts";
import { canConfigureChat } from "./authorization.ts";
import {
  beginCalendarSetup,
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
    ...(ctx.msg?.ephemeral_message_id !== undefined
      ? {
          reply_parameters: {
            ephemeral_message_id: ctx.msg.ephemeral_message_id,
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

calendarComposer.command("calendar", async (ctx) => {
  if (!ctx.chat || !ctx.from) return;
  if (!(await canSetCalendar(ctx))) {
    await reply(ctx, ctx.t("settings-admin-warning-chat"));
    return;
  }
  const calendarId = ctx.match.trim();
  if (!calendarId) {
    let help = ctx.t("calendar-usage");
    try {
      const api = await getGoogleCalendarApi();
      help += `\n${ctx.t("calendar-service-account", { email: api.email })}`;
    } catch {
      // Usage remains available before the administrator installs credentials.
    }
    await reply(ctx, help);
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
      {
        html: `<p>${escapeHtml(ctx.t("calendar-challenge", { email: api.email, day: challenge.day }))}</p><p><code>${escapeHtml(challenge.title)}</code></p><p><tg-button type="callback_data" data="calverify:${challenge.token}">${escapeHtml(ctx.t("calendar-verify"))}</tg-button></p>`,
        skip_entity_detection: true,
      },
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
  await ctx.answerCallbackQuery();
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
    if (ctx.msg?.ephemeral_message_id !== undefined)
      await ctx.editEphemeralMessageText(message);
    else await ctx.editMessageText(message);
  } catch (error) {
    if (
      error instanceof GrammyError &&
      error.description.includes("message is not modified")
    )
      return;
    await reply(
      ctx,
      ctx.t("calendar-error", {
        error:
          error instanceof Error
            ? error.message
            : "Calendar verification failed.",
      }),
    );
  }
});
