import { createDebug } from "@grammyjs/debug";
import { Bot, type Context as GrammyContext } from "grammy";
import { I18n, type I18nFlavor } from "grammy-i18n";
import { chatComposer } from "./features/chat.ts";
import type { Database } from "./features/database.ts";
import { stateComposer } from "./features/state.ts";

export type Context = GrammyContext &
	I18nFlavor & {
		database: Database;
	};

export function initBot(token: string, database: Database) {
	const logError = createDebug("app:bot:error");

	const bot = new Bot<Context>(token);

	const i18n = new I18n<Context>({
		directory: "locales",
		defaultLocale: "en",
	});

	bot.use((ctx, next) => {
		ctx.database = database;
		return next();
	});

	bot.use(i18n);

	bot.use(chatComposer);
	bot.use(stateComposer);

	bot.catch((error) => logError("Grammy error", { error }));

	return () =>
		new Promise((resolve) =>
			bot.start({
				onStart: () => resolve(undefined),
			}),
		);
}
