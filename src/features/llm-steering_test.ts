import { test } from "bun:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import type { ServerWebSocket } from "bun";
import type OpenAI from "openai";

for (const [key, value] of Object.entries({
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  LLM_STREAMING: "true",
  KEENABLE_API_KEY: "test",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test",
  QDRANT_URL: "https://qdrant.test",
}))
  Bun.env[key] = value;

const { requestLlm, createLlmSteeringInput, LlmRequestError } = await import(
  "./llm.ts"
);
const { LlmSteering } = await import("./llm-steering.ts");
const { APP_ENV } = await import("./env.ts");
const { setLlmDeploymentName } = await import("./llm-deployments.ts");
const { initDatabase } = await import("./database.ts");
const { getLlmResponseInputItems } = await import("./llm-chat-responses.ts");
const { countTextTokens } = await import("./text-tokens.ts");

type Socket = ServerWebSocket<undefined>;
type Packet = Record<string, unknown> & {
  input?: OpenAI.Responses.ResponseInputItem[];
};
function result(id: string, text = "Done", output?: Packet[]) {
  return {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-6.2-sol",
    output: output ?? [
      {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 2000, output_tokens: 20, total_tokens: 2020 },
  };
}
function send(ws: Socket, event: Packet) {
  ws.send(JSON.stringify(event));
}
function start(ws: Socket, id: string) {
  send(ws, {
    type: "response.created",
    response: { ...result(id), status: "in_progress", output: [] },
  });
}
function finish(ws: Socket, response: Packet) {
  send(ws, { type: "response.completed", response });
}
function enqueue(steering: InstanceType<typeof LlmSteering>, text: string) {
  const submit = steering.reserve();
  ok(submit);
  submit(createLlmSteeringInput(text));
}
async function fixture(
  handler: (ws: Socket, packet: Packet) => void,
  http?: (request: Request) => Promise<Response>,
) {
  const before = APP_ENV.LLM_BASE_URL;
  const database = await initDatabase()();
  let serverError: unknown;
  const server = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      if (request.headers.get("upgrade") === "websocket") {
        ok(request.headers.get("authorization")?.includes("test"));
        if (server.upgrade(request, { data: undefined })) return;
      }
      if (http) return http(request);
      return new Response("Unexpected HTTP request", { status: 500 });
    },
    websocket: {
      message(ws, data) {
        try {
          handler(ws, JSON.parse(String(data)));
        } catch (error) {
          serverError = error;
          ws.close();
        }
      },
    },
  });
  Object.assign(APP_ENV, {
    LLM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
  });
  setLlmDeploymentName("big", "gpt-6.2-sol");
  return {
    database,
    async close() {
      Object.assign(APP_ENV, { LLM_BASE_URL: before });
      server.stop(true);
      await database.destroy();
      if (serverError) throw serverError;
    },
  };
}

test("a reserved message cannot be lost while finalization waits for its attachments", async () => {
  const queue = new LlmSteering();
  const submit = queue.reserve();
  ok(submit);
  let ended = false;
  const drain = queue.take(true).then((input) => {
    ended = true;
    return input;
  });
  await Promise.resolve();
  strictEqual(ended, false);
  submit(createLlmSteeringInput("Include the attachment"));
  strictEqual((await drain).length, 1);
  deepStrictEqual(await queue.take(true), []);
  strictEqual(queue.reserve(), undefined);
});

test("slow attachments cannot reorder steering messages", async () => {
  const queue = new LlmSteering();
  const first = queue.reserve();
  const second = queue.reserve();
  ok(first);
  ok(second);
  second(createLlmSteeringInput("Second"));
  deepStrictEqual(queue.peek(), []);
  first(createLlmSteeringInput("First"));
  const input = JSON.stringify(await queue.take());
  ok(input.indexOf("First") < input.indexOf("Second"));
});

test("native successors retain instructions, ordered history, usage and multiple steering messages", async () => {
  const steering = new LlmSteering();
  const received: Packet[] = [];
  let number = 0;
  const f = await fixture((ws, packet) => {
    received.push(packet);
    if (packet.type === "response.create") {
      strictEqual(packet.instructions, "Stable system prompt");
      strictEqual(packet.store, false);
      strictEqual(packet.context_management, undefined);
      start(ws, "first");
    } else {
      strictEqual(packet.type, "response.steer");
      strictEqual(packet.previous_response_id, number ? "second" : "first");
      ok(
        JSON.stringify(packet.input).includes(
          number ? "Second update" : "First update",
        ),
      );
      send(ws, {
        type: "response.steer.accepted",
        steer: { id: `steer${number}` },
      });
      finish(
        ws,
        result(
          number ? "second" : "first",
          number ? "Intermediate" : "Completed work",
        ),
      );
      number++;
      start(ws, number === 1 ? "second" : "third");
      if (number === 2) finish(ws, result("third", "Revised answer"));
    }
  });
  const charged: number[] = [];
  try {
    let created = 0;
    const response = await requestLlm(
      "Original",
      [],
      undefined,
      {
        database: f.database,
        steering,
        textCredits: {
          hasRemaining: async () => true,
          charge: async (tokens) => {
            charged.push(tokens);
            return true;
          },
        },
        onStreamEvent(event) {
          if (event.type === "response.created" && ++created <= 2)
            enqueue(steering, created === 1 ? "First update" : "Second update");
        },
      },
      "Stable system prompt",
    );
    strictEqual(response.response, "Revised answer");
    strictEqual(response.debug.responses.length, 3);
    strictEqual(received.filter((p) => p.type === "response.create").length, 1);
    strictEqual(
      charged.reduce((a, b) => a + b, 0),
      ["Completed work", "Intermediate", "Revised answer"].reduce(
        (sum, text) => sum + countTextTokens(text),
        0,
      ),
    );
    ok(response.response_id);
    const history = await getLlmResponseInputItems(
      f.database,
      response.response_id,
    );
    const text = JSON.stringify(history);
    const order = [
      "Original",
      "Completed work",
      "First update",
      "Intermediate",
      "Second update",
      "Revised answer",
    ];
    for (let i = 1; i < order.length; i++)
      ok(text.indexOf(order[i - 1]) < text.indexOf(order[i]));
    strictEqual((text.match(/First update/g) ?? []).length, 1);
  } finally {
    await f.close();
  }
});

test("steering during client tools keeps completed tool results without repeating execution", async () => {
  const steering = new LlmSteering();
  let creates = 0;
  let executed = 0;
  const f = await fixture((ws, packet) => {
    strictEqual(packet.type, "response.create");
    creates++;
    start(ws, `tool${creates}`);
    if (creates === 1)
      finish(
        ws,
        result("tool1", "", [
          {
            type: "function_call",
            id: "fc1",
            call_id: "call1",
            name: "set_reply_message_id",
            arguments: '{"message_id":7}',
          },
        ]),
      );
    else {
      const input = JSON.stringify(packet.input);
      ok(input.includes("call1"));
      ok(input.includes("function_call_output"));
      ok(input.includes("Updated while tool ran"));
      finish(ws, result("tool2", "Tool-aware answer"));
    }
  });
  try {
    const response = await requestLlm(
      "Original",
      ["set_reply_message_id"],
      undefined,
      {
        database: f.database,
        steering,
        chargeCredits: async (kind) => {
          if (kind === "tool") {
            executed++;
            enqueue(steering, "Updated while tool ran");
          }
        },
      },
      "Stable system prompt",
    );
    strictEqual(response.response, "Tool-aware answer");
    strictEqual(executed, 1);
    strictEqual(creates, 2);
  } finally {
    await f.close();
  }
});

test("a steer queued before a function call is appended once at the next tool boundary", async () => {
  const steering = new LlmSteering();
  let creates = 0;
  const f = await fixture((ws, packet) => {
    if (packet.type === "response.create") {
      creates++;
      start(ws, `pending${creates}`);
      if (creates === 2) {
        strictEqual(
          (JSON.stringify(packet.input).match(/Queued update/g) ?? []).length,
          1,
        );
        ok(JSON.stringify(packet.input).includes("function_call_output"));
        finish(ws, result("pending2"));
      }
    } else {
      send(ws, { type: "response.steer.accepted", steer: { id: "queued" } });
      finish(
        ws,
        result("pending1", "", [
          {
            type: "function_call",
            id: "fc1",
            call_id: "call1",
            name: "set_reply_message_id",
            arguments: '{"message_id":7}',
          },
        ]),
      );
      send(ws, {
        type: "response.steer.pending",
        reason: "waiting_for_required_input",
      });
    }
  });
  try {
    await requestLlm(
      "Original",
      ["set_reply_message_id"],
      undefined,
      {
        database: f.database,
        steering,
        onStreamEvent(event) {
          if (
            event.type === "response.created" &&
            event.response.id === "pending1"
          )
            enqueue(steering, "Queued update");
        },
      },
      "Stable system prompt",
    );
    strictEqual(creates, 2);
  } finally {
    await f.close();
  }
});

test("unsupported native steering falls back to the next model call without losing input", async () => {
  const steering = new LlmSteering();
  let creates = 0;
  const f = await fixture((ws, packet) => {
    if (packet.type === "response.create") {
      creates++;
      start(ws, `fallback${creates}`);
      if (creates === 2) {
        const input = JSON.stringify(packet.input);
        ok(input.includes("Earlier work"));
        ok(input.includes("Fallback update"));
        finish(ws, result("fallback2", "Updated answer"));
      }
    } else {
      send(ws, {
        type: "response.steer.failed",
        error: { code: "steering_not_supported" },
      });
      finish(ws, result("fallback1", "Earlier work"));
    }
  });
  try {
    const response = await requestLlm(
      "Original",
      [],
      undefined,
      {
        database: f.database,
        steering,
        onStreamEvent(event) {
          if (
            event.type === "response.created" &&
            event.response.id === "fallback1"
          )
            enqueue(steering, "Fallback update");
        },
      },
      "Stable system prompt",
    );
    strictEqual(response.response, "Updated answer");
    strictEqual(creates, 2);
  } finally {
    await f.close();
  }
});

test("a disconnect after acceptance saves the original work and uncommitted update for explicit resume", async () => {
  const steering = new LlmSteering();
  let creates = 0;
  const f = await fixture((ws, packet) => {
    if (packet.type === "response.create") {
      creates++;
      start(ws, "disconnect");
    } else {
      send(ws, { type: "response.steer.accepted", steer: { id: "lost" } });
      finish(ws, result("disconnect", "Saved work"));
      ws.close();
    }
  });
  try {
    await rejects(
      () =>
        requestLlm(
          "Original",
          [],
          undefined,
          {
            database: f.database,
            steering,
            onStreamEvent(event) {
              if (event.type === "response.created")
                enqueue(steering, "Uncommitted update");
            },
          },
          "Stable system prompt",
        ),
      (asyncError) => {
        ok(asyncError instanceof LlmRequestError);
        strictEqual(asyncError.kind, "stream_interrupted");
        ok(asyncError.lastResponseId);
        return true;
      },
    );
    const rows = await f.database
      .selectFrom("llm_chat_responses")
      .select("messages")
      .execute();
    ok(
      rows.some(
        (row) =>
          row.messages.includes("Saved work") &&
          row.messages.includes("Uncommitted update"),
      ),
    );
    strictEqual(creates, 1);
  } finally {
    await f.close();
  }
});

test("native steering compacts between generations and saves the returned window for replay", async () => {
  const threshold = APP_ENV.LLM_COMPACT_THRESHOLD;
  let creates = 0;
  let compactions = 0;
  const f = await fixture(
    (ws, packet) => {
      strictEqual(packet.type, "response.create");
      strictEqual(packet.context_management, undefined);
      creates++;
      start(ws, `compact${creates}`);
      if (creates === 2) {
        ok(packet.input);
        ok(packet.input[0].type === "compaction");
        strictEqual(packet.input[0].encrypted_content, "opaque-window");
      }
      finish(
        ws,
        result(
          `compact${creates}`,
          creates === 1 ? "Prior work ".repeat(30) : "Compacted answer",
        ),
      );
    },
    async (request) => {
      ok(request.url.endsWith("/responses/compact"));
      compactions++;
      const body = (await request.json()) as Packet;
      strictEqual(body.instructions, "Stable system prompt");
      ok(JSON.stringify(body.input).includes("Prior work"));
      ok(JSON.stringify(body.input).includes("Follow-up"));
      return Response.json({
        id: "cmp1",
        object: "response.compaction",
        created_at: 1,
        output: [
          {
            type: "compaction",
            id: "cmpitem",
            encrypted_content: "opaque-window",
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
      });
    },
  );
  try {
    const first = await requestLlm(
      "Original",
      [],
      undefined,
      { database: f.database, steering: new LlmSteering() },
      "Stable system prompt",
    );
    Object.assign(APP_ENV, { LLM_COMPACT_THRESHOLD: 100 });
    const next = await requestLlm(
      "Follow-up",
      [],
      first.response_id,
      { database: f.database, steering: new LlmSteering() },
      "Stable system prompt",
    );
    strictEqual(next.response, "Compacted answer");
    strictEqual(compactions, 1);
    ok(next.response_id);
    const history = await getLlmResponseInputItems(
      f.database,
      next.response_id,
    );
    strictEqual(history?.[0].type, "compaction");
    ok(!JSON.stringify(history).includes("Prior work"));
  } finally {
    Object.assign(APP_ENV, { LLM_COMPACT_THRESHOLD: threshold });
    await f.close();
  }
});

test("canceling an idle native stream closes its socket without a replay or tool execution", async () => {
  const abort = new AbortController();
  let creates = 0;
  const f = await fixture((ws, packet) => {
    strictEqual(packet.type, "response.create");
    creates++;
    start(ws, "cancel");
  });
  try {
    await rejects(
      () =>
        requestLlm(
          "Original",
          ["set_reply_message_id"],
          undefined,
          {
            steering: new LlmSteering(),
            signal: abort.signal,
            onStreamEvent(event) {
              if (event.type === "response.created")
                abort.abort(new DOMException("Canceled", "AbortError"));
            },
            chargeCredits: async () => {
              throw new Error("No tools after cancellation");
            },
          },
          "Stable system prompt",
        ),
      (error) => error instanceof DOMException && error.name === "AbortError",
    );
    strictEqual(creates, 1);
  } finally {
    await f.close();
  }
});

test("native credit exhaustion preserves received text and queued steering in one tool-free wrap-up", async () => {
  const steering = new LlmSteering();
  let creates = 0;
  let remaining = true;
  const partial = "work ".repeat(160);
  const f = await fixture((ws, packet) => {
    if (packet.type !== "response.create") return;
    creates++;
    start(ws, `quota${creates}`);
    if (creates === 1)
      send(ws, {
        type: "response.output_text.delta",
        item_id: "partial",
        content_index: 0,
        output_index: 0,
        delta: partial,
      });
    else {
      strictEqual(packet.tools, undefined);
      ok(
        String(packet.instructions).includes(
          "daily credit limit has been reached",
        ),
      );
      const input = JSON.stringify(packet.input);
      ok(input.includes(partial));
      strictEqual((input.match(/Queued quota update/g) ?? []).length, 1);
      finish(ws, result("quota2", "Final quota answer"));
    }
  });
  try {
    const response = await requestLlm(
      "Original",
      ["set_reply_message_id"],
      undefined,
      {
        database: f.database,
        steering,
        textCredits: {
          hasRemaining: async () => remaining,
          charge: async (tokens) => {
            if (tokens > 0) remaining = false;
            return remaining;
          },
        },
        onStreamEvent(event) {
          if (
            event.type === "response.created" &&
            event.response.id === "quota1"
          )
            enqueue(steering, "Queued quota update");
        },
        chargeCredits: async () => {
          throw new Error("Tools must not execute after exhaustion");
        },
      },
      "Stable system prompt",
    );
    strictEqual(response.response, "Final quota answer");
    strictEqual(creates, 2);
    strictEqual(steering.reserve(), undefined);
  } finally {
    await f.close();
  }
});

test("a failed WebSocket upgrade uses SSE without replaying a started generation", async () => {
  const before = APP_ENV.LLM_BASE_URL;
  let upgrades = 0;
  let calls = 0;
  const steering = new LlmSteering();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.headers.get("upgrade")) {
        upgrades++;
        return new Response("Upgrade unavailable", { status: 404 });
      }
      calls++;
      const body = (await request.json()) as Packet;
      if (calls === 2)
        ok(JSON.stringify(body.input).includes("Queued SSE update"));
      const response = result(
        `sse${calls}`,
        calls === 1 ? "SSE work" : "SSE revision",
      );
      return new Response(
        [
          {
            type: "response.created",
            response: { ...response, status: "in_progress", output: [] },
          },
          { type: "response.completed", response },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  Object.assign(APP_ENV, {
    LLM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
  });
  setLlmDeploymentName("big", "gpt-6.2-sol");
  try {
    const response = await requestLlm(
      "Original",
      [],
      undefined,
      {
        steering,
        onStreamEvent(event) {
          if (event.type === "response.created" && event.response.id === "sse1")
            enqueue(steering, "Queued SSE update");
        },
      },
      "Stable system prompt",
    );
    strictEqual(response.response, "SSE revision");
    strictEqual(calls, 2);
    strictEqual(upgrades, 2);
  } finally {
    Object.assign(APP_ENV, { LLM_BASE_URL: before });
    server.stop(true);
  }
});
