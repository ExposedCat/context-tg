import { describe, expect, test } from "bun:test";
import { detectTrigger, isStopCommand } from "../src/gateway/triggers.ts";
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

  test("recognizes /stop only as a reply to Loylex", () => {
    const input = message("/stop@LoylexBot");
    input.reply_to_message = {
      message_id: 10,
      date: 1,
      chat: input.chat,
      from: { id: 42, is_bot: true, first_name: "Loylex", username: "LoylexBot" },
    };

    expect(isStopCommand(input, 42, "LoylexBot")).toBe(true);
    expect(isStopCommand(input, 42, "AnotherBot")).toBe(false);
    expect(detectTrigger(input, 42)).toEqual({ kind: "reply", prompt: "/stop@LoylexBot" });

    input.reply_to_message.from = { id: 8, is_bot: true, first_name: "Other bot" };
    expect(isStopCommand(input, 42, "LoylexBot")).toBe(false);
  });

  test("does not recognize /stop outside a bot reply", () => {
    expect(isStopCommand(message("/stop"), 42, "LoylexBot")).toBe(false);
    expect(isStopCommand(message("/stop now"), 42, "LoylexBot")).toBe(false);
  });
});
