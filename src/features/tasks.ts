import type { ColumnType, Insertable, Selectable } from "@kysely/kysely";
import type { Context } from "../bot.ts";
import type { Database } from "./database.ts";

export type TasksTable = {
  chat_id: number;
  message_id: number;
  task_text: string;
  started_at: number;
  finished_at: ColumnType<
    number | null,
    number | null | undefined,
    number | null
  >;
};

export type Task = Selectable<TasksTable>;
export type CreateTask = Insertable<TasksTable>;
export type TaskKey = Pick<Task, "chat_id" | "message_id">;

const RECENT_TASKS_LIMIT = 5;
const TASK_LABEL_LENGTH = 15;

export async function migrateTasks(database: Database) {
  await database.schema
    .createTable("tasks")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("message_id", "integer", (column) => column.notNull())
    .addColumn("task_text", "text", (column) => column.notNull())
    .addColumn("started_at", "integer", (column) => column.notNull())
    .addColumn("finished_at", "integer")
    .addPrimaryKeyConstraint("tasks_primary_key", ["chat_id", "message_id"])
    .execute();
}

export async function createTask(
  database: Database,
  task: CreateTask,
): Promise<Task> {
  const row: Task = {
    ...task,
    finished_at: task.finished_at ?? null,
  };

  await database.insertInto("tasks").values(row).execute();

  return row;
}

export async function finishTask(
  database: Database,
  { chat_id, message_id }: TaskKey,
  finishedAt = new Date(),
): Promise<void> {
  await database
    .updateTable("tasks")
    .set({ finished_at: finishedAt.getTime() })
    .where("chat_id", "=", chat_id)
    .where("message_id", "=", message_id)
    .execute();
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

function formatTaskLine(task: Task): string {
  const taskText = escapeHtml(truncateTaskText(task.task_text));
  const taskLink = escapeHtmlAttribute(getTaskMessageLink(task));
  const startedAt = formatTaskDate(task.started_at);
  const finishedAt =
    task.finished_at === null ? "Working" : formatTaskDate(task.finished_at);

  return `<a href="${taskLink}">${taskText}</a> - ${startedAt} - ${finishedAt}`;
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
