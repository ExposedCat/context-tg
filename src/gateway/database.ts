import { Database } from "bun:sqlite";
import type { AgentJob, JsonValue, TelegramMessage, TelegramUpdate } from "../shared/types.ts";

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
      CREATE INDEX IF NOT EXISTS outbound_thread_idx ON outbound_messages(codex_thread_id);
    `);
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

  claimNext(contextMessages: number): AgentJob | null {
    const transaction = this.connection.transaction(() => {
      const row = this.connection
        .query<JobRow, []>("SELECT * FROM jobs WHERE state = 'pending' ORDER BY created_at LIMIT 1")
        .get();
      if (!row) {
        return null;
      }
      this.connection
        .query("UPDATE jobs SET state = 'running', claimed_at = ? WHERE id = ?")
        .run(Date.now(), row.id);
      return row;
    });
    const row = transaction.immediate();
    if (!row) {
      return null;
    }
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
      context: this.recentContext(row.chat_id, row.message_id, contextMessages),
      attachments: JSON.parse(row.attachments_json) as JsonValue[],
    };
  }

  private recentContext(chatId: number, beforeMessageId: number, limit: number): string {
    const rows = this.connection
      .query<MessageContextRow, [number, number, number]>(`
        SELECT date, edit_date, from_display_name, from_username, text, media_json, message_id
        FROM messages
        WHERE chat_id = ? AND message_id <= ?
        ORDER BY date DESC, message_id DESC
        LIMIT ?
      `)
      .all(chatId, beforeMessageId, limit)
      .reverse();
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

  appendStatus(jobId: number, text: string, threadId: string | undefined): string {
    this.connection
      .query(`
        UPDATE jobs SET
          status_log = status_log || CASE WHEN status_log = '' THEN '' ELSE '\n\n' END || ?,
          codex_thread_id = COALESCE(?, codex_thread_id)
        WHERE id = ?
      `)
      .run(text, threadId ?? null, jobId);
    return (
      this.connection
        .query<{ status_log: string }, [number]>("SELECT status_log FROM jobs WHERE id = ?")
        .get(jobId)?.status_log ?? ""
    );
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

  complete(jobId: number, answerMessageId: number, codexThreadId: string): void {
    const address = this.jobAddress(jobId);
    const transaction = this.connection.transaction(() => {
      this.connection
        .query(`
          UPDATE jobs SET state = 'completed', completed_at = ?, codex_thread_id = ? WHERE id = ?
        `)
        .run(Date.now(), codexThreadId, jobId);
      this.connection
        .query("INSERT OR REPLACE INTO outbound_messages VALUES (?, ?, ?, ?, ?)")
        .run(address.chatId, answerMessageId, jobId, codexThreadId, Date.now());
    });
    transaction.immediate();
  }

  fail(jobId: number, error: string): void {
    this.connection
      .query("UPDATE jobs SET state = 'failed', completed_at = ?, error = ? WHERE id = ?")
      .run(Date.now(), error, jobId);
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
