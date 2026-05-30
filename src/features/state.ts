import { Composer } from "grammy";
import type { Context } from "../bot.ts";

export const stateComposer = new Composer<Context>();

stateComposer.chatType("private").command("start", async (ctx) => {
	await ctx.reply(ctx.t("start", { name: ctx.from.first_name }));
});

stateComposer.chatType("private").command("stop", async (ctx) => {
	await ctx.reply(ctx.t("stop", { name: ctx.from.first_name }));
});
