import { Composer } from "grammy";
import { type Static, Type } from "typebox";
import type { Context } from "../bot.ts";

export const chatSchema = Type.Object({
	id: Type.Number(),
});

export type Chat = Static<typeof chatSchema>;

export const chatComposer = new Composer<Context>();

chatComposer.on("message", async (ctx, next) => {
	await ctx.database.chat.updateOne(
		{ id: ctx.chat.id },
		{ $setOnInsert: { id: ctx.chat.id } },
		{ upsert: true },
	);

	await next();
});
