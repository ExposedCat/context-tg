function commandActivity(command: string): string {
  const normalized = command.toLowerCase();
  if (normalized.includes("find skills") || normalized.includes("-name skill.md")) {
    return "Подбираю нужные навыки";
  }
  if (normalized.includes("skill.md")) {
    return "Читаю рабочие инструкции";
  }
  if (
    normalized.includes("free -") ||
    normalized.includes("df -") ||
    normalized.includes("/proc/cpuinfo") ||
    normalized.includes("/proc/loadavg") ||
    normalized.includes("uptime")
  ) {
    return "Проверяю ресурсы сервера";
  }
  if (normalized.includes("systemctl") || normalized.includes("ps -")) {
    return "Проверяю процессы и сервисы";
  }
  if (normalized.includes("loylex status")) {
    return "Проверяю Telegram и очередь задач";
  }
  if (normalized.includes("curl ") || normalized.includes("wget ")) {
    return "Получаю данные из сети";
  }
  return "Работаю в терминале";
}

export function activityLines(status: string): string[] {
  const fallback: string[] = [];
  const narrative: string[] = [];
  for (const entry of status.split("\n\n")) {
    const separator = entry.indexOf(":");
    const kind = separator === -1 ? "status" : entry.slice(0, separator);
    const text = (separator === -1 ? entry : entry.slice(separator + 1)).trim();
    if (kind === "command") {
      const visible = commandActivity(text);
      if (!fallback.includes(visible)) {
        fallback.push(visible);
      }
    } else if (kind === "reasoning" || kind === "commentary") {
      const visible = text.slice(0, 600);
      if (visible && narrative.at(-1) !== visible) {
        narrative.push(visible);
      }
    }
  }
  return narrative.length > 0 ? narrative : fallback;
}

export function failureMessage(error: string): string {
  if (/thread-store conflict\b[\s\S]*\bactive writer\b/i.test(error)) {
    return "Не получилось продолжить задачу: этот Codex-тред уже занят другим запросом.\n\nДождись завершения текущей задачи и отправь запрос ещё раз — одновременно выполнять два запроса в одном треде нельзя.";
  }
  return `Не получилось завершить задачу.\n\n\`\`\`text\n${error.slice(0, 2_000)}\n\`\`\``;
}

function taskCountLabel(count: number): string {
  const moduloTen = count % 10;
  const moduloHundred = count % 100;
  if (moduloTen === 1 && moduloHundred !== 11) {
    return "задача";
  }
  if (moduloTen >= 2 && moduloTen <= 4 && (moduloHundred < 10 || moduloHundred >= 20)) {
    return "задачи";
  }
  return "задач";
}

export function stopResultMessage(cancelledCount: number): string {
  return cancelledCount > 0
    ? `⏹️ Остановлено: ${cancelledCount} ${taskCountLabel(cancelledCount)}.`
    : "Активных задач для остановки нет.";
}
