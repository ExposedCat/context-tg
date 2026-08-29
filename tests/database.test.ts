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

describe("LoylexDatabase", () => {
  test("archives, indexes, claims, and resumes a thread", () => {
    const database = setup();
    const incoming = message(1, "Лойлекс, запомни этот контекст");
    const update: TelegramUpdate = { update_id: 55, message: incoming };
    database.archiveUpdate(update);
    database.enqueue(55, incoming, "запомни этот контекст", null);

    database.archiveMessage(message(2, "сообщение после индикатора"), "bot_api");

    const job = database.claimNext(10);
    expect(job?.prompt).toBe("запомни этот контекст");
    expect(job?.context).toContain("@chelokot");
    expect(database.search("контекст", -10042, 10)).toHaveLength(1);

    database.complete(job?.id ?? 0, 99, "thread-123");
    expect(database.resumeThread(-10042, 99)).toBe("thread-123");
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
});
