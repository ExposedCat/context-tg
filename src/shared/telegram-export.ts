import type { JsonObject, JsonValue, TelegramMessage } from "./types.ts";

export type TelegramExportEntity = {
  type?: string;
  text?: string;
};

export type TelegramExportMessage = {
  id: number;
  type?: string;
  date?: string;
  date_unixtime?: string;
  edited?: string;
  edited_unixtime?: string;
  from?: string;
  from_id?: string;
  text?: string | (string | TelegramExportEntity)[];
  reply_to_message_id?: number;
  photo?: string;
  file?: string;
  media_type?: string;
  mime_type?: string;
};

export type TelegramExport = {
  id?: number;
  name?: string;
  type?: string;
  messages: TelegramExportMessage[];
};

function messageText(value: TelegramExportMessage["text"]): string {
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

export function telegramExportMessage(
  item: TelegramExportMessage,
  exported: TelegramExport,
  chatId: number,
): TelegramMessage | null {
  if (item.type && item.type !== "message") {
    return null;
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
  return {
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
}

export function telegramExportMessages(
  exported: TelegramExport,
  chatId: number,
): TelegramMessage[] {
  return exported.messages.flatMap((item) => {
    const message = telegramExportMessage(item, exported, chatId);
    return message ? [message] : [];
  });
}
