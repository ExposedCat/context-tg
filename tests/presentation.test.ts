import { describe, expect, test } from "bun:test";
import { activityLines } from "../src/gateway/presentation.ts";

describe("activityLines", () => {
  test("turns shell events into concise user-facing activity", () => {
    const status = [
      "status: Начал работу",
      "command: /bin/bash -lc 'find skills -maxdepth 2 -name SKILL.md -print'",
      "status: Команда завершена с кодом 0",
      "command: /bin/bash -lc 'free -h; df -h /; uptime'",
    ].join("\n\n");

    expect(activityLines(status)).toEqual([
      "Начал работу",
      "Подбираю нужные навыки",
      "Проверяю ресурсы сервера",
    ]);
  });

  test("deduplicates repeated generic terminal activity", () => {
    const status = ["command: uname -a", "command: whoami", "reasoning: Проверяю результат"].join(
      "\n\n",
    );

    expect(activityLines(status)).toEqual(["Работаю в терминале", "Проверяю результат"]);
  });
});
