import {
  type ColumnType,
  type Insertable,
  type Selectable,
  sql,
} from "@kysely/kysely";
import type { Context } from "../bot.ts";
import type { Database } from "./database.ts";

export type TasksTable = {
  chat_id: number;
  message_id: number;
  thread_id: number;
  task_text: string;
  started_at: ColumnType<TaskDateValue, string | undefined, string>;
  status: ColumnType<TaskStatus, TaskStatus | undefined, TaskStatus>;
  finished_at: ColumnType<
    TaskDateValue | null,
    string | null | undefined,
    string | null
  >;
};

export type Task = Selectable<TasksTable>;
export type CreateTask = Insertable<TasksTable>;
export type TaskKey = Pick<Task, "chat_id" | "message_id">;
export type TaskStatus = "working" | "finished" | "failed" | "canceled";
type TaskDateValue = string | number;

const RECENT_TASKS_LIMIT = 5;
const TASK_LABEL_LENGTH = 40;
const MIN_VALID_TASK_DATE_MS = Date.UTC(2020, 0, 1);
const MAX_VALID_TASK_DATE_MS = Date.UTC(2100, 0, 1);
const STATUS_EMOJI_IDS = {
  working: {
    id: "6113685078825505075",
    fallback: "⏳",
  },
  finished: {
    id: "5825794181183836432",
    fallback: "✅",
  },
  failed: {
    id: "6269316311172518259",
    fallback: "❌",
  },
  canceled: {
    id: "6269316311172518259",
    fallback: "❌",
  },
} satisfies Record<TaskStatus, { id: string; fallback: string }>;
const linkPreviewOptions = {
  link_preview_options: {
    is_disabled: true,
  },
};
const activeTaskControllers = new Map<string, AbortController>();

type CancelTaskResult =
  | "canceled"
  | "canceled_without_controller"
  | "not_found"
  | "not_working";
type TaskChat = {
  id: number;
  username?: string;
};

export async function migrateTasks(database: Database) {
  await database.schema
    .createTable("tasks")
    .ifNotExists()
    .addColumn("chat_id", "integer", (column) => column.notNull())
    .addColumn("message_id", "integer", (column) => column.notNull())
    .addColumn("thread_id", "integer", (column) => column.notNull())
    .addColumn("task_text", "text", (column) => column.notNull())
    .addColumn("started_at", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) =>
      column.notNull().defaultTo("working"),
    )
    .addColumn("finished_at", "text")
    .addPrimaryKeyConstraint("tasks_primary_key", ["chat_id", "message_id"])
    .execute();

  try {
    await database.schema
      .alterTable("tasks")
      .addColumn("thread_id", "integer")
      .execute();
  } catch {
    // Column already exists on fresh or previously migrated databases.
  }

  await database
    .updateTable("tasks")
    .set(({ ref }) => ({ thread_id: ref("message_id") }))
    .where("thread_id", "is", null)
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

  await database.schema
    .createIndex("tasks_chat_thread_started_at_index")
    .ifNotExists()
    .on("tasks")
    .columns(["chat_id", "thread_id", "started_at"])
    .execute();
}

export async function createTask(
  database: Database,
  task: CreateTask,
): Promise<Task> {
  const startedAt = task.started_at ?? (await getCurrentSqliteDate(database));
  const row = {
    chat_id: task.chat_id,
    message_id: task.message_id,
    thread_id: task.thread_id,
    task_text: task.task_text,
    started_at: startedAt,
    status: task.status ?? "working",
    finished_at: task.finished_at ?? null,
  } satisfies CreateTask;

  await database.insertInto("tasks").values(row).execute();

  return row as Task;
}

export async function getTask(
  database: Database,
  taskKey: TaskKey,
): Promise<Task | undefined> {
  return await database
    .selectFrom("tasks")
    .selectAll()
    .where("chat_id", "=", taskKey.chat_id)
    .where("message_id", "=", taskKey.message_id)
    .executeTakeFirst();
}

export async function completeTask(
  database: Database,
  { chat_id, message_id }: TaskKey,
  status: Exclude<TaskStatus, "working"> = "finished",
): Promise<void> {
  await database
    .updateTable("tasks")
    .set({ finished_at: sql`datetime('now', 'localtime')`, status })
    .where("chat_id", "=", chat_id)
    .where("message_id", "=", message_id)
    .where("status", "=", "working")
    .execute();
}

async function getCurrentSqliteDate(database: Database): Promise<string> {
  const row = await database
    .selectNoFrom(sql<string>`datetime('now', 'localtime')`.as("date"))
    .executeTakeFirstOrThrow();

  return row.date;
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
  const task = await getTask(database, taskKey);

  if (!task) {
    return "not_found";
  }

  if (task.status !== "working") {
    return "not_working";
  }

  const controller = activeTaskControllers.get(getTaskKey(taskKey));
  controller?.abort(new DOMException("Task canceled", "AbortError"));
  await completeTask(database, taskKey, "canceled");

  return controller ? "canceled" : "canceled_without_controller";
}

export async function listRecentTasks(
  database: Database,
  chatId: number,
  limit = RECENT_TASKS_LIMIT,
): Promise<Task[]> {
  return await database
    .selectFrom("tasks as task")
    .selectAll("task")
    .where("task.chat_id", "=", chatId)
    .where((expressionBuilder) =>
      expressionBuilder(
        "task.message_id",
        "=",
        expressionBuilder
          .selectFrom("tasks as latest")
          .select("latest.message_id")
          .whereRef("latest.chat_id", "=", "task.chat_id")
          .whereRef("latest.thread_id", "=", "task.thread_id")
          .orderBy("latest.started_at", "desc")
          .orderBy("latest.message_id", "desc")
          .limit(1),
      ),
    )
    .orderBy("task.started_at", "desc")
    .orderBy("task.message_id", "desc")
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

function normalizeLegacyTimestamp(value: number): number | undefined {
  const timestamp =
    value > 1_000_000_000 && value < 10_000_000_000 ? value * 1000 : value;

  return timestamp >= MIN_VALID_TASK_DATE_MS &&
    timestamp < MAX_VALID_TASK_DATE_MS
    ? timestamp
    : undefined;
}

function formatTaskDate(value: TaskDateValue): string {
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);

    if (match) {
      return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
    }

    return value;
  }

  const timestamp = normalizeLegacyTimestamp(value);

  if (timestamp === undefined) {
    return "unknown";
  }

  const date = new Date(timestamp);

  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hours = padDatePart(date.getHours());
  const minutes = padDatePart(date.getMinutes());

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function getTaskMessageLink(task: Task, chat: TaskChat): string {
  if (chat.username) {
    return `https://t.me/${chat.username}/${task.message_id}`;
  }

  const chatId = String(chat.id);

  if (chatId.startsWith("-100")) {
    return `https://t.me/c/${chatId.slice(4)}/${task.message_id}`;
  }

  return `tg://openmessage?chat_id=${task.chat_id}&message_id=${task.message_id}`;
}

function getTaskStatusEmoji(task: Task, useCustomEmoji: boolean): string {
  const emoji = STATUS_EMOJI_IDS[task.status];

  return useCustomEmoji
    ? `<tg-emoji emoji-id="${emoji.id}">${emoji.fallback}</tg-emoji>`
    : emoji.fallback;
}

function getCancelCommand(task: Task): string {
  return `/cancel_${task.message_id}`;
}

function getResumeCommand(task: Task): string {
  return `/resume_${task.message_id}`;
}

async function getResumableTaskIds(
  database: Database,
  chatId: number,
  tasks: Task[],
): Promise<Set<number>> {
  const candidateIds = tasks
    .filter((task) => task.status === "failed" || task.status === "canceled")
    .map((task) => task.message_id);

  if (candidateIds.length === 0) {
    return new Set();
  }

  const rows = await database
    .selectFrom("threads")
    .select("message_id")
    .where("chat_id", "=", chatId)
    .where("message_id", "in", candidateIds)
    .where("response_id", "is not", null)
    .execute();

  return new Set(rows.map((row) => row.message_id));
}

function formatTaskLine(
  task: Task,
  chat: TaskChat,
  useCustomEmoji: boolean,
  resumableTaskIds: Set<number>,
): string {
  const taskEmoji = getTaskStatusEmoji(task, useCustomEmoji);
  const taskText = escapeHtml(truncateTaskText(task.task_text));
  const taskLink = escapeHtmlAttribute(getTaskMessageLink(task, chat));
  const startedAt = formatTaskDate(task.started_at);
  const firstLine = `${taskEmoji} <a href="${taskLink}">${taskText}</a>`;
  const secondLineParts = [startedAt];

  if (task.finished_at !== null) {
    secondLineParts.push(formatTaskDate(task.finished_at));
  }

  if (task.status === "working") {
    secondLineParts.push(getCancelCommand(task));
  }

  if (resumableTaskIds.has(task.message_id)) {
    secondLineParts.push(getResumeCommand(task));
  }

  return `${firstLine}\n${secondLineParts.join(" - ")}`;
}

export function formatTasksList(
  tasks: Task[],
  chat: TaskChat,
  resumableTaskIds = new Set<number>(),
): string {
  return formatTasksListWithOptions(tasks, chat, true, resumableTaskIds);
}

function formatTasksListWithOptions(
  tasks: Task[],
  chat: TaskChat,
  useCustomEmoji: boolean,
  resumableTaskIds = new Set<number>(),
): string {
  return tasks.length > 0
    ? tasks
        .map((task) =>
          formatTaskLine(task, chat, useCustomEmoji, resumableTaskIds),
        )
        .join("\n\n")
    : "No tasks yet.";
}

export async function replyWithRecentTasks(ctx: Context): Promise<void> {
  if (!ctx.chat) {
    return;
  }

  const tasks = await listRecentTasks(ctx.database, ctx.chat.id);
  const resumableTaskIds = await getResumableTaskIds(
    ctx.database,
    ctx.chat.id,
    tasks,
  );

  try {
    await ctx.reply(formatTasksList(tasks, ctx.chat, resumableTaskIds), {
      ...linkPreviewOptions,
      parse_mode: "HTML",
    });
  } catch {
    await ctx.reply(
      formatTasksListWithOptions(tasks, ctx.chat, false, resumableTaskIds),
      {
        ...linkPreviewOptions,
        parse_mode: "HTML",
      },
    );
  }
}

export async function hasResumableTask(
  database: Database,
  taskKey: TaskKey,
): Promise<boolean> {
  const thread = await database
    .selectFrom("threads")
    .select("message_id")
    .where("chat_id", "=", taskKey.chat_id)
    .where("message_id", "=", taskKey.message_id)
    .where("response_id", "is not", null)
    .executeTakeFirst();

  return Boolean(thread);
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

  if (result === "canceled") {
    return;
  }

  const response =
    result === "canceled_without_controller"
      ? "Canceled."
      : result === "not_working"
        ? "Task is not working."
        : "Task not found.";

  await ctx.reply(response, {
    reply_parameters: {
      message_id: messageId,
    },
  });
}
