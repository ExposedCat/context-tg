import { expect, test } from "bun:test";
import type { JobSummary } from "../src/gateway/database.ts";
import { formatTasksDocument } from "../src/gateway/tasks.ts";

function task(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 1,
    chatId: -100123,
    chatType: "supergroup",
    messageId: 10,
    prompt: "проверь сервер",
    state: "running",
    createdAt: Date.parse("2026-08-30T00:00:00Z"),
    completedAt: null,
    thinkingMessageId: 11,
    ...overrides,
  };
}

test("formats recent tasks with status, safe labels, dates, and message links", () => {
  const document = formatTasksDocument([
    task({ prompt: "<проверь> сервер", completedAt: Date.parse("2026-08-30T00:05:00Z") }),
  ]);

  expect(document).toBe(
    '<tg-emoji emoji-id="6113685078825505075">⏳</tg-emoji> <a href="https://t.me/c/123/11">&lt;проверь&gt; сервер</a>\n2026-08-30 00:00 - 2026-08-30 00:05 - /cancel_10',
  );
});

test("reports an empty task list", () => {
  expect(formatTasksDocument([])).toBe("Задач пока нет.");
});
