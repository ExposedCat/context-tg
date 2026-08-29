import { describe, expect, test } from "bun:test";
import { detectTrigger } from "../src/gateway/triggers.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

function message(text: string): TelegramMessage {
  return {
    message_id: 1,
    date: 1,
    chat: { id: -100, type: "supergroup" },
    from: { id: 7, is_bot: false, first_name: "Andrii" },
    text,
  };
}

describe("detectTrigger", () => {
  test.each([
    ["loylex status", "status"],
    ["LOYLEX: status", "status"],
    ["Лойлекс — проверь сервер", "проверь сервер"],
    ["  лОйЛеКс, привет", "привет"],
  ])("accepts case-insensitive prefix %s", (input, expected) => {
    expect(detectTrigger(message(input), 42)).toEqual({ kind: "prefix", prompt: expected });
  });

  test("does not match a longer word", () => {
    expect(detectTrigger(message("loylexical"), 42)).toBeNull();
  });

  test("resumes on a reply to the bot", () => {
    const input = message("продолжай");
    input.reply_to_message = {
      message_id: 10,
      date: 1,
      chat: input.chat,
      from: { id: 42, is_bot: true, first_name: "Loylex" },
    };
    expect(detectTrigger(input, 42)).toEqual({ kind: "reply", prompt: "продолжай" });
  });
});
