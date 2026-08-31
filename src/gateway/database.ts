import { Database } from "bun:sqlite";
import type {
  AgentContextMode,
  AgentJob,
  JsonObject,
  JsonValue,
  TelegramMessage,
  TelegramUpdate,
  WorkerRegistration,
} from "../shared/types.ts";

export type JobState = "pending" | "running" | "completed" | "failed" | "cancelled";

export const jobLeaseDurationMs = 60_000;
export const workerLeaseDurationMs = 15_000;

export type JobSummary = {
  id: number;
  chatId: number;
  chatType: AgentJob["chatType"];
  messageId: number;
  prompt: string;
  state: JobState;
  createdAt: number;
  completedAt: number | null;
  thinkingMessageId: number | null;
  canResume: boolean;
};

type JobRow = {
  id: number;
  update_id: number;
  chat_id: number;
  chat_type: AgentJob["chatType"];
  message_id: number;
  message_thread_id: number | null;
  user_id: number | null;
  prompt: string;
  resume_thread_id: string | null;
  attachments_json: string;
  worker_generation: number;
};

type WorkerRow = {
  worker_id: string;
  generation: number;
  state: "active" | "draining" | "stopped";
  registered_at: number;
  last_seen_at: number;
};

type WorkerRuntimeRow = {
  active_worker_id: string | null;
  active_generation: number;
};

type MessageContextRow = {
  date: number;
  edit_date: number | null;
  from_user_id: number | null;
  from_display_name: string | null;
  from_username: string | null;
  text: string | null;
  media_json: string;
  message_id: number;
  message_thread_id: number | null;
  reply_to_message_id: number | null;
  raw_json: string;
};

type ContextResult = {
  mode: AgentContextMode;
  text: string;
};

type JobSummaryRow = {
  id: number;
  chat_id: number;
  chat_type: AgentJob["chatType"];
  message_id: number;
  prompt: string;
  state: string;
  created_at: number;
  completed_at: number | null;
  thinking_message_id: number | null;
  codex_thread_id: string | null;
  resume_thread_id: string | null;
};

type JobOwnershipRow = {
  state: string;
  worker_id: string | null;
};

export type SearchResult = {
  chatId: number;
  messageId: number;
  date: number;
  userId: number | null;
  author: string;
  text: string;
  forwardOrigin?: JsonObject;
};

export type ArchivedMedia = {
  chatId: number;
  messageId: number;
  date: number;
  source: "bot_api" | "telegram_export";
  media: JsonValue[];
};

export type ArchivedMessage = {
  chatId: number;
  messageId: number;
  date: number;
  userId: number | null;
  author: string;
  text: string;
  replyToMessageId: number | null;
  mediaGroupId: string | null;
  source: "bot_api" | "telegram_export";
  media: JsonValue[];
  raw: JsonObject;
  forwardOrigin?: JsonObject;
};

type SearchRow = {
  chat_id: number;
  message_id: number;
  date: number;
  from_user_id: number | null;
  from_display_name: string | null;
  from_username: string | null;
  text: string | null;
  raw_json: string;
};

type ArchivedMessageRow = {
  chat_id: number;
  message_id: number;
  date: number;
  from_user_id: number | null;
  from_display_name: string | null;
  from_username: string | null;
  text: string | null;
  reply_to_message_id: number | null;
  media_group_id: string | null;
  media_json: string;
  raw_json: string;
  source: string;
};

type UnknownRecord = Record<string, unknown>;

function object(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseObject(value: string): UnknownRecord {
  try {
    return object(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function forwardOrigin(rawJson: string): JsonObject | null {
  const raw = parseObject(rawJson);
  const origin = object(raw.forward_origin);
  return origin as JsonObject | null;
}

function nestedAuthor(message: UnknownRecord): string {
  const sender = object(message.from) ?? object(message.sender_chat);
  if (!sender) {
    return "unknown";
  }
  const username = stringField(sender.username);
  const name = [stringField(sender.first_name), stringField(sender.last_name)]
    .filter((part): part is string => part !== null)
    .join(" ");
  return username ? `${name || username} (@${username})` : name || "unknown";
}

function searchResult(row: SearchRow): SearchResult {
  const result: SearchResult = {
    chatId: row.chat_id,
    messageId: row.message_id,
    date: row.date,
    userId: row.from_user_id,
    author: row.from_username
      ? `${row.from_display_name ?? row.from_username} (@${row.from_username})`
      : (row.from_display_name ?? "unknown"),
    text: row.text ?? "",
  };
  const origin = forwardOrigin(row.raw_json);
  return origin === null ? result : { ...result, forwardOrigin: origin };
}

function archivedMessage(row: ArchivedMessageRow): ArchivedMessage {
  const raw = parseObject(row.raw_json) as unknown as JsonObject;
  const origin = forwardOrigin(row.raw_json);
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    date: row.date,
    userId: row.from_user_id,
    author: row.from_username
      ? `${row.from_display_name ?? row.from_username} (@${row.from_username})`
      : (row.from_display_name ?? "unknown"),
    text: row.text ?? "",
    replyToMessageId: row.reply_to_message_id,
    mediaGroupId: row.media_group_id,
    source: row.source as ArchivedMessage["source"],
    media: JSON.parse(row.media_json) as JsonValue[],
    raw,
    ...(origin === null ? {} : { forwardOrigin: origin }),
  };
}

function messageReference(message: UnknownRecord, label: string): string | null {
  const messageId = numberField(message.message_id);
  if (messageId === null) {
    return null;
  }
  const text = stringField(message.text) ?? stringField(message.caption) ?? "";
  const attachments: JsonValue[] = [];
  for (const key of ["photo", "document", "audio", "video", "voice", "animation"]) {
    const value = message[key];
    if (value) {
      attachments.push({ kind: key, value: value as JsonValue });
    }
  }
  const mediaText = attachments.length > 0 ? ` attachments=${JSON.stringify(attachments)}` : "";
  return `${label} #${messageId} ${nestedAuthor(message)}: ${text}${mediaText}`;
}

function rawRelations(rawJson: string): string {
  const raw = parseObject(rawJson);
  const relations: string[] = [];
  const quote = object(raw.quote);
  const quoteText = quote ? stringField(quote.text) : null;
  if (quoteText) {
    relations.push(`quote=${JSON.stringify(quoteText.slice(0, 1_000))}`);
  }
  const externalReply = object(raw.external_reply);
  const externalId = externalReply ? numberField(externalReply.message_id) : null;
  if (externalId !== null) {
    relations.push(`external_reply=#${externalId}`);
  }
  const forward = forwardOrigin(rawJson);
  if (forward) {
    const origin =
      object(forward.sender_user) ?? object(forward.sender_chat) ?? object(forward.chat) ?? forward;
    const originName =
      stringField(origin.username) ??
      ([stringField(origin.first_name), stringField(origin.last_name)]
        .filter((part): part is string => part !== null)
        .join(" ") ||
        stringField(origin.title) ||
        stringField(forward.sender_user_name) ||
        stringField(origin.type) ||
        "unknown");
    relations.push(
      `forwarded_from=${JSON.stringify(originName)} forward_origin=${JSON.stringify(forward)}`,
    );
  }
  return relations.join(" ");
}

function eventType(update: TelegramUpdate): string {
  return Object.keys(update).find((key) => key !== "update_id") ?? "unknown";
}

function displayName(message: TelegramMessage): string | null {
  if (message.from) {
    return [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  }
  return message.sender_chat?.title ?? null;
}

function media(message: TelegramMessage): JsonValue[] {
  const values: JsonValue[] = [];
  for (const key of ["photo", "document", "audio", "video", "voice", "animation"] as const) {
    const value = message[key];
    if (value) {
      values.push({ kind: key, value: value as JsonValue });
    }
  }
  return values;
}

function jobMedia(message: TelegramMessage): JsonValue[] {
  return [...media(message), ...(message.reply_to_message ? media(message.reply_to_message) : [])];
}

export class LoylexDatabase {
  readonly connection: Database;

  constructor(path: string) {
    this.connection = new Database(path, { create: true, strict: true });
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  close(): void {
    this.connection.close();
  }

  nextUpdateOffset(): number {
    const row = this.connection
      .query<{ update_id: number | null }, []>("SELECT max(update_id) AS update_id FROM updates")
      .get();
    return (row?.update_id ?? -1) + 1;
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS updates (
        update_id INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        message_thread_id INTEGER,
        chat_type TEXT NOT NULL,
        chat_title TEXT,
        date INTEGER NOT NULL,
        edit_date INTEGER,
        from_user_id INTEGER,
        from_username TEXT,
        from_display_name TEXT,
        text TEXT,
        reply_to_message_id INTEGER,
        media_group_id TEXT,
        media_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'bot_api',
        PRIMARY KEY (chat_id, message_id)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        from_display_name,
        from_username,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text, from_display_name, from_username)
        VALUES (new.rowid, new.text, new.from_display_name, new.from_username);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text, from_display_name, from_username)
        VALUES ('delete', old.rowid, old.text, old.from_display_name, old.from_username);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text, from_display_name, from_username)
        VALUES ('delete', old.rowid, old.text, old.from_display_name, old.from_username);
        INSERT INTO messages_fts(rowid, text, from_display_name, from_username)
        VALUES (new.rowid, new.text, new.from_display_name, new.from_username);
      END;

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id INTEGER NOT NULL UNIQUE,
        chat_id INTEGER NOT NULL,
        chat_type TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        message_thread_id INTEGER,
        user_id INTEGER,
        prompt TEXT NOT NULL,
        resume_thread_id TEXT,
        attachments_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        claimed_at INTEGER,
        worker_id TEXT,
        lease_expires_at INTEGER,
        worker_generation INTEGER NOT NULL DEFAULT 1,
        completed_at INTEGER,
        codex_thread_id TEXT,
        thinking_message_id INTEGER,
        status_log TEXT NOT NULL DEFAULT '',
        error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbound_messages (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        job_id INTEGER,
        codex_thread_id TEXT,
        sent_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, message_id),
        FOREIGN KEY (job_id) REFERENCES jobs(id)
      );

      CREATE INDEX IF NOT EXISTS messages_chat_date_idx ON messages(chat_id, date DESC);
      CREATE INDEX IF NOT EXISTS jobs_state_created_idx ON jobs(state, created_at);
      CREATE INDEX IF NOT EXISTS jobs_resume_thread_idx
        ON jobs(state, resume_thread_id, created_at, id);
      CREATE INDEX IF NOT EXISTS jobs_codex_thread_idx
        ON jobs(chat_id, codex_thread_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS outbound_thread_idx ON outbound_messages(codex_thread_id);

      CREATE TABLE IF NOT EXISTS workers (
        worker_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'draining', 'stopped')),
        registered_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        drain_requested_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS worker_runtime (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active_worker_id TEXT,
        active_generation INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.ensureJobColumn("worker_id", "TEXT");
    this.ensureJobColumn("lease_expires_at", "INTEGER");
    this.ensureJobColumn("worker_generation", "INTEGER NOT NULL DEFAULT 1");
    this.connection.exec(
      "CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(state, lease_expires_at); CREATE INDEX IF NOT EXISTS jobs_worker_generation_idx ON jobs(worker_generation, state, created_at, id)",
    );
    this.connection
      .query(
        "INSERT OR IGNORE INTO worker_runtime (id, active_worker_id, active_generation, updated_at) VALUES (1, NULL, 1, ?)",
      )
      .run(Date.now());
  }

  private ensureJobColumn(
    name: "worker_id" | "lease_expires_at" | "worker_generation",
    definition: string,
  ): void {
    const columns = this.connection.query<{ name: string }, []>("PRAGMA table_info(jobs)").all();
    if (!columns.some((column) => column.name === name)) {
      this.connection.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
  }

  archiveUpdate(update: TelegramUpdate): TelegramMessage | null {
    this.connection
      .query("INSERT OR IGNORE INTO updates VALUES (?, ?, ?, ?)")
      .run(update.update_id, eventType(update), Date.now(), JSON.stringify(update));

    const message =
      update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
    if (message) {
      this.archiveMessage(message, "bot_api");
    }
    return message ?? null;
  }

  archiveMessage(message: TelegramMessage, source: "bot_api" | "telegram_export"): void {
    const text = message.text ?? message.caption ?? null;
    this.connection
      .query(`
        INSERT INTO messages (
          chat_id, message_id, message_thread_id, chat_type, chat_title, date, edit_date,
          from_user_id, from_username, from_display_name, text, reply_to_message_id,
          media_group_id, media_json, raw_json, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, message_id) DO UPDATE SET
          message_thread_id=excluded.message_thread_id,
          chat_type=excluded.chat_type,
          chat_title=excluded.chat_title,
          date=excluded.date,
          edit_date=excluded.edit_date,
          from_user_id=excluded.from_user_id,
          from_username=excluded.from_username,
          from_display_name=excluded.from_display_name,
          text=excluded.text,
          reply_to_message_id=excluded.reply_to_message_id,
          media_group_id=excluded.media_group_id,
          media_json=excluded.media_json,
          raw_json=excluded.raw_json,
          source=excluded.source
      `)
      .run(
        message.chat.id,
        message.message_id,
        message.message_thread_id ?? null,
        message.chat.type,
        message.chat.title ?? null,
        message.date,
        message.edit_date ?? null,
        message.from?.id ?? null,
        message.from?.username ?? null,
        displayName(message),
        text,
        message.reply_to_message?.message_id ?? null,
        message.media_group_id ?? null,
        JSON.stringify(media(message)),
        JSON.stringify(message),
        source,
      );
  }

  archiveExportMessages(messages: TelegramMessage[]): number {
    const transaction = this.connection.transaction(() => {
      for (const message of messages) {
        this.archiveMessage(message, "telegram_export");
      }
      return messages.length;
    });
    return transaction.immediate();
  }

  archivedMedia(chatId: number, limit: number): ArchivedMedia[] {
    const rows = this.connection
      .query<
        { chat_id: number; message_id: number; date: number; media_json: string; source: string },
        [number, number]
      >(
        `
          SELECT chat_id, message_id, date, media_json, source
          FROM messages
          WHERE chat_id = ? AND media_json != '[]'
          ORDER BY date ASC, message_id ASC
          LIMIT ?
        `,
      )
      .all(chatId, limit);
    return rows.map((row) => ({
      chatId: row.chat_id,
      messageId: row.message_id,
      date: row.date,
      source: row.source as ArchivedMedia["source"],
      media: JSON.parse(row.media_json) as JsonValue[],
    }));
  }

  archivedMessage(chatId: number, messageId: number): ArchivedMessage | null {
    const row = this.connection
      .query<ArchivedMessageRow, [number, number]>(`
        SELECT chat_id, message_id, date, from_user_id, from_display_name, from_username,
               text, reply_to_message_id, media_group_id, media_json, raw_json, source
        FROM messages
        WHERE chat_id = ? AND message_id = ?
      `)
      .get(chatId, messageId);
    return row ? archivedMessage(row) : null;
  }

  archivedMessages(
    chatId: number,
    afterMessageId: number | null,
    beforeMessageId: number | null,
    limit: number,
  ): ArchivedMessage[] {
    const rows = this.connection
      .query<
        ArchivedMessageRow,
        [number, number | null, number | null, number | null, number | null, number]
      >(`
        SELECT chat_id, message_id, date, from_user_id, from_display_name, from_username,
               text, reply_to_message_id, media_group_id, media_json, raw_json, source
        FROM messages
        WHERE chat_id = ?
          AND (? IS NULL OR message_id > ?)
          AND (? IS NULL OR message_id < ?)
        ORDER BY message_id ASC
        LIMIT ?
      `)
      .all(chatId, afterMessageId, afterMessageId, beforeMessageId, beforeMessageId, limit);
    return rows.map(archivedMessage);
  }

  resumeThread(chatId: number, repliedMessageId: number | undefined): string | null {
    if (repliedMessageId === undefined) {
      return null;
    }
    const row = this.connection
      .query<{ codex_thread_id: string | null }, [number, number]>(
        "SELECT codex_thread_id FROM outbound_messages WHERE chat_id = ? AND message_id = ?",
      )
      .get(chatId, repliedMessageId);
    return row?.codex_thread_id ?? null;
  }

  enqueue(
    updateId: number,
    message: TelegramMessage,
    prompt: string,
    resumeThreadId: string | null,
  ): void {
    const generation = this.activeWorkerGeneration();
    this.connection
      .query(`
        INSERT OR IGNORE INTO jobs (
          update_id, chat_id, chat_type, message_id, message_thread_id, user_id, prompt,
          resume_thread_id, attachments_json, worker_generation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        updateId,
        message.chat.id,
        message.chat.type,
        message.message_id,
        message.message_thread_id ?? null,
        message.from?.id ?? null,
        prompt,
        resumeThreadId,
        JSON.stringify(jobMedia(message)),
        generation,
        Date.now(),
      );
  }

  private activeWorkerGeneration(): number {
    return (
      this.connection
        .query<WorkerRuntimeRow, []>(
          "SELECT active_worker_id, active_generation FROM worker_runtime WHERE id = 1",
        )
        .get()?.active_generation ?? 1
    );
  }

  private worker(workerId: string): WorkerRow | null {
    return (
      this.connection
        .query<WorkerRow, [string]>(
          "SELECT worker_id, generation, state, registered_at, last_seen_at FROM workers WHERE worker_id = ?",
        )
        .get(workerId) ?? null
    );
  }

  private hasRegisteredWorkers(): boolean {
    return Boolean(
      this.connection.query<{ value: number }, []>("SELECT 1 AS value FROM workers LIMIT 1").get(),
    );
  }

  private moveWorkerGenerationInTransaction(
    sourceGeneration: number,
    targetGeneration: number,
    sourceWorkerId: string | null,
  ): void {
    if (sourceWorkerId === null) {
      this.connection
        .query(`
          UPDATE jobs
          SET state = 'pending',
              resume_thread_id = COALESCE(codex_thread_id, resume_thread_id),
              worker_id = NULL,
              lease_expires_at = NULL,
              claimed_at = NULL,
              worker_generation = ?
          WHERE state = 'running' AND worker_generation = ?
        `)
        .run(targetGeneration, sourceGeneration);
    } else {
      this.connection
        .query(`
          UPDATE jobs
          SET state = 'pending',
              resume_thread_id = COALESCE(codex_thread_id, resume_thread_id),
              worker_id = NULL,
              lease_expires_at = NULL,
              claimed_at = NULL,
              worker_generation = ?
          WHERE state = 'running' AND worker_id = ?
        `)
        .run(targetGeneration, sourceWorkerId);
    }
    this.connection
      .query(
        "UPDATE jobs SET worker_generation = ? WHERE state = 'pending' AND worker_generation = ?",
      )
      .run(targetGeneration, sourceGeneration);
  }

  registerWorker(workerId: string, now = Date.now()): WorkerRegistration {
    const transaction = this.connection.transaction(() => {
      const existing = this.worker(workerId);
      if (existing && existing.state !== "stopped") {
        this.connection
          .query("UPDATE workers SET last_seen_at = ? WHERE worker_id = ?")
          .run(now, workerId);
        return {
          generation: existing.generation,
          state: existing.state === "active" ? "active" : "draining",
        } satisfies WorkerRegistration;
      }

      const runtime = this.connection
        .query<WorkerRuntimeRow, []>(
          "SELECT active_worker_id, active_generation FROM worker_runtime WHERE id = 1",
        )
        .get() ?? { active_worker_id: null, active_generation: 1 };
      const active = runtime.active_worker_id ? this.worker(runtime.active_worker_id) : null;
      let generation = runtime.active_generation;

      if (active && active.state === "active") {
        generation += 1;
        if (active.last_seen_at >= now - workerLeaseDurationMs) {
          this.connection
            .query(
              "UPDATE workers SET state = 'draining', drain_requested_at = ? WHERE worker_id = ? AND state = 'active'",
            )
            .run(now, active.worker_id);
        } else {
          this.moveWorkerGenerationInTransaction(active.generation, generation, active.worker_id);
          this.connection
            .query("UPDATE workers SET state = 'stopped', last_seen_at = ? WHERE worker_id = ?")
            .run(now, active.worker_id);
        }
      } else if (runtime.active_worker_id !== null) {
        generation += 1;
        this.moveWorkerGenerationInTransaction(
          runtime.active_generation,
          generation,
          active?.worker_id ?? null,
        );
        if (active) {
          this.connection
            .query("UPDATE workers SET state = 'stopped', last_seen_at = ? WHERE worker_id = ?")
            .run(now, active.worker_id);
        }
      }

      const reclaimable = this.connection
        .query<WorkerRow, [number]>(`
          SELECT worker_id, generation, state, registered_at, last_seen_at
          FROM workers
          WHERE state = 'stopped'
             OR (state = 'draining' AND last_seen_at < ?)
        `)
        .all(now - workerLeaseDurationMs);
      for (const worker of reclaimable) {
        if (worker.worker_id === workerId || worker.generation === generation) {
          continue;
        }
        this.moveWorkerGenerationInTransaction(worker.generation, generation, worker.worker_id);
        this.connection
          .query("UPDATE workers SET state = 'stopped', last_seen_at = ? WHERE worker_id = ?")
          .run(now, worker.worker_id);
      }

      this.connection
        .query(`
          INSERT INTO workers (worker_id, generation, state, registered_at, last_seen_at, drain_requested_at)
          VALUES (?, ?, 'active', ?, ?, NULL)
          ON CONFLICT(worker_id) DO UPDATE SET
            generation = excluded.generation,
            state = 'active',
            registered_at = excluded.registered_at,
            last_seen_at = excluded.last_seen_at,
            drain_requested_at = NULL
        `)
        .run(workerId, generation, now, now);
      this.connection
        .query(
          "UPDATE worker_runtime SET active_worker_id = ?, active_generation = ?, updated_at = ? WHERE id = 1",
        )
        .run(workerId, generation, now);
      return { generation, state: "active" } satisfies WorkerRegistration;
    });
    return transaction.immediate();
  }

  heartbeatWorker(workerId: string, now = Date.now()): boolean {
    const result = this.connection
      .query(
        "UPDATE workers SET last_seen_at = ? WHERE worker_id = ? AND state IN ('active', 'draining')",
      )
      .run(now, workerId);
    return result.changes > 0;
  }

  stopWorker(workerId: string, now = Date.now()): boolean {
    const transaction = this.connection.transaction(() => {
      const worker = this.worker(workerId);
      if (!worker) {
        return false;
      }
      const activeGeneration = this.activeWorkerGeneration();
      if (worker.generation !== activeGeneration) {
        this.moveWorkerGenerationInTransaction(worker.generation, activeGeneration, workerId);
      }
      const result = this.connection
        .query("UPDATE workers SET state = 'stopped', last_seen_at = ? WHERE worker_id = ?")
        .run(now, workerId);
      return result.changes > 0;
    });
    return transaction.immediate();
  }

  shouldDrainWorker(workerId: string): boolean {
    const worker = this.worker(workerId);
    if (!worker || worker.state !== "draining") {
      return false;
    }
    const work =
      this.connection
        .query<{ count: number }, [number]>(
          "SELECT count(*) AS count FROM jobs WHERE worker_generation = ? AND state IN ('pending', 'running')",
        )
        .get(worker.generation)?.count ?? 0;
    return work === 0;
  }

  claimNext(contextMessages: number, workerId: string | null = null): AgentJob | null {
    const transaction = this.connection.transaction(() => {
      const now = Date.now();
      this.recoverExpiredLeasesInTransaction(now);
      const worker = workerId === null ? null : this.worker(workerId);
      if (
        workerId !== null &&
        ((!worker && this.hasRegisteredWorkers()) || worker?.state === "stopped")
      ) {
        return null;
      }
      // A saved Codex thread has one append-only writer. Keep independent threads concurrent,
      // but leave the next turn for this thread pending until every earlier turn is finished.
      const row = worker
        ? this.connection
            .query<JobRow, [number]>(`
              SELECT candidate.*
              FROM jobs AS candidate
              WHERE candidate.state = 'pending'
                AND candidate.worker_generation = ?
                AND (
                  candidate.resume_thread_id IS NULL
                  OR NOT EXISTS (
                    SELECT 1
                    FROM jobs AS blocker
                    WHERE blocker.state IN ('pending', 'running')
                      AND (
                        blocker.resume_thread_id = candidate.resume_thread_id
                        OR blocker.codex_thread_id = candidate.resume_thread_id
                      )
                      AND (
                        blocker.created_at < candidate.created_at
                        OR (
                          blocker.created_at = candidate.created_at
                          AND blocker.id < candidate.id
                        )
                      )
                  )
                )
              ORDER BY candidate.created_at, candidate.id
              LIMIT 1
            `)
            .get(worker.generation)
        : this.connection
            .query<JobRow, []>(`
              SELECT candidate.*
              FROM jobs AS candidate
              WHERE candidate.state = 'pending'
                AND (
                  candidate.resume_thread_id IS NULL
                  OR NOT EXISTS (
                    SELECT 1
                    FROM jobs AS blocker
                    WHERE blocker.state IN ('pending', 'running')
                      AND (
                        blocker.resume_thread_id = candidate.resume_thread_id
                        OR blocker.codex_thread_id = candidate.resume_thread_id
                      )
                      AND (
                        blocker.created_at < candidate.created_at
                        OR (
                          blocker.created_at = candidate.created_at
                          AND blocker.id < candidate.id
                        )
                      )
                  )
                )
              ORDER BY candidate.created_at, candidate.id
              LIMIT 1
            `)
            .get();
      if (!row) {
        return null;
      }
      this.connection
        .query(
          "UPDATE jobs SET state = 'running', claimed_at = ?, worker_id = ?, lease_expires_at = ? WHERE id = ?",
        )
        .run(now, workerId, workerId === null ? null : now + jobLeaseDurationMs, row.id);
      return row;
    });
    const row = transaction.immediate();
    if (!row) {
      return null;
    }
    const context = this.contextForJob(
      row.chat_id,
      row.message_id,
      contextMessages,
      row.resume_thread_id,
    );
    return {
      id: row.id,
      updateId: row.update_id,
      chatId: row.chat_id,
      chatType: row.chat_type,
      messageId: row.message_id,
      messageThreadId: row.message_thread_id,
      userId: row.user_id,
      prompt: row.prompt,
      resumeThreadId: row.resume_thread_id,
      context: context.text,
      contextMode: context.mode,
      replyContext: row.resume_thread_id
        ? null
        : this.replyContext(row.chat_id, row.message_id, context.text),
      attachments: JSON.parse(row.attachments_json) as JsonValue[],
    };
  }

  recoverExpiredJobs(now = Date.now()): number {
    const transaction = this.connection.transaction(() =>
      this.recoverExpiredJobsInTransaction(now),
    );
    return transaction.immediate();
  }

  private recoverExpiredJobsInTransaction(now: number): number {
    return this.recoverJobsInTransaction(now, true);
  }

  private recoverExpiredLeasesInTransaction(now: number): number {
    return this.recoverJobsInTransaction(now, false);
  }

  private recoverJobsInTransaction(now: number, includeUnleased: boolean): number {
    const condition = includeUnleased
      ? "(worker_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)"
      : "lease_expires_at IS NOT NULL AND lease_expires_at < ?";
    const jobs = this.connection
      .query<{ id: number; worker_id: string | null; worker_generation: number }, [number]>(`
        SELECT id, worker_id, worker_generation
        FROM jobs
        WHERE state = 'running'
          AND ${condition}
        ORDER BY id
      `)
      .all(now);
    for (const job of jobs) {
      const generation = this.generationForRecovery(job.worker_id, job.worker_generation, now);
      this.connection
        .query(`
          UPDATE jobs
          SET state = 'pending',
              resume_thread_id = COALESCE(codex_thread_id, resume_thread_id),
              worker_id = NULL,
              lease_expires_at = NULL,
              claimed_at = NULL,
              worker_generation = ?
          WHERE id = ? AND state = 'running'
        `)
        .run(generation, job.id);
    }
    return jobs.length;
  }

  private generationForRecovery(workerId: string | null, generation: number, now: number): number {
    if (workerId !== null) {
      const owner = this.worker(workerId);
      if (owner?.state === "active" && owner.last_seen_at >= now - workerLeaseDurationMs) {
        return generation;
      }
    }
    return this.activeWorkerGeneration();
  }

  listRecentJobs(chatId: number, limit = 5): JobSummary[] {
    const rows = this.connection
      .query<JobSummaryRow, [number, number]>(`
        SELECT id, chat_id, chat_type, message_id, prompt, state,
               created_at, completed_at, thinking_message_id, codex_thread_id, resume_thread_id
        FROM jobs
        WHERE chat_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(chatId, limit);
    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      chatType: row.chat_type,
      messageId: row.message_id,
      prompt: row.prompt,
      state: row.state as JobState,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      thinkingMessageId: row.thinking_message_id,
      canResume:
        (row.state === "failed" || row.state === "cancelled") &&
        (row.codex_thread_id !== null || row.resume_thread_id !== null),
    }));
  }

  private contextForJob(
    chatId: number,
    beforeMessageId: number,
    limit: number,
    resumeThreadId: string | null,
  ): ContextResult {
    if (!resumeThreadId) {
      return { mode: "full", text: this.recentContext(chatId, beforeMessageId, limit) };
    }
    // `codex exec resume` already replays the saved thread transcript. Only messages that
    // arrived after its last turn belong in the new prompt; replaying the whole chat window
    // would duplicate the previous user prompt and defeat append-only prompt caching.
    const previousMessageId = this.latestThreadMessageId(chatId, resumeThreadId, beforeMessageId);
    if (previousMessageId === null || previousMessageId >= beforeMessageId) {
      return { mode: "full", text: this.recentContext(chatId, beforeMessageId, limit) };
    }
    return {
      mode: "delta",
      text: this.threadDeltaContext(
        chatId,
        previousMessageId,
        beforeMessageId,
        resumeThreadId,
        limit,
      ),
    };
  }

  private latestThreadMessageId(
    chatId: number,
    threadId: string,
    beforeMessageId: number,
  ): number | null {
    return (
      this.connection
        .query<{ message_id: number }, [number, string, string, number]>(`
          SELECT message_id
          FROM jobs
          WHERE chat_id = ?
            AND (codex_thread_id = ? OR resume_thread_id = ?)
            AND message_id < ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `)
        .get(chatId, threadId, threadId, beforeMessageId)?.message_id ?? null
    );
  }

  private recentContext(chatId: number, beforeMessageId: number, limit: number): string {
    const rows = this.connection
      .query<MessageContextRow, [number, number, number]>(`
        SELECT date, edit_date, from_user_id, from_display_name, from_username, text, media_json, message_id,
               message_thread_id, reply_to_message_id, raw_json
        FROM messages
        WHERE chat_id = ? AND message_id < ?
        ORDER BY date DESC, message_id DESC
        LIMIT ?
      `)
      .all(chatId, beforeMessageId, limit)
      .reverse();
    return this.formatContext(rows);
  }

  private threadDeltaContext(
    chatId: number,
    afterMessageId: number,
    beforeMessageId: number,
    threadId: string,
    limit: number,
  ): string {
    const rows = this.connection
      .query<MessageContextRow, [number, number, number, string, number]>(`
        SELECT date, edit_date, from_user_id, from_display_name, from_username, text, media_json, message_id,
               message_thread_id, reply_to_message_id, raw_json
        FROM messages
        WHERE chat_id = ?
          AND message_id > ?
          AND message_id < ?
          AND NOT EXISTS (
            SELECT 1
            FROM outbound_messages
            WHERE outbound_messages.chat_id = messages.chat_id
              AND outbound_messages.message_id = messages.message_id
              AND outbound_messages.codex_thread_id = ?
          )
        ORDER BY date DESC, message_id DESC
        LIMIT ?
      `)
      .all(chatId, afterMessageId, beforeMessageId, threadId, limit)
      .reverse();
    return this.formatContext(rows);
  }

  private formatContext(rows: MessageContextRow[]): string {
    return rows
      .map((row) => {
        const timestamp = new Date(row.date * 1000).toISOString();
        const author = row.from_username
          ? `${row.from_display_name ?? row.from_username} (@${row.from_username})`
          : (row.from_display_name ?? "unknown");
        const userId = row.from_user_id === null ? "" : ` user_id=${row.from_user_id}`;
        const attachments = JSON.parse(row.media_json) as JsonValue[];
        const attachmentText =
          attachments.length > 0 ? ` attachments=${JSON.stringify(attachments)}` : "";
        const relations = [
          row.message_thread_id === null ? "" : `thread=#${row.message_thread_id}`,
          row.reply_to_message_id === null ? "" : `reply_to=#${row.reply_to_message_id}`,
          rawRelations(row.raw_json),
        ].filter(Boolean);
        const relationText = relations.length > 0 ? ` ${relations.join(" ")}` : "";
        const edited = row.edit_date === null ? "" : " (edited)";
        return `[${timestamp}] #${row.message_id} ${author}${userId}${edited}: ${row.text ?? ""}${attachmentText}${relationText}`;
      })
      .join("\n");
  }

  private replyContext(chatId: number, messageId: number, context: string): string | null {
    const rawJson = this.connection
      .query<{ raw_json: string }, [number, number]>(
        "SELECT raw_json FROM messages WHERE chat_id = ? AND message_id = ?",
      )
      .get(chatId, messageId)?.raw_json;
    if (!rawJson) {
      return null;
    }
    const raw = parseObject(rawJson);
    const target = object(raw.reply_to_message) ?? object(raw.external_reply);
    if (!target) {
      return null;
    }
    const targetId = numberField(target.message_id);
    if (targetId === null) {
      return null;
    }
    // The normal context window already carries this message. Avoid inserting a second copy
    // merely because Telegram also sent the nested reply object.
    if (context.split("\n").some((line) => line.includes(`#${targetId} `))) {
      return null;
    }
    return messageReference(target, "Replied-to Telegram message:");
  }

  appendStatus(
    jobId: number,
    text: string,
    threadId: string | undefined,
    workerId?: string,
  ): string | null {
    const result = this.connection
      .query(`
        UPDATE jobs SET
          status_log = status_log || CASE WHEN status_log = '' THEN '' ELSE '\n\n' END || ?,
          codex_thread_id = COALESCE(?, codex_thread_id)
        WHERE id = ? AND state = 'running'
          AND (? IS NULL OR worker_id = ?)
      `)
      .run(text, threadId ?? null, jobId, workerId ?? null, workerId ?? null);
    if (result.changes === 0) {
      return null;
    }
    if (threadId) {
      this.connection
        .query(
          "UPDATE outbound_messages SET codex_thread_id = ? WHERE job_id = ? AND codex_thread_id IS NULL",
        )
        .run(threadId, jobId);
    }
    return (
      this.connection
        .query<{ status_log: string }, [number]>("SELECT status_log FROM jobs WHERE id = ?")
        .get(jobId)?.status_log ?? null
    );
  }

  heartbeat(jobId: number, workerId: string): boolean {
    const result = this.connection
      .query(
        "UPDATE jobs SET lease_expires_at = ? WHERE id = ? AND state = 'running' AND worker_id = ?",
      )
      .run(Date.now() + jobLeaseDurationMs, jobId, workerId);
    return result.changes > 0;
  }

  isJobOwned(jobId: number, workerId: string): boolean {
    const row = this.connection
      .query<JobOwnershipRow, [number]>("SELECT state, worker_id FROM jobs WHERE id = ?")
      .get(jobId);
    return Boolean(row && row.state === "running" && row.worker_id === workerId);
  }

  thinkingMessage(jobId: number): number | null {
    return (
      this.connection
        .query<{ thinking_message_id: number | null }, [number]>(
          "SELECT thinking_message_id FROM jobs WHERE id = ?",
        )
        .get(jobId)?.thinking_message_id ?? null
    );
  }

  jobThreadId(jobId: number): string | null {
    return (
      this.connection
        .query<{ thread_id: string | null }, [number]>(
          "SELECT COALESCE(codex_thread_id, resume_thread_id) AS thread_id FROM jobs WHERE id = ?",
        )
        .get(jobId)?.thread_id ?? null
    );
  }

  setThinkingMessage(jobId: number, messageId: number): void {
    this.connection
      .query("UPDATE jobs SET thinking_message_id = ? WHERE id = ?")
      .run(messageId, jobId);
    this.recordOutboundMessage(jobId, messageId);
  }

  recordOutboundMessage(
    jobId: number,
    messageId: number,
    codexThreadId: string | null = null,
  ): void {
    const address = this.jobAddress(jobId);
    this.connection
      .query(`
        INSERT INTO outbound_messages (chat_id, message_id, job_id, codex_thread_id, sent_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, message_id) DO UPDATE SET
          job_id = excluded.job_id,
          codex_thread_id = COALESCE(excluded.codex_thread_id, outbound_messages.codex_thread_id),
          sent_at = excluded.sent_at
      `)
      .run(address.chatId, messageId, jobId, codexThreadId, Date.now());
  }

  cancelJobsForMessage(chatId: number, messageId: number): number[] {
    const transaction = this.connection.transaction(() => {
      const outbound = this.connection
        .query<{ job_id: number | null; codex_thread_id: string | null }, [number, number]>(
          "SELECT job_id, codex_thread_id FROM outbound_messages WHERE chat_id = ? AND message_id = ?",
        )
        .get(chatId, messageId);
      const sourceJob = this.connection
        .query<
          { id: number; codex_thread_id: string | null; resume_thread_id: string | null },
          [number, number]
        >(
          "SELECT id, codex_thread_id, resume_thread_id FROM jobs WHERE chat_id = ? AND message_id = ?",
        )
        .get(chatId, messageId);
      const targetJobId = outbound?.job_id ?? sourceJob?.id ?? -1;
      const targetThreadId =
        outbound?.codex_thread_id ??
        sourceJob?.codex_thread_id ??
        sourceJob?.resume_thread_id ??
        null;
      const jobs = this.connection
        .query<
          { id: number },
          [number, number, number, number, string | null, string | null, string | null]
        >(`
          SELECT DISTINCT id
          FROM jobs
          WHERE chat_id = ?
            AND state IN ('pending', 'running')
            AND (
              id = ?
              OR message_id = ?
              OR thinking_message_id = ?
              OR (
                ? IS NOT NULL
                AND (resume_thread_id = ? OR codex_thread_id = ?)
              )
            )
          ORDER BY id
        `)
        .all(
          chatId,
          targetJobId,
          messageId,
          messageId,
          targetThreadId,
          targetThreadId,
          targetThreadId,
        );
      const cancelledAt = Date.now();
      for (const job of jobs) {
        this.connection
          .query(
            "UPDATE jobs SET state = 'cancelled', completed_at = ?, error = ?, worker_id = NULL, lease_expires_at = NULL WHERE id = ? AND state IN ('pending', 'running')",
          )
          .run(cancelledAt, "Остановлено пользователем", job.id);
      }
      return jobs.map((job) => job.id);
    });
    return transaction.immediate();
  }

  resumableThread(chatId: number, messageId: number): string | null {
    return (
      this.connection
        .query<{ thread_id: string | null }, [number, number, number]>(`
          SELECT COALESCE(j.codex_thread_id, j.resume_thread_id) AS thread_id
          FROM jobs AS j
          LEFT JOIN outbound_messages AS o
            ON o.chat_id = j.chat_id AND o.job_id = j.id
          WHERE j.chat_id = ?
            AND j.state IN ('failed', 'cancelled')
            AND (j.message_id = ? OR o.message_id = ?)
            AND COALESCE(j.codex_thread_id, j.resume_thread_id) IS NOT NULL
          ORDER BY j.created_at DESC, j.id DESC
          LIMIT 1
        `)
        .get(chatId, messageId, messageId)?.thread_id ?? null
    );
  }

  isJobCancelled(jobId: number): boolean {
    return Boolean(
      this.connection
        .query<{ value: number }, [number]>(
          "SELECT 1 AS value FROM jobs WHERE id = ? AND state = 'cancelled'",
        )
        .get(jobId),
    );
  }

  jobAddress(jobId: number): {
    chatId: number;
    chatType: AgentJob["chatType"];
    messageId: number;
    threadId: number | null;
  } {
    const row = this.connection
      .query<
        {
          chat_id: number;
          chat_type: AgentJob["chatType"];
          message_id: number;
          message_thread_id: number | null;
        },
        [number]
      >("SELECT chat_id, chat_type, message_id, message_thread_id FROM jobs WHERE id = ?")
      .get(jobId);
    if (!row) {
      throw new Error(`Unknown job ${jobId}`);
    }
    return {
      chatId: row.chat_id,
      chatType: row.chat_type,
      messageId: row.message_id,
      threadId: row.message_thread_id,
    };
  }

  complete(
    jobId: number,
    answerMessageId: number,
    codexThreadId: string,
    workerId?: string,
  ): boolean {
    const address = this.jobAddress(jobId);
    const transaction = this.connection.transaction(() => {
      const result = this.connection
        .query(`
          UPDATE jobs
          SET state = 'completed', completed_at = ?, codex_thread_id = ?, thinking_message_id = ?
          WHERE id = ? AND state = 'running'
            AND (? IS NULL OR worker_id = ?)
        `)
        .run(Date.now(), codexThreadId, answerMessageId, jobId, workerId ?? null, workerId ?? null);
      if (result.changes === 0) {
        return false;
      }
      this.connection
        .query("UPDATE outbound_messages SET codex_thread_id = ? WHERE job_id = ?")
        .run(codexThreadId, jobId);
      this.connection
        .query("INSERT OR REPLACE INTO outbound_messages VALUES (?, ?, ?, ?, ?)")
        .run(address.chatId, answerMessageId, jobId, codexThreadId, Date.now());
      return true;
    });
    return transaction.immediate();
  }

  fail(jobId: number, error: string, workerId?: string, codexThreadId?: string | null): void {
    const transaction = this.connection.transaction(() => {
      const result = this.connection
        .query(
          "UPDATE jobs SET state = 'failed', completed_at = ?, error = ?, codex_thread_id = COALESCE(?, codex_thread_id) WHERE id = ? AND state = 'running' AND (? IS NULL OR worker_id = ?)",
        )
        .run(Date.now(), error, codexThreadId ?? null, jobId, workerId ?? null, workerId ?? null);
      if (result.changes > 0 && codexThreadId) {
        this.connection
          .query(
            "UPDATE outbound_messages SET codex_thread_id = ? WHERE job_id = ? AND codex_thread_id IS NULL",
          )
          .run(codexThreadId, jobId);
      }
    });
    transaction.immediate();
  }

  chatExists(chatId: number): boolean {
    return Boolean(
      this.connection
        .query<{ value: number }, [number]>(
          "SELECT 1 AS value FROM messages WHERE chat_id = ? LIMIT 1",
        )
        .get(chatId),
    );
  }

  search(query: string, chatId: number | null, limit: number, offset = 0): SearchResult[] {
    const rows = this.connection
      .query<SearchRow, [string, number | null, number | null, number, number]>(`
        SELECT m.chat_id, m.message_id, m.date, m.from_user_id, m.from_display_name, m.from_username,
               m.text, m.raw_json
        FROM messages_fts f
        JOIN messages m ON m.rowid = f.rowid
        WHERE messages_fts MATCH ? AND (? IS NULL OR m.chat_id = ?)
        ORDER BY bm25(messages_fts), m.date DESC
        LIMIT ? OFFSET ?
      `)
      .all(query, chatId, chatId, limit, offset);
    return rows.map(searchResult);
  }

  recent(chatId: number, limit: number): SearchResult[] {
    const rows = this.connection
      .query<SearchRow, [number, number]>(`
        SELECT chat_id, message_id, date, from_user_id, from_display_name, from_username,
               text, raw_json
        FROM messages
        WHERE chat_id = ?
        ORDER BY date DESC, message_id DESC
        LIMIT ?
      `)
      .all(chatId, limit);
    return rows.map(searchResult);
  }

  stats(): Record<string, number> {
    const count = (table: string): number =>
      this.connection.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()
        ?.count ?? 0;
    return {
      updates: count("updates"),
      messages: count("messages"),
      pendingJobs:
        this.connection
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM jobs WHERE state = 'pending'",
          )
          .get()?.count ?? 0,
      runningJobs:
        this.connection
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM jobs WHERE state = 'running'",
          )
          .get()?.count ?? 0,
    };
  }
}
