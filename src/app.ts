import { createDebug } from "@grammyjs/debug";
import { initBot } from "./bot.ts";
import { type Database, initDatabase } from "./features/database.ts";

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
	const botToken = Deno.env.get("BOT_TOKEN");
	if (!botToken) {
		throw new Error("BOT_TOKEN is not set");
	}
	const startBot = initBot(botToken, database);
	await startBot();
} catch (error) {
	logError("Failed to start bot", { error });
	Deno.exit(1);
}

logDebug("App started successfully");
