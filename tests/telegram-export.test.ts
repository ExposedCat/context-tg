import { expect, test } from "bun:test";
import { type TelegramExport, telegramExportMessages } from "../src/shared/telegram-export.ts";

test("converts Telegram Desktop messages and skips service entries", () => {
  const exported: TelegramExport = {
    id: -10042,
    name: "История",
    type: "group",
    messages: [
      {
        id: 7,
        date: "2026-08-30T12:34:56Z",
        from: "Андрей",
        from_id: "user426043802",
        text: ["Привет, ", { type: "bold", text: "мир" }],
        reply_to_message_id: 3,
      },
      { id: 8, type: "service", date: "2026-08-30T12:35:00Z" },
    ],
  };

  const [message] = telegramExportMessages(exported, -10042);
  expect(message?.message_id).toBe(7);
  expect(message?.date).toBe(1_788_093_296);
  expect(message?.chat).toEqual({ id: -10042, type: "supergroup", title: "История" });
  expect(message?.from).toEqual({
    id: 426043802,
    is_bot: false,
    first_name: "Андрей",
  });
  expect(message?.text).toBe("Привет, мир");
  expect(message?.reply_to_message?.message_id).toBe(3);
});
