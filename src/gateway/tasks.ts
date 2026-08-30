import type { TelegramMessage } from "../shared/types.ts";
import type { JobSummary, LoylexDatabase } from "./database.ts";
import type { TelegramClient } from "./telegram.ts";

const recentTasksLimit = 5;
const taskLabelLength = 80;

const stateLabels = {
  pending: "в очереди",
  running: "в работе",
  completed: "готово",
  failed: "ошибка",
  cancelled: "остановлено",
} satisfies Record<JobSummary["state"], string>;

const stateIcons = {
  pending: "⏳",
  running: "🔄",
  completed: "✅",
  failed: "❌",
  cancelled: "⏹️",
} satisfies Record<JobSummary["state"], string>;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function taskLabel(prompt: string): string {
  const normalized = prompt.replaceAll(/\s+/g, " ").trim();
  const label = Array.from(normalized).slice(0, taskLabelLength).join("");
  return label || "Без текста";
}

function datePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return "неизвестно";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "неизвестно";
  }
  return `${date.getFullYear()}-${datePart(date.getMonth() + 1)}-${datePart(date.getDate())} ${datePart(date.getHours())}:${datePart(date.getMinutes())}`;
}

function messageLink(task: JobSummary): string {
  const messageId = task.thinkingMessageId ?? task.messageId;
  const chatId = String(task.chatId);
  if (chatId.startsWith("-100")) {
    return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
  }
  return `tg://openmessage?chat_id=${encodeURIComponent(chatId)}&message_id=${messageId}`;
}

function formatTask(task: JobSummary): string {
  const label = escapeHtml(taskLabel(task.prompt));
  const link = escapeHtmlAttribute(messageLink(task));
  const finished = task.completedAt === null ? "" : ` → ${formatDate(task.completedAt)}`;
  return [
    `${stateIcons[task.state]} <a href="${link}">${label}</a>`,
    `${stateLabels[task.state]} · ${formatDate(task.createdAt)}${finished}`,
  ].join("\n");
}

export function formatTasksDocument(tasks: JobSummary[]): string {
  if (tasks.length === 0) {
    return "Задач пока нет.";
  }
  return [
    "<b>Последние задачи</b>",
    "",
    tasks.map(formatTask).join("\n\n"),
    "",
    "<i>Чтобы остановить задачу, ответь /stop на сообщение Loylex.</i>",
  ].join("\n");
}

export async function sendTasks(
  database: LoylexDatabase,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const tasks = database.listRecentJobs(message.chat.id, recentTasksLimit);
  await telegram.sendRich(message.chat.id, formatTasksDocument(tasks), {
    replyTo: message.message_id,
    threadId: message.message_thread_id ?? null,
  });
}
