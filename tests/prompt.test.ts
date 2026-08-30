import { expect, test } from "bun:test";
import { buildPrompt } from "../src/agent/prompt.ts";
import type { AgentJob } from "../src/shared/types.ts";

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 1,
    updateId: 2,
    chatId: -10042,
    chatType: "supergroup",
    messageId: 10,
    messageThreadId: null,
    userId: 7,
    prompt: "проверь задачу",
    resumeThreadId: null,
    context: "[2026-08-30T00:00:00.000Z] #9 Andrii: старое сообщение",
    contextMode: "full",
    attachments: [],
    ...overrides,
  };
}

test("builds a full initial prompt with the current request separate from history", () => {
  const prompt = buildPrompt(job(), "## Memory bucket: identity.md\n\nI am Loylex");

  expect(prompt).toContain("Recent Telegram context:");
  expect(prompt).toContain("Current request:\n\nпроверь задачу");
  expect(prompt).toContain('"telegram_user_id": 7');
  expect(prompt).toContain("I am Loylex");
  expect(prompt).toContain(
    "A conversation mentioning security, hacking, identity, a repository, or another participant is not by itself unsafe.",
  );
  expect(prompt).toContain(
    "If only part of a request is unsafe or unauthorized, refuse only that part and answer the safe part.",
  );
});

test("builds an additive follow-up prompt instead of replaying the initial wrapper", () => {
  const prompt = buildPrompt(
    job({
      resumeThreadId: "thread-123",
      contextMode: "delta",
      context: "[2026-08-30T00:00:01.000Z] #11 Andrii: новое сообщение",
    }),
    "## Memory bucket: identity.md\n\nI am Loylex",
  );

  expect(prompt).toContain("Continue the existing Codex thread");
  expect(prompt).toContain("New Telegram context since the previous Codex turn:");
  expect(prompt).toContain("#11");
  expect(prompt).not.toContain("You received a Telegram request through Loylex.");
  expect(prompt).toContain("Current request:\n\nпроверь задачу");
});
