import type { TelegramMessage } from "../shared/types.ts";
import type { JobSummary, LoylexDatabase } from "./database.ts";
import { responseOptions } from "./message-options.ts";
import type { TelegramClient } from "./telegram.ts";

const recentTasksLimit = 5;
const taskLabelLength = 40;

const stateEmojis = {
  pending: { id: "6113685078825505075", fallback: "⏳" },
  running: { id: "6113685078825505075", fallback: "⏳" },
  completed: { id: "5825794181183836432", fallback: "✅" },
  failed: { id: "6269316311172518259", fallback: "❌" },
  cancelled: { id: "6269316311172518259", fallback: "❌" },
} satisfies Record<JobSummary["state"], { id: string; fallback: string }>;

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

function statusEmoji(state: JobSummary["state"], useCustomEmoji: boolean): string {
  const emoji = stateEmojis[state];
  return useCustomEmoji
    ? `<tg-emoji emoji-id="${emoji.id}">${emoji.fallback}</tg-emoji>`
    : emoji.fallback;
}

function cancelCommand(task: JobSummary): string {
  return `/cancel_${task.messageId}`;
}

function resumeCommand(task: JobSummary): string {
  return `/resume_${task.messageId}`;
}

function formatTask(task: JobSummary, useCustomEmoji: boolean): string {
  const label = escapeHtml(taskLabel(task.prompt));
  const link = escapeHtmlAttribute(messageLink(task));
  const dates = [formatDate(task.createdAt)];
  if (task.completedAt !== null) {
    dates.push(formatDate(task.completedAt));
  }
  const controls: string[] = [];
  if (task.state === "pending" || task.state === "running") {
    controls.push(cancelCommand(task));
  } else if (task.canResume) {
    controls.push(resumeCommand(task));
  }
  return [
    `${statusEmoji(task.state, useCustomEmoji)} <a href="${link}">${label}</a>`,
    dates.join(" - "),
    ...controls,
  ].join("  \n");
}

export function formatTasksDocument(tasks: JobSummary[], useCustomEmoji = true): string {
  if (tasks.length === 0) {
    return "Задач пока нет.";
  }
  return tasks.map((task) => formatTask(task, useCustomEmoji)).join("\n\n");
}

export async function sendTasks(
  database: LoylexDatabase,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const tasks = database.listRecentJobs(message.chat.id, recentTasksLimit);
  await telegram.sendRich(message.chat.id, formatTasksDocument(tasks), {
    ...responseOptions(message.chat.type, message.message_id, message.message_thread_id ?? null),
    disableLinkPreview: true,
  });
}
