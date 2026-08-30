import { parseArgs } from "node:util";
import { type TelegramExport, telegramExportMessages } from "../shared/telegram-export.ts";
import { LoylexDatabase } from "./database.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    db: { type: "string", default: process.env.LOYLEX_DATABASE_PATH ?? "/data/loylex.sqlite" },
    "chat-id": { type: "string" },
  },
});
const path = positionals[0];
if (!path) {
  throw new Error("Usage: bun src/gateway/import.ts result.json [--chat-id ID] [--db PATH]");
}

const exported = (await Bun.file(path).json()) as TelegramExport;
const chatId = values["chat-id"] ? Number(values["chat-id"]) : exported.id;
if (!chatId || !Number.isSafeInteger(chatId)) {
  throw new Error("Telegram chat ID is missing; pass --chat-id");
}
const database = new LoylexDatabase(values.db);
const messages = telegramExportMessages(exported, chatId);
const imported = database.archiveExportMessages(messages);

database.close();
console.log(JSON.stringify({ imported, chatId, database: values.db }));
