import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoylexDatabase } from "../src/gateway/database.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archives imported messages in one batch and exposes their media", () => {
  const directory = mkdtempSync(join(tmpdir(), "loylex-import-"));
  directories.push(directory);
  const database = new LoylexDatabase(join(directory, "test.sqlite"));
  const message: TelegramMessage = {
    message_id: 1,
    date: 1_700_000_001,
    chat: { id: -10042, type: "supergroup", title: "Test" },
    from: { id: 7, is_bot: false, first_name: "Andrii" },
    text: "историческое сообщение",
    document: { file_id: "file-1", file_name: "part-000" },
  };

  expect(database.archiveExportMessages([message])).toBe(1);
  expect(database.archiveExportMessages([message])).toBe(1);
  expect(database.stats().messages).toBe(1);
  expect(database.archivedMedia(-10042, 10)).toEqual([
    {
      chatId: -10042,
      messageId: 1,
      date: 1_700_000_001,
      source: "telegram_export",
      media: [{ kind: "document", value: { file_id: "file-1", file_name: "part-000" } }],
    },
  ]);
  database.close();
});
