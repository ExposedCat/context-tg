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
  const fallback: string[] = [];
  const narrative: string[] = [];
  let started = false;
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
    } else if (text === "Начал работу") {
      started = true;
    }
  }
  return [...(started ? ["Начал работу"] : []), ...(narrative.length > 0 ? narrative : fallback)];
}
