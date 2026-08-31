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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function workDocument(status: string): string {
  const activity = visibleActivity(status);
  const history = activity.map((line) => `- ${escapeHtml(line)}`).join("\n");
  return `<details><summary>Ход работы</summary>\n\n${history || "- Готово"}\n\n</details>`;
}

function visibleActivity(status: string): string[] {
  return activityLines(status).slice(-8);
}

export const richMessageLimitBytes = 30_000;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function takeRichChunk(value: string, maxBytes: number): [string, string] {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    end += character.length;
  }
  if (end === 0) {
    throw new Error("Rich message chunk limit is too small for one character");
  }
  const candidate = value.slice(0, end);
  const newline = candidate.lastIndexOf("\n");
  // Prefer paragraph/line boundaries while keeping very long lines deliverable.
  const boundary = newline >= Math.floor(candidate.length / 2) ? newline + 1 : end;
  return [value.slice(0, boundary), value.slice(boundary)];
}

export function splitRichMarkdown(markdown: string, maxBytes = richMessageLimitBytes): string[] {
  if (maxBytes <= 0) {
    throw new Error("Rich message chunk limit must be positive");
  }
  if (byteLength(markdown) <= maxBytes) {
    return [markdown];
  }
  const chunks: string[] = [];
  let remaining = markdown;
  while (remaining.length > 0) {
    const [chunk, rest] = takeRichChunk(remaining, maxBytes);
    chunks.push(chunk);
    remaining = rest;
  }
  return chunks;
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

export function failedDocument(status: string, error: string): string {
  return `${workDocument(status)}\n\n${failureMessage(error)}`;
}

export function completedDocuments(status: string, answer: string): string[] {
  const prefix = `${workDocument(status)}\n\n`;
  const availableAnswerBytes = richMessageLimitBytes - byteLength(prefix);
  if (availableAnswerBytes <= 0) {
    return splitRichMarkdown(`${prefix}${answer}`);
  }
  const answerChunks = splitRichMarkdown(answer, availableAnswerBytes);
  return [`${prefix}${answerChunks[0] ?? ""}`, ...answerChunks.slice(1)];
}

export function helpMessage(): string {
  return [
    "**Loylex — универсальный Linux-агент**",
    "",
    "В личке можно писать обычным сообщением — оно продолжит последний Codex-тред без reply. Ответ на старое сообщение переключит запрос в тред этого сообщения. `/newchat сообщение` начнёт новый чистый тред. В группах по-прежнему используй `Лойлекс, ...` или reply на сообщение Loylex.",
    "",
    "`/tasks` — последние задачи; в ЛС активный draft можно остановить кнопкой Stop, а в группах `/stop` отправляется reply на рабочее сообщение; `/cancel_ID` — остановить задачу; `/resume_ID` — продолжить прерванную задачу, если у неё сохранился Codex-тред.",
    "",
    "Текст, изображения и файлы текущего сообщения передаются агенту через защищённый bridge. Для напоминаний и периодических действий можно попросить настроить cron/systemd timer на Linux-машине.",
  ].join("\n");
}

export function resumeUnavailableMessage(): string {
  return "Эту задачу пока нельзя продолжить: для неё не сохранился Codex-тред. Запусти её заново новым запросом.";
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
