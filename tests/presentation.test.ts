import { describe, expect, test } from "bun:test";
import { activityLines, failureMessage, stopResultMessage } from "../src/gateway/presentation.ts";

describe("activityLines", () => {
  test("turns shell events into concise user-facing activity", () => {
    const status = [
      "command: /bin/bash -lc 'find skills -maxdepth 2 -name SKILL.md -print'",
      "status: Команда завершена с кодом 0",
      "command: /bin/bash -lc 'free -h; df -h /; uptime'",
    ].join("\n\n");

    expect(activityLines(status)).toEqual(["Подбираю нужные навыки", "Проверяю ресурсы сервера"]);
  });

  test("prefers Codex commentary over command classifications", () => {
    const status = [
      "command: uname -a",
      "commentary: Сначала проверю окружение, затем сопоставлю результаты.",
      "command: git status --short",
    ].join("\n\n");

    expect(activityLines(status)).toEqual([
      "Сначала проверю окружение, затем сопоставлю результаты.",
    ]);
  });

  test("deduplicates command fallback globally without command-specific placeholders", () => {
    const status = [
      "command: uname -a",
      "command: git status --short",
      "command: whoami",
      "command: git diff --stat",
    ].join("\n\n");

    expect(activityLines(status)).toEqual(["Работаю в терминале"]);
  });

  test("describes the result of a stop command", () => {
    expect(stopResultMessage(1)).toBe("⏹️ Остановлено: 1 задача.");
    expect(stopResultMessage(2)).toBe("⏹️ Остановлено: 2 задачи.");
    expect(stopResultMessage(5)).toBe("⏹️ Остановлено: 5 задач.");
    expect(stopResultMessage(0)).toBe("Активных задач для остановки нет.");
  });
});

test("explains a busy Codex thread without exposing CLI diagnostics", () => {
  const message = failureMessage(
    "Codex exited with 1: thread-store conflict: thread abc already has an active writer",
  );

  expect(message).toBe(
    "Не получилось продолжить задачу: этот Codex-тред уже занят другим запросом.\n\nДождись завершения текущей задачи и отправь запрос ещё раз — одновременно выполнять два запроса в одном треде нельзя.",
  );
  expect(message).not.toContain("thread-store conflict");
  expect(message).not.toContain("active writer");
});
