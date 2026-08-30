import type { Server } from "bun";
import type { AgentCompletion, AgentEvent } from "../shared/types.ts";
import type { GatewayConfig } from "./config.ts";
import type { LoylexDatabase } from "./database.ts";
import { activityLines } from "./presentation.ts";
import type { TelegramClient } from "./telegram.ts";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function workDocument(status: string): string {
  const activity = activityLines(status).slice(-8);
  const history = activity.map((line) => `- ${escapeHtml(line)}`).join("\n");
  return `<details><summary>Ход работы</summary>\n\n${history || "- Готово"}\n\n</details>`;
}

function completedDocument(status: string, answer: string): string {
  return `${workDocument(status)}\n\n${answer}`.slice(0, 32_768);
}

function bearer(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

function workerId(request: Request): string | undefined {
  const value = request.headers.get("x-loylex-worker-id")?.trim();
  return value || undefined;
}

async function body<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export class GatewayServer {
  readonly #lastStreamEdit = new Map<number, number>();
  readonly #lastStreamDocument = new Map<number, string>();
  #server: Server<undefined> | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly database: LoylexDatabase,
    private readonly telegram: TelegramClient,
  ) {}

  start(): void {
    this.database.recoverExpiredJobs();
    this.#server = Bun.serve({
      hostname: this.config.listenHost,
      port: this.config.listenPort,
      fetch: (request) => this.route(request),
    });
  }

  stop(): void {
    this.#server?.stop(true);
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return json({ ok: true, ...this.database.stats() });
    }
    if (bearer(request) !== this.config.bridgeToken) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      if (request.method === "GET" && url.pathname === "/v1/jobs/next") {
        return json(
          this.database.claimNext(this.config.contextMessages, workerId(request) ?? null),
        );
      }

      const cancellationMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/cancelled$/);
      if (request.method === "GET" && cancellationMatch?.[1]) {
        return json({
          cancelled: this.database.isJobCancelled(Number.parseInt(cancellationMatch[1], 10)),
        });
      }

      const heartbeatMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/heartbeat$/);
      if (request.method === "POST" && heartbeatMatch?.[1]) {
        const currentWorkerId = workerId(request);
        return json({
          owned:
            currentWorkerId !== undefined &&
            this.database.heartbeat(Number.parseInt(heartbeatMatch[1], 10), currentWorkerId),
        });
      }

      const eventMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/events$/);
      if (request.method === "POST" && eventMatch?.[1]) {
        await this.event(
          Number.parseInt(eventMatch[1], 10),
          await body<AgentEvent>(request),
          workerId(request),
        );
        return json({ ok: true });
      }

      const completionMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/complete$/);
      if (request.method === "POST" && completionMatch?.[1]) {
        await this.complete(
          Number.parseInt(completionMatch[1], 10),
          await body<AgentCompletion>(request),
          workerId(request),
        );
        return json({ ok: true });
      }

      const failureMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/fail$/);
      if (request.method === "POST" && failureMatch?.[1]) {
        const payload = await body<{ error: string }>(request);
        await this.fail(Number.parseInt(failureMatch[1], 10), payload.error, workerId(request));
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/v1/archive/search") {
        const query = url.searchParams.get("q")?.trim();
        if (!query) {
          return json({ error: "q is required" }, 400);
        }
        const chat = url.searchParams.get("chat");
        const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        const limit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);
        return json({
          results: this.database.search(query, chat ? Number(chat) : null, limit),
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/status") {
        return json(this.database.stats());
      }

      if (request.method === "GET" && url.pathname === "/v1/media") {
        const fileId = url.searchParams.get("file_id");
        if (!fileId) {
          return json({ error: "file_id is required" }, 400);
        }
        const downloaded = await this.telegram.download(fileId);
        return new Response(downloaded.body, {
          headers: {
            "content-type": downloaded.headers.get("content-type") ?? "application/octet-stream",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/telegram/upload") {
        const form = await request.formData();
        const chatId = Number(form.get("chat_id"));
        const file = form.get("file");
        const caption = form.get("caption");
        if (!Number.isSafeInteger(chatId) || !this.database.chatExists(chatId)) {
          return json({ error: "unknown chat" }, 403);
        }
        if (!(file instanceof File)) {
          return json({ error: "file is required" }, 400);
        }
        const message = await this.telegram.sendDocument(
          chatId,
          file,
          file.name,
          typeof caption === "string" ? caption : null,
        );
        return json({ chatId: message.chat.id, messageId: message.message_id });
      }

      if (request.method === "POST" && url.pathname === "/v1/telegram/send") {
        const payload = await body<{
          chatId: number;
          markdown: string;
          replyTo?: number;
          threadId?: number;
        }>(request);
        if (!this.database.chatExists(payload.chatId)) {
          return json({ error: "unknown chat" }, 403);
        }
        const message = await this.telegram.sendRich(payload.chatId, payload.markdown, {
          ...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }),
          ...(payload.threadId === undefined ? {} : { threadId: payload.threadId }),
        });
        return json({ chatId: message.chat.id, messageId: message.message_id });
      }

      return json({ error: "not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ level: "error", message, path: url.pathname }));
      return json({ error: message }, 500);
    }
  }

  private async event(jobId: number, event: AgentEvent, workerId?: string): Promise<void> {
    if (this.database.isJobCancelled(jobId)) {
      return;
    }
    const line = `${event.kind}: ${event.text.trim()}`;
    const status = this.database.appendStatus(jobId, line, event.threadId, workerId);
    if (status === null) {
      return;
    }
    const address = this.database.jobAddress(jobId);
    const thinkingMessageId = this.database.thinkingMessage(jobId);
    const now = Date.now();
    const document = workDocument(status);
    if (thinkingMessageId === null) {
      const message = await this.telegram.sendRich(address.chatId, document, {
        replyTo: address.messageId,
        threadId: address.threadId,
      });
      this.database.setThinkingMessage(jobId, message.message_id);
      this.#lastStreamEdit.set(jobId, now);
      this.#lastStreamDocument.set(jobId, document);
      return;
    }
    if (this.#lastStreamDocument.get(jobId) === document) {
      return;
    }
    if (now - (this.#lastStreamEdit.get(jobId) ?? 0) >= 1_500) {
      await this.telegram.editRich(address.chatId, thinkingMessageId, document);
      this.#lastStreamEdit.set(jobId, now);
      this.#lastStreamDocument.set(jobId, document);
    }
  }

  private async complete(
    jobId: number,
    completion: AgentCompletion,
    workerId?: string,
  ): Promise<void> {
    if (this.database.isJobCancelled(jobId)) {
      return;
    }
    const address = this.database.jobAddress(jobId);
    const thinkingMessageId = this.database.thinkingMessage(jobId);
    const status = this.database.appendStatus(jobId, "Готово", completion.threadId, workerId);
    if (status === null) {
      return;
    }
    const document = completedDocument(status, completion.answer);
    const message =
      thinkingMessageId === null
        ? await this.telegram.sendRich(address.chatId, document, {
            replyTo: address.messageId,
            threadId: address.threadId,
          })
        : await this.telegram.editRich(address.chatId, thinkingMessageId, document);
    this.database.complete(jobId, message.message_id, completion.threadId, workerId);
    this.#lastStreamEdit.delete(jobId);
    this.#lastStreamDocument.delete(jobId);
  }

  private async fail(jobId: number, error: string, workerId?: string): Promise<void> {
    if (this.database.isJobCancelled(jobId)) {
      return;
    }
    if (workerId !== undefined && !this.database.isJobOwned(jobId, workerId)) {
      return;
    }
    const address = this.database.jobAddress(jobId);
    const thinkingMessageId = this.database.thinkingMessage(jobId);
    const markdown = `Не получилось завершить задачу.\n\n\`\`\`text\n${error.slice(0, 2_000)}\n\`\`\``;
    if (thinkingMessageId === null) {
      await this.telegram.sendRich(address.chatId, markdown, {
        replyTo: address.messageId,
        threadId: address.threadId,
      });
    } else {
      await this.telegram.editRich(address.chatId, thinkingMessageId, markdown);
    }
    this.database.fail(jobId, error.slice(0, 8_000), workerId);
    this.#lastStreamEdit.delete(jobId);
    this.#lastStreamDocument.delete(jobId);
  }
}
