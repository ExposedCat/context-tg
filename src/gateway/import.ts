import { parseArgs } from "node:util";
import type { JsonObject, JsonValue, TelegramMessage } from "../shared/types.ts";
import { LoylexDatabase } from "./database.ts";

type ExportEntity = {
  type?: string;
  text?: string;
};

type ExportMessage = {
  id: number;
  type?: string;
  date?: string;
  date_unixtime?: string;
  edited?: string;
  edited_unixtime?: string;
  from?: string;
  from_id?: string;
  text?: string | (string | ExportEntity)[];
  reply_to_message_id?: number;
  photo?: string;
  file?: string;
  media_type?: string;
  mime_type?: string;
};

type TelegramExport = {
  id?: number;
  name?: string;
  type?: string;
  messages: ExportMessage[];
};

function messageText(value: ExportMessage["text"]): string {
  if (typeof value === "string") {
    return value;
  }
  return (value ?? [])
    .map((part) => (typeof part === "string" ? part : (part.text ?? "")))
    .join("");
}

function userId(value: string | undefined): number | undefined {
  const match = value?.match(/(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function unix(value: string | undefined, iso: string | undefined): number {
  if (value) {
    return Number(value);
  }
  if (iso) {
    return Math.floor(new Date(iso).getTime() / 1000);
  }
  return 0;
}

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
let imported = 0;

for (const item of exported.messages) {
  if (item.type && item.type !== "message") {
    continue;
  }
  const exportedMedia: JsonValue[] = [];
  if (item.photo) {
    exportedMedia.push({ kind: "photo", export_path: item.photo });
  }
  if (item.file) {
    exportedMedia.push({
      kind: item.media_type ?? "document",
      export_path: item.file,
      mime_type: item.mime_type ?? null,
    });
  }
  const raw = item as unknown as JsonObject;
  const message: TelegramMessage = {
    message_id: item.id,
    date: unix(item.date_unixtime, item.date),
    ...(item.edited || item.edited_unixtime
      ? { edit_date: unix(item.edited_unixtime, item.edited) }
      : {}),
    chat: {
      id: chatId,
      type: exported.type === "personal_chat" ? "private" : "supergroup",
      ...(exported.name ? { title: exported.name } : {}),
    },
    ...(item.from
      ? {
          from: {
            id: userId(item.from_id) ?? 0,
            is_bot: false,
            first_name: item.from,
          },
        }
      : {}),
    text: messageText(item.text),
    ...(item.reply_to_message_id
      ? {
          reply_to_message: {
            message_id: item.reply_to_message_id,
            date: 0,
            chat: { id: chatId, type: "supergroup" },
          },
        }
      : {}),
    ...(exportedMedia.length > 0
      ? { document: { export_media: exportedMedia } as JsonObject }
      : {}),
    export_raw: raw,
  };
  database.archiveMessage(message, "telegram_export");
  imported += 1;
}

database.close();
console.log(JSON.stringify({ imported, chatId, database: values.db }));
