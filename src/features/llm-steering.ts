import { constants } from "node:crypto";
import OpenAI from "openai";

type Input = OpenAI.Responses.ResponseInputItem;
type Response = OpenAI.Responses.Response;
type Event = OpenAI.Responses.ResponseStreamEvent;
type Entry = { input: Input[]; ready: boolean };

// Ownership stays local until a successor actually starts. An accepted steer
// alone is not a commit, and must survive a disconnect or a tool boundary.
export class LlmSteering {
  private entries: Entry[] = [];
  private preparing = new Set<Promise<void>>();
  private listener?: () => void;
  private closed = false;

  reserve() {
    if (this.closed) return undefined;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.preparing.add(ready);
    const entry: Entry = { input: [], ready: false };
    this.entries.push(entry);
    let settled = false;
    return (input: Input[] = []) => {
      if (settled) return;
      settled = true;
      entry.input = input;
      entry.ready = true;
      if (!input.length)
        this.entries = this.entries.filter((item) => item !== entry);
      this.preparing.delete(ready);
      release();
      this.listener?.();
    };
  }

  peek() {
    const blocked = this.entries.findIndex((entry) => !entry.ready);
    return this.entries.slice(0, blocked < 0 ? undefined : blocked);
  }

  commit(entries: Entry[]) {
    const committed = new Set(entries);
    this.entries = this.entries.filter((entry) => !committed.has(entry));
    return entries.flatMap((entry) => entry.input);
  }

  async take(closeWhenEmpty = false): Promise<Input[]> {
    while (this.preparing.size) await Promise.all(this.preparing);
    const input = this.commit(this.peek());
    if (closeWhenEmpty && !input.length) this.close();
    return input;
  }

  subscribe(listener: () => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  close() {
    this.closed = true;
  }
}

export function usesNativeSteering(model: string, steering?: LlmSteering) {
  return Boolean(steering && /^gpt-6(?:[.-]|$)/i.test(model));
}

// One connection owns a model generation and its automatic successors. Client
// tools remain owned by the existing tool loop. At a tool boundary we close the
// socket, retain uncommitted updates, and append them to the next full request.
// This also keeps stateless replay/recovery independent of socket lifetime.
export async function* streamSteerableResponse(
  client: OpenAI,
  params: OpenAI.Responses.ResponseCreateParamsNonStreaming,
  steering: LlmSteering,
  signal: AbortSignal,
  onContinuation: (response: Response, input: Input[]) => Promise<void>,
): AsyncGenerator<Event> {
  const url = new URL(`${client.baseURL.replace(/\/$/, "")}/responses`);
  const azure = url.hostname.endsWith(".openai.azure.com");
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const Socket = WebSocket as unknown as {
    new (address: URL, options: Bun.WebSocketOptions): WebSocket;
  };
  const socket = new Socket(url, {
    headers: azure
      ? { "api-key": client.apiKey ?? "" }
      : { Authorization: `Bearer ${client.apiKey}` },
    ...(azure ? { tls: { secureOptions: constants.SSL_OP_NO_TLSv1_3 } } : {}),
    perMessageDeflate: false,
  });
  const queue: Array<Record<string, unknown>> = [];
  let wake: (() => void) | undefined;
  let failure: unknown;
  let ended = false;
  let opened = false;
  let activeId: string | undefined;
  let terminal: Response | undefined;
  let pending: Entry[] | undefined;
  let native = true;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const sendPending = () => {
    if (!native || !activeId || terminal || pending || signal.aborted) return;
    const entries = steering.peek();
    if (!entries.length) return;
    pending = entries;
    try {
      socket.send(
        JSON.stringify({
          type: "response.steer",
          previous_response_id: activeId,
          input: entries.flatMap((entry) => entry.input),
        }),
      );
    } catch (error) {
      failure = error;
      ended = true;
      notify();
    }
  };
  const unsubscribe = steering.subscribe(sendPending);
  const abort = () => {
    failure = signal.reason;
    ended = true;
    socket.close();
    notify();
  };
  signal.addEventListener("abort", abort, { once: true });
  socket.onopen = () => {
    opened = true;
    socket.send(JSON.stringify({ ...params, type: "response.create" }));
  };
  socket.onmessage = (message) => {
    try {
      queue.push(JSON.parse(String(message.data)));
    } catch (error) {
      failure = error;
      ended = true;
    }
    notify();
  };
  socket.onerror = () => {
    failure = new OpenAI.APIConnectionError({
      message: "Responses WebSocket connection failed",
    });
    ended = true;
    notify();
  };
  socket.onclose = () => {
    ended = true;
    notify();
  };
  try {
    signal.throwIfAborted();
    while (true) {
      if (!queue.length && !ended)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      signal.throwIfAborted();
      const raw = queue.shift();
      if (!raw) {
        if (failure) throw failure;
        if (ended)
          throw new OpenAI.APIConnectionError({
            message: "Responses WebSocket closed before completion",
          });
        continue;
      }
      const type = raw.type;
      if (type === "error") {
        const error = raw.error as { message?: string; code?: string };
        throw new OpenAI.APIError(undefined, error, error.message, undefined);
      }
      if (type === "response.steer.failed") {
        // Nothing was applied. Retain the messages for the next normal call.
        pending = undefined;
        native = false;
        if (terminal) {
          yield { type: "response.completed", response: terminal } as Event;
          return;
        }
        continue;
      }
      if (
        type === "response.steer.accepted" ||
        type === "response.steer.pending"
      )
        continue;
      if (type === "response.created") {
        const response = raw.response as Response;
        if (terminal && pending) {
          const previous = terminal;
          terminal = undefined;
          const input = steering.commit(pending);
          pending = undefined;
          await onContinuation(previous, input);
        }
        activeId = response.id;
      }
      if (
        type === "response.completed" ||
        type === "response.incomplete" ||
        type === "response.failed"
      ) {
        const response = raw.response as Response;
        const toolBoundary = response.output.some(
          (item) => item.type === "function_call",
        );
        const reason = response.incomplete_details?.reason as
          | string
          | undefined;
        if (
          pending &&
          !toolBoundary &&
          (response.status === "completed" || reason === "steered")
        ) {
          terminal = response;
          continue;
        }
        yield raw as unknown as Event;
        return;
      }
      yield raw as unknown as Event;
      sendPending();
    }
  } catch (error) {
    if (
      !opened &&
      !signal.aborted &&
      error instanceof OpenAI.APIConnectionError
    ) {
      // A failed upgrade hasn't started a model request. Keep HTTP-only
      // providers/proxies working and apply queued input at the next boundary.
      const stream = await client.responses.create(
        { ...params, stream: true },
        { signal },
      );
      for await (const event of stream) yield event;
      return;
    }
    // Preserve a completed original response even if the connection dies
    // before its queued update commits to a successor.
    if (terminal) await onContinuation(terminal, []);
    throw error;
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", abort);
    socket.close();
  }
}
