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
    canResume: false,
    ...overrides,
  };
}

test("formats recent tasks with status, safe labels, dates, and message links", () => {
  const document = formatTasksDocument([
    task({
      prompt: "<проверь> сервер",
      state: "completed",
      completedAt: Date.parse("2026-08-30T00:05:00Z"),
    }),
  ]);

  expect(document).toBe(
    '<tg-emoji emoji-id="5825794181183836432">✅</tg-emoji> <a href="https://t.me/c/123/11">&lt;проверь&gt; сервер</a>\n2026-08-30 00:00 - 2026-08-30 00:05',
  );
});

test("keeps task controls below the date line", () => {
  expect(formatTasksDocument([task()])).toBe(
    '<tg-emoji emoji-id="6113685078825505075">⏳</tg-emoji> <a href="https://t.me/c/123/11">проверь сервер</a>\n2026-08-30 00:00\n/cancel_10',
  );
});

test("reports an empty task list", () => {
  expect(formatTasksDocument([])).toBe("Задач пока нет.");
});
