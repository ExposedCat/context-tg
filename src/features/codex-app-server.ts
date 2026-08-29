import WebSocket, { type RawData } from "npm:ws@8.18.3";

type JsonRpcId = number | string;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export type CodexNotification = {
  method: string;
  params?: unknown;
};

export type CodexServerRequest = CodexNotification & {
  id: JsonRpcId;
};

export type CodexServerRequestHandler = (
  request: CodexServerRequest,
) => unknown | Promise<unknown>;

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export type CodexAppServerClientOptions = {
  url: string;
  token: string;
  signal?: AbortSignal;
  onNotification?: (notification: CodexNotification) => void;
  onServerRequest?: CodexServerRequestHandler;
};

function getMessageText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (Array.isArray(data)) {
    return data.map((part) => new TextDecoder().decode(part)).join("");
  }

  return new TextDecoder().decode(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRpcError(value: unknown): JsonRpcError | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return typeof value.code === "number" && typeof value.message === "string"
    ? { code: value.code, message: value.message, data: value.data }
    : undefined;
}

export class CodexAppServerClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #options: CodexAppServerClientOptions;
  readonly #opened: Promise<void>;
  #nextRequestId = 1;
  #closed = false;

  constructor(options: CodexAppServerClientOptions) {
    this.#options = options;
    this.#socket = new WebSocket(options.url, {
      headers: {
        Authorization: `Bearer ${options.token}`,
      },
    });
    this.#opened = new Promise((resolve, reject) => {
      this.#socket.once("open", resolve);
      this.#socket.once("error", reject);
      this.#socket.once("close", () => {
        reject(new Error("Codex app-server connection closed before opening"));
      });
    });

    this.#socket.on("message", (data: RawData) => {
      this.#handleMessage(getMessageText(data));
    });
    this.#socket.on("error", (error: Error) => {
      this.#rejectPending(error);
    });
    this.#socket.on("close", (_code: number, reason: Uint8Array) => {
      this.#closed = true;
      const suffix = reason.length > 0 ? `: ${reason.toString()}` : "";
      this.#rejectPending(
        new Error(`Codex app-server connection closed${suffix}`),
      );
    });

    if (options.signal) {
      const abort = () => this.close();
      if (options.signal.aborted) {
        abort();
      } else {
        options.signal.addEventListener("abort", abort, { once: true });
      }
    }
  }

  async connect(): Promise<void> {
    await this.#opened;
  }

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    await this.#opened;

    if (this.#closed) {
      throw new Error("Codex app-server connection is closed");
    }

    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const response = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    this.#send({ id, method, params });
    return await response;
  }

  async notify(method: string, params: unknown = {}): Promise<void> {
    await this.#opened;
    this.#send({ method, params });
  }

  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#socket.close();
    this.#rejectPending(new DOMException("Request aborted", "AbortError"));
  }

  #send(message: Record<string, unknown>): void {
    this.#socket.send(JSON.stringify(message));
  }

  #rejectPending(error: unknown): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #handleMessage(text: string): void {
    let message: unknown;

    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (!isRecord(message)) {
      return;
    }

    const method =
      typeof message.method === "string" ? message.method : undefined;
    const id =
      typeof message.id === "number" || typeof message.id === "string"
        ? message.id
        : undefined;

    if (method && id !== undefined) {
      void this.#handleServerRequest({ id, method, params: message.params });
      return;
    }

    if (method) {
      this.#options.onNotification?.({ method, params: message.params });
      return;
    }

    if (id === undefined) {
      return;
    }

    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }

    this.#pending.delete(id);
    const error = getRpcError(message.error);

    if (error) {
      pending.reject(new CodexRpcError(error.code, error.message, error.data));
      return;
    }

    pending.resolve(message.result);
  }

  async #handleServerRequest(request: CodexServerRequest): Promise<void> {
    try {
      if (!this.#options.onServerRequest) {
        throw new CodexRpcError(
          -32601,
          `Unsupported server request: ${request.method}`,
        );
      }

      const result = await this.#options.onServerRequest(request);
      this.#send({ id: request.id, result });
    } catch (error) {
      const rpcError =
        error instanceof CodexRpcError
          ? error
          : new CodexRpcError(
              -32603,
              error instanceof Error ? error.message : String(error),
            );
      this.#send({
        id: request.id,
        error: {
          code: rpcError.code,
          message: rpcError.message,
          ...(rpcError.data === undefined ? {} : { data: rpcError.data }),
        },
      });
    }
  }
}
