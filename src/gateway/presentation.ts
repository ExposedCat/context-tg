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
  if (normalized.includes("git ")) {
    return "Проверяю состояние проекта";
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
  const lines: string[] = [];
  for (const entry of status.split("\n\n")) {
    const separator = entry.indexOf(":");
    const kind = separator === -1 ? "status" : entry.slice(0, separator);
    const text = (separator === -1 ? entry : entry.slice(separator + 1)).trim();
    let visible: string | null = null;
    if (kind === "command") {
      visible = commandActivity(text);
    } else if (kind === "reasoning" || kind === "commentary") {
      visible = text.slice(0, 280);
    } else if (text === "Начал работу") {
      visible = text;
    }
    if (visible && lines.at(-1) !== visible) {
      lines.push(visible);
    }
  }
  return lines;
}
