import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoylexDatabase } from "../src/gateway/database.ts";
import type { TelegramMessage, TelegramUpdate } from "../src/shared/types.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(): LoylexDatabase {
  const directory = mkdtempSync(join(tmpdir(), "loylex-db-"));
  directories.push(directory);
  return new LoylexDatabase(join(directory, "test.sqlite"));
}

function message(id: number, text: string): TelegramMessage {
  return {
    message_id: id,
    date: 1_700_000_000 + id,
    chat: { id: -10042, type: "supergroup", title: "Test" },
    from: { id: 7, is_bot: false, first_name: "Andrii", username: "chelokot" },
    text,
  };
}

function botMessage(id: number, text: string): TelegramMessage {
  return {
    message_id: id,
    date: 1_700_000_000 + id,
    chat: { id: -10042, type: "supergroup", title: "Test" },
    from: { id: 99, is_bot: true, first_name: "Loylex" },
    text,
  };
}

describe("LoylexDatabase", () => {
  test("archives, indexes, claims, and resumes a thread", () => {
    const database = setup();
    database.archiveMessage(message(1, "предыдущий контекст"), "bot_api");
    const incoming = message(2, "Лойлекс, запомни этот контекст");
    const update: TelegramUpdate = { update_id: 55, message: incoming };
    database.archiveUpdate(update);
    database.enqueue(55, incoming, "запомни этот контекст", null);

    database.archiveMessage(message(3, "сообщение после индикатора"), "bot_api");

    const job = database.claimNext(10);
    expect(job?.prompt).toBe("запомни этот контекст");
    expect(job?.context).toContain("@chelokot");
    expect(job?.context).toContain("#1");
    expect(job?.context).not.toContain("#2");
    expect(job?.contextMode).toBe("full");
    expect(database.search("запомни", -10042, 10)).toHaveLength(1);

    database.complete(job?.id ?? 0, 99, "thread-123");
    expect(database.resumeThread(-10042, 99)).toBe("thread-123");
    database.close();
  });

  test("passes only new chat messages when resuming a Codex thread", () => {
    const database = setup();
    const incoming = message(1, "Лойлекс, начни задачу");
    database.archiveMessage(incoming, "bot_api");
    database.enqueue(55, incoming, "начни задачу", null);

    const first = database.claimNext(10);
    expect(first).not.toBeNull();
    database.appendStatus(first?.id ?? 0, "commentary: работаю", "thread-123");
    database.complete(first?.id ?? 0, 2, "thread-123");
    database.archiveMessage(botMessage(2, "Готово"), "bot_api");

    database.archiveMessage(message(3, "сообщение между запросами"), "bot_api");
    const followUp = message(4, "продолжай");
    database.archiveMessage(followUp, "bot_api");
    database.enqueue(56, followUp, "продолжай", "thread-123");

    const resumed = database.claimNext(10);
    expect(resumed?.contextMode).toBe("delta");
    expect(resumed?.context).toContain("#3");
    expect(resumed?.context).not.toContain("#1");
    expect(resumed?.context).not.toContain("#2");
    expect(resumed?.context).not.toContain("#4");
    database.close();
  });

  test("serializes jobs for one Codex thread without blocking unrelated threads", () => {
    const database = setup();
    const first = message(1, "первая задача");
    const second = message(2, "вторая задача");
    const unrelated = message(3, "другая задача");
    database.enqueue(55, first, "первая", "thread-123");
    database.enqueue(56, second, "вторая", "thread-123");
    database.enqueue(57, unrelated, "другая", "thread-456");

    const firstJob = database.claimNext(10, "worker-a");
    expect(firstJob?.messageId).toBe(1);
    const unrelatedJob = database.claimNext(10, "worker-b");
    expect(unrelatedJob?.messageId).toBe(3);
    expect(database.claimNext(10, "worker-c")).toBeNull();

    expect(database.complete(firstJob?.id ?? 0, 11, "thread-123", "worker-a")).toBe(true);
    const secondJob = database.claimNext(10, "worker-c");
    expect(secondJob?.messageId).toBe(2);
    expect(database.complete(unrelatedJob?.id ?? 0, 12, "thread-456", "worker-b")).toBe(true);
    database.close();
  });

  test("updates edited messages without duplicating them", () => {
    const database = setup();
    database.archiveMessage(message(2, "первая версия"), "bot_api");
    database.archiveMessage(message(2, "исправленная версия"), "bot_api");

    expect(database.stats().messages).toBe(1);
    expect(database.search("исправленная", null, 10)[0]?.messageId).toBe(2);
    expect(database.search("первая", null, 10)).toHaveLength(0);
    database.close();
  });

  test("cancels active jobs linked to an outbound message and its Codex thread", () => {
    const database = setup();
    const incoming = message(1, "Лойлекс, начни долгую работу");
    database.archiveUpdate({ update_id: 55, message: incoming });
    database.enqueue(55, incoming, "начни долгую работу", null);

    const running = database.claimNext(10);
    expect(running).not.toBeNull();
    const runningJobId = running?.id ?? 0;
    database.setThinkingMessage(runningJobId, 10);
    database.appendStatus(runningJobId, "commentary: работаю", "thread-123");

    const queued = message(2, "продолжай");
    database.enqueue(56, queued, "продолжай", "thread-123");

    expect(database.cancelJobsForMessage(-10042, 10)).toEqual([runningJobId, runningJobId + 1]);
    expect(database.isJobCancelled(runningJobId)).toBe(true);
    expect(database.complete(runningJobId, 99, "thread-123")).toBe(false);
    expect(database.claimNext(10)).toBeNull();
    database.close();
  });

  test("lists the latest jobs for one chat with their current state", () => {
    const database = setup();
    const incoming = message(1, "Лойлекс, проверь очередь");
    database.archiveUpdate({ update_id: 55, message: incoming });
    database.enqueue(55, incoming, "проверь очередь", null);

    const running = database.claimNext(10);
    expect(running).not.toBeNull();
    const runningJobId = running?.id ?? 0;
    database.setThinkingMessage(runningJobId, 10);
    database.complete(runningJobId, 11, "thread-123");

    const queued = message(2, "Лойлекс, подожди");
    database.enqueue(56, queued, "подожди", null);

    expect(database.listRecentJobs(-10042)).toEqual([
      {
        id: runningJobId + 1,
        chatId: -10042,
        chatType: "supergroup",
        messageId: 2,
        prompt: "подожди",
        state: "pending",
        createdAt: expect.any(Number),
        completedAt: null,
        thinkingMessageId: null,
      },
      {
        id: runningJobId,
        chatId: -10042,
        chatType: "supergroup",
        messageId: 1,
        prompt: "проверь очередь",
        state: "completed",
        createdAt: expect.any(Number),
        completedAt: expect.any(Number),
        thinkingMessageId: 10,
      },
    ]);
    database.close();
  });
});
