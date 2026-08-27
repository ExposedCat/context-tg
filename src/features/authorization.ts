import type { Context } from "../bot.ts";
import { APP_ENV } from "./env.ts";

export function isBotAdmin(ctx: Context): boolean {
  return ctx.from?.id === APP_ENV.ADMIN_ID;
}

export async function canConfigureChat(ctx: Context): Promise<boolean> {
  if (isBotAdmin(ctx)) {
    return true;
  }

  if (
    !ctx.from ||
    !ctx.chat ||
    (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")
  ) {
    return false;
  }

  const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);

  return member.status === "creator" || member.status === "administrator";
}
