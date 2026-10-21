import type { Context } from "../bot.ts";

export function isBotAdminId(userId: number | undefined): boolean {
  return userId !== undefined && userId === Number(Bun.env.ADMIN_ID);
}

export function isBotAdmin(ctx: Context): boolean {
  return isBotAdminId(ctx.from?.id);
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
