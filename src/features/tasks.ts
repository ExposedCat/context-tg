import type { ColumnType, Insertable, Selectable } from "@kysely/kysely";
import type { Context } from "../bot.ts";
import type { Database } from "./database.ts";

export type TasksTable = {
  chat_id: number;
  message_id: number;
  task_text: string;
  started_at: number;
  status: ColumnType<TaskStatus, TaskStatus | undefined, TaskStatus>;
  finished_at: ColumnType<
    number | null,
    number | null | undefined,
    number | null
  >;
};

export type Task = Selectable<TasksTable>;
export type CreateTask = Insertable<TasksTable>;
export type TaskKey = Pick<Task, "chat_id" | "message_id">;
export type TaskStatus = "working" | "finished" | "failed" | "canceled";

const RECENT_TASKS_LIMIT = 5;
const TASK_LABEL_LENGTH = 15;
const STATUS_EMOJI_IDS = {
  working: "6113685078825505075",
  finished: "5825794181183836432",
  failed: "6269316311172518259",
  canceled: "6269316311172518259",
} satisfies Record<TaskStatus, string>;
const activeTaskControllers = new Map<string, AbortController>();

type CancelTaskResult = "canceled" | "not_found" | "not_working";

export async function migrateTasks(database: Database) {
  await database.schema
    .createTable("tasks")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("message_id", "integer", (column) => column.notNull())
    .addColumn("task_text", "text", (column) => column.notNull())
    .addColumn("started_at", "integer", (column) => column.notNull())
    .addColumn("status", "text", (column) =>
      column.notNull().defaultTo("working"),
    )
    .addColumn("finished_at", "integer")
    .addPrimaryKeyConstraint("tasks_primary_key", ["chat_id", "message_id"])
    .execute();

  try {
    await database.schema
      .alterTable("tasks")
      .addColumn("status", "text", (column) =>
        column.notNull().defaultTo("working"),
      )
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
  }

  await database
    .updateTable("tasks")
    .set({ status: "finished" })
    .where("status", "=", "working")
    .where("finished_at", "is not", null)
    .execute();
}

export async function createTask(
  database: Database,
  task: CreateTask,
): Promise<Task> {
  const row: Task = {
    ...task,
    status: task.status ?? "working",
    finished_at: task.finished_at ?? null,
  };

  await database.insertInto("tasks").values(row).execute();

  return row;
}

export async function completeTask(
  database: Database,
  { chat_id, message_id }: TaskKey,
  status: Exclude<TaskStatus, "working"> = "finished",
  finishedAt = new Date(),
): Promise<void> {
  await database
    .updateTable("tasks")
    .set({ finished_at: finishedAt.getTime(), status })
    .where("chat_id", "=", chat_id)
    .where("message_id", "=", message_id)
    .where("status", "=", "working")
    .execute();
}

function getTaskKey({ chat_id, message_id }: TaskKey): string {
  return `${chat_id}:${message_id}`;
}

export function createTaskAbortController(taskKey: TaskKey): AbortController {
  const controller = new AbortController();
  activeTaskControllers.set(getTaskKey(taskKey), controller);

  return controller;
}

export function deleteTaskAbortController(taskKey: TaskKey): void {
  activeTaskControllers.delete(getTaskKey(taskKey));
}

export async function cancelTask(
  database: Database,
  taskKey: TaskKey,
): Promise<CancelTaskResult> {
  const task = await database
    .selectFrom("tasks")
    .selectAll()
    .where("chat_id", "=", taskKey.chat_id)
    .where("message_id", "=", taskKey.message_id)
    .executeTakeFirst();

  if (!task) {
    return "not_found";
  }

  if (task.status !== "working") {
    return "not_working";
  }

  const controller = activeTaskControllers.get(getTaskKey(taskKey));
  controller?.abort(new DOMException("Task canceled", "AbortError"));
  await completeTask(database, taskKey, "canceled");

  return "canceled";
}

export async function listRecentTasks(
  database: Database,
  chatId: number,
  limit = RECENT_TASKS_LIMIT,
): Promise<Task[]> {
  return await database
    .selectFrom("tasks")
    .selectAll()
    .where("chat_id", "=", chatId)
    .orderBy("started_at", "desc")
    .limit(limit)
    .execute();
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function truncateTaskText(text: string): string {
  const trimmedText = text.replaceAll(/\s+/g, " ").trim();
  const truncatedText = Array.from(trimmedText)
    .slice(0, TASK_LABEL_LENGTH)
    .join("");

  return truncatedText || "Task";
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTaskDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hours = padDatePart(date.getHours());
  const minutes = padDatePart(date.getMinutes());

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function getTaskMessageLink(task: Task): string {
  return `https://t.me/${task.chat_id}/${task.message_id}`;
}

function getTaskStatusEmoji(task: Task): string {
  const emojiId = STATUS_EMOJI_IDS[task.status];

  return `<tg-emoji emoji-id="${emojiId}">●</tg-emoji>`;
}

function getCancelCommand(task: Task): string {
  return `/cancel_${task.message_id}`;
}

function formatTaskLine(task: Task): string {
  const taskEmoji = getTaskStatusEmoji(task);
  const taskText = escapeHtml(truncateTaskText(task.task_text));
  const taskLink = escapeHtmlAttribute(getTaskMessageLink(task));
  const startedAt = formatTaskDate(task.started_at);
  const parts = [
    `${taskEmoji} <a href="${taskLink}">${taskText}</a>`,
    startedAt,
  ];

  if (task.finished_at !== null) {
    parts.push(formatTaskDate(task.finished_at));
  }

  parts.push(getCancelCommand(task));

  return parts.join(" - ");
}

export function formatTasksList(tasks: Task[]): string {
  return tasks.length > 0
    ? tasks.map(formatTaskLine).join("\n")
    : "No tasks yet.";
}

export async function replyWithRecentTasks(ctx: Context): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const tasks = await listRecentTasks(ctx.database, ctx.chat.id);

  await ctx.reply(formatTasksList(tasks), {
    link_preview_options: {
      is_disabled: true,
    },
    parse_mode: "HTML",
  });
}

export async function replyWithCancelTask(
  ctx: Context,
  messageId: number,
): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const result = await cancelTask(ctx.database, {
    chat_id: ctx.chat.id,
    message_id: messageId,
  });
  const response =
    result === "canceled"
      ? "Canceled."
      : result === "not_working"
        ? "Task is not working."
        : "Task not found.";

  await ctx.reply(response);
}
