import { Database } from "bun:sqlite";
import type {
  AgentContextMode,
  AgentJob,
  JsonValue,
  TelegramMessage,
  TelegramUpdate,
} from "../shared/types.ts";

export type JobState = "pending" | "running" | "completed" | "failed" | "cancelled";

export const jobLeaseDurationMs = 60_000;

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
};

type MessageContextRow = {
  date: number;
  edit_date: number | null;
  from_display_name: string | null;
  from_username: string | null;
  text: string | null;
  media_json: string;
  message_id: number;
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
};

type JobOwnershipRow = {
  state: string;
  worker_id: string | null;
};

export type SearchResult = {
  chatId: number;
  messageId: number;
  date: number;
  author: string;
  text: string;
};

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
    `);
    this.ensureJobColumn("worker_id", "TEXT");
    this.ensureJobColumn("lease_expires_at", "INTEGER");
    this.connection.exec(
      "CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(state, lease_expires_at)",
    );
  }

  private ensureJobColumn(name: "worker_id" | "lease_expires_at", definition: string): void {
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
    this.connection
      .query(`
        INSERT OR IGNORE INTO jobs (
          update_id, chat_id, chat_type, message_id, message_thread_id, user_id, prompt,
          resume_thread_id, attachments_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        JSON.stringify(media(message)),
        Date.now(),
      );
  }

  claimNext(contextMessages: number, workerId: string | null = null): AgentJob | null {
    const transaction = this.connection.transaction(() => {
      const now = Date.now();
      this.recoverExpiredLeasesInTransaction(now);
      // A saved Codex thread has one append-only writer. Keep independent threads concurrent,
      // but leave the next turn for this thread pending until every earlier turn is finished.
      const row = this.connection
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
      .query<{ id: number }, [number]>(`
        SELECT id
        FROM jobs
        WHERE state = 'running'
          AND ${condition}
        ORDER BY id
      `)
      .all(now);
    for (const job of jobs) {
      this.connection
        .query(`
          UPDATE jobs
          SET state = 'pending',
              resume_thread_id = COALESCE(codex_thread_id, resume_thread_id),
              worker_id = NULL,
              lease_expires_at = NULL,
              claimed_at = NULL
          WHERE id = ? AND state = 'running'
        `)
        .run(job.id);
    }
    return jobs.length;
  }

  listRecentJobs(chatId: number, limit = 5): JobSummary[] {
    const rows = this.connection
      .query<JobSummaryRow, [number, number]>(`
        SELECT id, chat_id, chat_type, message_id, prompt, state,
               created_at, completed_at, thinking_message_id
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
        .query<{ message_id: number }, [number, string, number]>(`
          SELECT message_id
          FROM jobs
          WHERE chat_id = ?
            AND codex_thread_id = ?
            AND message_id < ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `)
        .get(chatId, threadId, beforeMessageId)?.message_id ?? null
    );
  }

  private recentContext(chatId: number, beforeMessageId: number, limit: number): string {
    const rows = this.connection
      .query<MessageContextRow, [number, number, number]>(`
        SELECT date, edit_date, from_display_name, from_username, text, media_json, message_id
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
        SELECT date, edit_date, from_display_name, from_username, text, media_json, message_id
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
        const attachments = JSON.parse(row.media_json) as JsonValue[];
        const attachmentText =
          attachments.length > 0 ? ` attachments=${JSON.stringify(attachments)}` : "";
        return `[${timestamp}] #${row.message_id} ${author}: ${row.text ?? ""}${attachmentText}`;
      })
      .join("\n");
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
          SET state = 'completed', completed_at = ?, codex_thread_id = ?
          WHERE id = ? AND state = 'running'
            AND (? IS NULL OR worker_id = ?)
        `)
        .run(Date.now(), codexThreadId, jobId, workerId ?? null, workerId ?? null);
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

  fail(jobId: number, error: string, workerId?: string): void {
    this.connection
      .query(
        "UPDATE jobs SET state = 'failed', completed_at = ?, error = ? WHERE id = ? AND state = 'running' AND (? IS NULL OR worker_id = ?)",
      )
      .run(Date.now(), error, jobId, workerId ?? null, workerId ?? null);
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

  search(query: string, chatId: number | null, limit: number): SearchResult[] {
    const rows = this.connection
      .query<
        {
          chat_id: number;
          message_id: number;
          date: number;
          from_display_name: string | null;
          from_username: string | null;
          text: string | null;
        },
        [string, number | null, number | null, number]
      >(`
        SELECT m.chat_id, m.message_id, m.date, m.from_display_name, m.from_username, m.text
        FROM messages_fts f
        JOIN messages m ON m.rowid = f.rowid
        WHERE messages_fts MATCH ? AND (? IS NULL OR m.chat_id = ?)
        ORDER BY bm25(messages_fts), m.date DESC
        LIMIT ?
      `)
      .all(query, chatId, chatId, limit);
    return rows.map((row) => ({
      chatId: row.chat_id,
      messageId: row.message_id,
      date: row.date,
      author: row.from_username
        ? `${row.from_display_name ?? row.from_username} (@${row.from_username})`
        : (row.from_display_name ?? "unknown"),
      text: row.text ?? "",
    }));
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
