import { createDebug } from "@grammyjs/debug";
import { initBot } from "./bot.ts";
import { type Database, initDatabase } from "./features/database.ts";
import { APP_ENV } from "./features/env.ts";

const [logDebug, logError] = [
	createDebug("app:main:debug"),
	createDebug("app:main:error"),
];

let database: Database;
try {
	const connect = initDatabase();
	database = await connect();
	logDebug("Database connected successfully");
} catch (error) {
	logError("Failed to connect to database", { error });
	Deno.exit(1);
}

try {
	const startBot = initBot(APP_ENV.BOT_TOKEN, database);
	await startBot();
} catch (error) {
	logError("Failed to start bot", { error });
	Deno.exit(1);
}

logDebug("App started successfully");
