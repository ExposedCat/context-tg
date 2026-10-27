import { test } from "bun:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";

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

const { requestLlm, LlmRequestError } = await import("./llm.ts");
const { setLlmDeploymentName } = await import("./llm-deployments.ts");
const { initDatabase } = await import("./database.ts");
const {
  createTask,
  createTaskAbortController,
  cancelTask,
  deleteTaskAbortController,
  getTask,
} = await import("./tasks.ts");
const { createTextCreditCharge, getUsageStatus, handleUsageCommand } =
  await import("./usage.ts");
const { countTextTokens, TOKENS_PER_CREDIT } = await import("./text-tokens.ts");

import type { Context } from "../bot.ts";
import type { Database } from "./database.ts";

function wallet(database: Database, chatId = -1) {
  return createTextCreditCharge({
    database,
    chat: { id: chatId, type: "supergroup" },
    telemetry: { event: () => {} },
  } as unknown as Context);
}

test("exhaustion flushes live usage, preserves progress and requests one final answer without tools", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let closed = false;
  const partial = "123".repeat(140);
  const progress: string[] = [];
  try {
    await handleUsageCommand(database, -1, "-49", true, (key) => key);
    await wallet(database).charge(TOKENS_PER_CREDIT - 10);
    globalThis.fetch = (async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      strictEqual(body.max_output_tokens, undefined);
      if (requests === 1)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame(created));
              controller.enqueue(frame({ ...delta, delta: partial }));
            },
            cancel() {
              closed = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      strictEqual(body.tools, undefined);
      ok(body.instructions.includes("daily credit limit has been reached"));
      ok(
        body.input.some(
          (item: { role?: string; content?: unknown }) =>
            item.role === "assistant" &&
            JSON.stringify(item.content).includes(partial),
        ),
      );
      return sse([
        created,
        { type: "response.completed", response: response("resp_quota_final") },
      ]);
    }) as typeof fetch;
    const result = await requestLlm(
      "Count",
      ["set_reply_message_id"],
      undefined,
      {
        textCredits: wallet(database),
        onProgress: ({ segments }) => {
          progress.push(
            ...(segments ?? []).flatMap((s) => (s.text ? [s.text] : [])),
          );
        },
        chargeCredits: async () => {
          throw new Error("Tools must not execute after exhaustion");
        },
      },
      "Be brief.",
    );
    strictEqual(requests, 2);
    strictEqual(closed, true);
    strictEqual(result.response, "Hello!");
    ok(progress.some((text) => text.includes(partial)));
    strictEqual((await getUsageStatus(database, -1)).used, 1);
    const { createCreditCharge } = await import("./usage.ts");
    await rejects(
      () =>
        createCreditCharge({
          database,
          chat: { id: -1, type: "supergroup" },
          telemetry: { event: () => {} },
        } as unknown as Context)("request"),
      /Daily credit limit reached/,
    );
    strictEqual(requests, 2);
    await handleUsageCommand(database, -1, "+unlimited", true, (key) => key);
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      ok(
        body.input.every(
          (item: { id?: string }) => !item.id?.startsWith("msg-local-"),
        ),
      );
      return sse([
        created,
        { type: "response.completed", response: response("resp_unlimited") },
      ]);
    }) as typeof fetch;
    const continued = await requestLlm(
      "Continue",
      [],
      result.response_id,
      { textCredits: wallet(database) },
      "Be brief.",
    );
    strictEqual(continued.response, "Hello!");
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

test("two active streams publish batches and both finish once a parallel task drains the balance", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const chunk = "123".repeat(128);
  let readyCount = 0;
  let ready!: () => void;
  const bothReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let starts = 0;
  let finals = 0;
  let closed = 0;
  const requests: Array<ReturnType<typeof requestLlm>> = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.instructions.includes("daily credit limit has been reached")) {
      finals++;
      strictEqual(body.tools, undefined);
      return sse([
        created,
        {
          type: "response.completed",
          response: response(`resp_shared_final_${finals}`),
        },
      ]);
    }
    starts++;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame(created));
          controller.enqueue(frame({ ...delta, delta: chunk }));
          controller.enqueue(frame({ ...delta, delta: chunk }));
        },
        cancel() {
          closed++;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  try {
    await handleUsageCommand(database, -1, "-49", true, (key) => key);
    for (let i = 0; i < 2; i++)
      requests.push(
        requestLlm(
          "Work",
          ["set_reply_message_id"],
          undefined,
          {
            textCredits: wallet(database),
            onStreamEvent: async (event) => {
              if (event.type === "response.output_text.delta") {
                if (++readyCount === 2) ready();
                await paused;
              }
            },
            chargeCredits: async () => {
              throw new Error("Exhausted tasks must not run tools");
            },
          },
          "Be brief.",
        ),
      );
    await bothReady;
    strictEqual(starts, 2);
    strictEqual(
      (await getUsageStatus(database, -1)).used,
      256 / TOKENS_PER_CREDIT,
    );
    await wallet(database).charge(500);
    strictEqual((await getUsageStatus(database, -1)).used, 1);
    release();
    const answers = await Promise.all(requests);
    deepStrictEqual(
      answers.map((answer) => answer.response),
      ["Hello!", "Hello!"],
    );
    strictEqual(finals, 2);
    strictEqual(closed, 2);
    strictEqual((await getUsageStatus(database, -1)).used, 1);
  } finally {
    release();
    await Promise.allSettled(requests);
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

test("credit exhaustion during a tool batch disables further tools, including a disobedient final turn", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const { createCreditCharge } = await import("./usage.ts");
  const ctx = {
    database,
    chat: { id: -1, type: "supergroup" },
    telemetry: { event: () => {} },
  } as unknown as Context;
  const tool = (id: string) => ({
    type: "function_call",
    id,
    call_id: id,
    name: "set_reply_message_id",
    arguments: '{"message_id":7}',
    status: "completed",
  });
  let requests = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests++;
    if (requests === 1)
      return sse([
        created,
        {
          type: "response.completed",
          response: response("resp_credit_tools", [
            tool("first"),
            tool("denied"),
          ]),
        },
      ]);
    strictEqual(body.tools, undefined);
    ok(body.instructions.includes("daily credit limit has been reached"));
    // Even a provider ignoring tools-disabled must not start another loop.
    return sse([
      created,
      {
        type: "response.completed",
        response: response("resp_ignored_credit_limit", [tool("ignored")]),
      },
    ]);
  }) as typeof fetch;
  try {
    await handleUsageCommand(database, -1, "-49", true, (key) => key);
    const answer = await requestLlm(
      "Reply",
      ["set_reply_message_id"],
      undefined,
      {
        textCredits: wallet(database),
        chargeCredits: createCreditCharge(ctx),
        context: { chatId: -1, messageId: 1 },
      },
      "Be brief.",
    );
    strictEqual(requests, 2);
    strictEqual(answer.replyMessageId, 7);
    ok(answer.response?.includes("Daily credit limit reached"));
    strictEqual((await getUsageStatus(database, -1)).used, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

test("exhaustion during reasoning before any text still gets a final answer", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const originalNow = performance.now;
  let offset = 0;
  let requests = 0;
  let closed = false;
  performance.now = () => originalNow.call(performance) + offset;
  globalThis.fetch = (async () => {
    if (++requests === 2)
      return sse([
        created,
        {
          type: "response.completed",
          response: response("resp_no_text_final"),
        },
      ]);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame(created));
          controller.enqueue(
            frame({
              type: "response.output_item.added",
              output_index: 0,
              item: { id: "rs_pending", type: "reasoning", summary: [] },
            }),
          );
        },
        cancel() {
          closed = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;
  try {
    await handleUsageCommand(database, -1, "-49", true, (key) => key);
    const answer = await requestLlm(
      "Think",
      [],
      undefined,
      {
        textCredits: wallet(database),
        onStreamEvent: async (event) => {
          if (event.type === "response.created" && requests === 1) {
            await wallet(database).charge(TOKENS_PER_CREDIT);
            offset += 1001;
          }
        },
      },
      "Be brief.",
    );
    strictEqual(answer.response, "Hello!");
    strictEqual(requests, 2);
    strictEqual(closed, true);
    strictEqual((await getUsageStatus(database, -1)).used, 1);
  } finally {
    performance.now = originalNow;
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

test("small text batches publish after one second before the response completes", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const originalNow = performance.now;
  let offset = 0;
  performance.now = () => originalNow.call(performance) + offset;
  globalThis.fetch = (async () =>
    sse([
      created,
      delta,
      { type: "response.completed", response: response("resp_timed_charge") },
    ])) as unknown as typeof fetch;
  try {
    await requestLlm(
      "Hello",
      [],
      undefined,
      {
        textCredits: wallet(database),
        onStreamEvent: async (event) => {
          if (event.type === "response.created") offset += 1001;
          if (event.type === "response.output_text.delta")
            strictEqual(
              (await getUsageStatus(database, -1)).used,
              countTextTokens("Hello") / TOKENS_PER_CREDIT,
            );
        },
      },
      "Be brief.",
    );
    strictEqual(
      (await getUsageStatus(database, -1)).used,
      countTextTokens("Hello!") / TOKENS_PER_CREDIT,
    );
  } finally {
    performance.now = originalNow;
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

test("non-streaming output can overlap the quota and still gets one final turn", async () => {
  setLlmDeploymentName("small", "stream-test");
  const { APP_ENV } = await import("./env.ts");
  const previousStreaming = APP_ENV.LLM_STREAMING;
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  Object.assign(APP_ENV, { LLM_STREAMING: false });
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    strictEqual(body.stream, undefined);
    strictEqual(body.max_output_tokens, undefined);
    if (++requests === 2) {
      strictEqual(body.tools, undefined);
      ok(body.instructions.includes("daily credit limit has been reached"));
    }
    return Response.json(response(`resp_nonstream_${requests}`));
  }) as typeof fetch;
  try {
    await handleUsageCommand(database, -1, "-49", true, (key) => key);
    await wallet(database).charge(TOKENS_PER_CREDIT - 1);
    const answer = await requestLlm(
      "Hello",
      ["set_reply_message_id"],
      undefined,
      { textCredits: wallet(database) },
      "Be brief.",
    );
    strictEqual(answer.response, "Hello!");
    strictEqual(requests, 2);
    strictEqual((await getUsageStatus(database, -1)).used, 1);
  } finally {
    Object.assign(APP_ENV, { LLM_STREAMING: previousStreaming });
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

test("an exhausted task does not retry a failed final response", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let transportFailure = false;
  globalThis.fetch = (async (_url, init) => {
    requests++;
    if (transportFailure) return new Response("Unavailable", { status: 503 });
    const body = JSON.parse(String(init?.body));
    strictEqual(body.tools, undefined);
    ok(body.instructions.includes("daily credit limit has been reached"));
    return sse([
      created,
      {
        type: "response.failed",
        response: {
          ...response("resp_failed_final", []),
          status: "failed",
          error: { code: "content_filter", message: "Blocked" },
        },
      },
    ]);
  }) as typeof fetch;
  try {
    await handleUsageCommand(database, -1, "-49", true, (key) => key);
    await wallet(database).charge(TOKENS_PER_CREDIT);
    await rejects(
      () =>
        requestLlm(
          "Reply",
          ["set_reply_message_id"],
          undefined,
          { textCredits: wallet(database) },
          "Be brief.",
        ),
      LlmRequestError,
    );
    strictEqual(requests, 1);
    requests = 0;
    transportFailure = true;
    await rejects(
      () =>
        requestLlm(
          "Reply",
          [],
          undefined,
          { textCredits: wallet(database) },
          "Be brief.",
        ),
      LlmRequestError,
    );
    strictEqual(requests, 1);
    strictEqual((await getUsageStatus(database, -1)).used, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

test("text credits count progress and final text, excluding input, reasoning and tool arguments", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const message = (
    id: string,
    text: string,
    phase: "commentary" | "final_answer",
  ) => ({
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    phase,
    content: [{ type: "output_text", text, annotations: [] }],
  });
  globalThis.fetch = (async () => {
    requests++;
    const tool = {
      type: "function_call",
      id: "fc_billing",
      call_id: "call_billing",
      name: "set_reply_message_id",
      arguments: '{"message_id":7}',
      status: "completed",
    };
    const output =
      requests === 1
        ? [message("progress", "Checking sources.", "commentary"), tool]
        : [message("final", "Done.", "final_answer")];
    return sse([
      created,
      {
        type: "response.completed",
        response: {
          ...response(`resp_billing_${requests}`, output),
          usage: {
            input_tokens: 3000,
            output_tokens: 1000,
            total_tokens: 4000,
            output_tokens_details: { reasoning_tokens: 990 },
          },
        },
      },
    ]);
  }) as unknown as typeof fetch;
  try {
    const { createCreditCharge } = await import("./usage.ts");
    const ctx = {
      database,
      chat: { id: -1, type: "supergroup" },
      telemetry: { event: () => {} },
    } as unknown as Context;
    const chargeCredits = createCreditCharge(ctx);
    await chargeCredits("request");
    await requestLlm(
      "Read then reply",
      ["set_reply_message_id"],
      undefined,
      {
        context: { chatId: -1, messageId: 1 },
        textCredits: wallet(database),
        chargeCredits,
      },
      "Be brief.",
    );
    const expected =
      countTextTokens("Checking sources.") + countTextTokens("Done.");
    strictEqual(
      (await getUsageStatus(database, -1)).used,
      2 + expected / TOKENS_PER_CREDIT,
    );
    strictEqual(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

test("canceling streamed text flushes only received text", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame(created));
          controller.enqueue(frame(delta));
        },
        cancel() {},
      }),
      { headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
  try {
    await rejects(
      () =>
        requestLlm(
          "Hello",
          [],
          undefined,
          {
            textCredits: wallet(database),
            signal: abort.signal,
            onStreamEvent: (event) => {
              if (event.type === "response.output_text.delta")
                abort.abort(new DOMException("Canceled", "AbortError"));
            },
          },
          "Be brief.",
        ),
      (error) => error instanceof DOMException && error.name === "AbortError",
    );
    strictEqual(
      (await getUsageStatus(database, -1)).used,
      countTextTokens("Hello") / TOKENS_PER_CREDIT,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

test("a paused stream leaves credits for a concurrent request and charges long answers in batches", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const { createCreditCharge } = await import("./usage.ts");
  const ctx = {
    database,
    chat: { id: -1, type: "supergroup" },
    telemetry: { event: () => {} },
  } as unknown as Context;
  const chargeCredits = createCreditCharge(ctx);
  const text = "123".repeat(TOKENS_PER_CREDIT * 2 + 10);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  globalThis.fetch = (async () => {
    const answer = ++requests === 1 ? text : "Hello!";
    return sse([
      created,
      { ...delta, delta: answer },
      {
        type: "response.completed",
        response: response(`resp_parallel_${requests}`, [
          {
            type: "message",
            id: "msg_pending",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: answer, annotations: [] }],
          },
        ]),
      },
    ]);
  }) as unknown as typeof fetch;
  let first: ReturnType<typeof requestLlm> | undefined;
  try {
    await chargeCredits("request");
    first = requestLlm(
      "Long answer",
      [],
      undefined,
      {
        textCredits: wallet(database),
        onStreamEvent: async (event) => {
          if (event.type === "response.created") {
            started();
            await paused;
          }
        },
      },
      "Answer the request.",
    );
    await ready;
    strictEqual((await getUsageStatus(database, -1)).used, 1);
    await chargeCredits("request");
    await chargeCredits("tool", "set_reply_message_id");
    const second = await requestLlm(
      "Hello",
      [],
      undefined,
      { textCredits: wallet(database) },
      "Be brief.",
    );
    strictEqual(second.response, "Hello!");
    release();
    strictEqual((await first).response, text);
    strictEqual(
      (await getUsageStatus(database, -1)).used,
      3 +
        (countTextTokens(text) + countTextTokens("Hello!")) / TOKENS_PER_CREDIT,
    );
  } finally {
    release();
    await first?.catch(() => {});
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

function response(
  id: string,
  output: unknown[] = [
    {
      type: "message",
      id: `msg_${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello!", annotations: [] }],
    },
  ],
) {
  return {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    output,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

const frame = (event: object) =>
  new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const created = {
  type: "response.created",
  response: { id: "resp_pending", status: "in_progress", output: [] },
};
const delta = {
  type: "response.output_text.delta",
  delta: "Hello",
  output_index: 0,
  content_index: 0,
  item_id: "msg_pending",
};

function sse(events: object[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(frame(event));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("streamed text deltas arrive before completion and the final response supplies usage", async () => {
  setLlmDeploymentName("small", "stream-test");
  const originalFetch = globalThis.fetch;
  const events: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    strictEqual(body.stream, true);
    strictEqual(body.store, false);
    strictEqual(body.max_output_tokens, undefined);
    return sse([
      created,
      delta,
      { type: "response.completed", response: response("resp_stream_text") },
    ]);
  }) as typeof fetch;
  try {
    const result = await requestLlm(
      "Hello",
      [],
      undefined,
      {
        onStreamEvent: (event) => {
          events.push(event.type);
        },
      },
      "Be brief.",
    );
    strictEqual(result.response, "Hello!");
    strictEqual(result.debug.responses[0].usage?.output_tokens, 5);
    deepStrictEqual(events, [
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamed tool arguments execute only after a terminal response and follow-up also streams", async () => {
  setLlmDeploymentName("small", "stream-test");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let executions = 0;
  const tool = {
    type: "function_call",
    id: "fc_stream",
    call_id: "call_stream",
    name: "set_reply_message_id",
    arguments: '{"message_id":7}',
    status: "completed",
  };
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    strictEqual(body.stream, true);
    requests++;
    if (requests === 1)
      return sse([
        created,
        {
          type: "response.function_call_arguments.delta",
          delta: tool.arguments,
          item_id: tool.id,
          output_index: 0,
        },
        {
          type: "response.completed",
          response: response("resp_stream_tool", [tool]),
        },
      ]);
    strictEqual(executions, 1);
    ok(
      body.input.some(
        (item: { type: string }) => item.type === "function_call_output",
      ),
    );
    return sse([
      created,
      delta,
      { type: "response.completed", response: response("resp_stream_done") },
    ]);
  }) as typeof fetch;
  try {
    const result = await requestLlm(
      "Reply",
      ["set_reply_message_id"],
      undefined,
      {
        context: { chatId: 1, messageId: 1 },
        chargeCredits: async () => {
          executions++;
        },
        onStreamEvent: (event) => {
          if (event.type === "response.function_call_arguments.delta")
            strictEqual(executions, 0);
        },
      },
      "Be brief.",
    );
    strictEqual(result.replyMessageId, 7);
    strictEqual(result.response, "Hello!");
    strictEqual(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("canceling an already-started task closes an idle stream without retries or tools", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const taskKey = { chat_id: 1, message_id: 123 };
  await createTask(database, {
    ...taskKey,
    thread_id: 1,
    task_text: "Streaming task",
  });
  const abort = createTaskAbortController(taskKey);
  let requests = 0;
  let closed = false;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  globalThis.fetch = (async (url, init) => {
    requests++;
    const req = new Request(url, init);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame(created));
          req.signal.addEventListener(
            "abort",
            () => {
              closed = true;
              controller.error(req.signal.reason);
            },
            { once: true },
          );
        },
        cancel() {
          closed = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  try {
    const pending = requestLlm(
      "Work",
      ["set_reply_message_id"],
      undefined,
      {
        signal: abort.signal,
        context: { chatId: 1, messageId: 123 },
        chargeCredits: () => {
          throw new Error("Tools must not execute");
        },
        onStreamEvent: () => {
          started();
        },
      },
      "Be brief.",
    );
    const rejection = rejects(
      () => pending,
      (error) => error instanceof DOMException && error.name === "AbortError",
    );
    await ready;
    strictEqual(await cancelTask(database, taskKey), "canceled");
    await rejection;
    strictEqual(closed, true);
    strictEqual(requests, 1);
    strictEqual((await getTask(database, taskKey))?.status, "canceled");
  } finally {
    globalThis.fetch = originalFetch;
    deleteTaskAbortController(taskKey);
    await database.destroy();
  }
});

test("a dropped stream after partial tool arguments is never retried or executed", async () => {
  setLlmDeploymentName("small", "stream-test");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return sse([
      created,
      {
        type: "response.function_call_arguments.delta",
        delta: '{"message_id":',
        item_id: "fc_drop",
        output_index: 0,
      },
    ]);
  }) as unknown as typeof fetch;
  try {
    await rejects(
      () =>
        requestLlm(
          "Work",
          ["set_reply_message_id"],
          undefined,
          {
            chargeCredits: () => {
              throw new Error("Partial tools must not execute");
            },
          },
          "Be brief.",
        ),
      (error) =>
        error instanceof LlmRequestError &&
        error.kind === "stream_interrupted" &&
        Boolean(error.lastResponseId),
    );
    strictEqual(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a streamed provider output limit preserves partial text without retrying", async () => {
  setLlmDeploymentName("small", "stream-test");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return sse([
      created,
      delta,
      {
        type: "response.incomplete",
        response: {
          ...response("resp_stream_limit", []),
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ]);
  }) as unknown as typeof fetch;
  try {
    const answer = await requestLlm("Work", [], undefined, {}, "Be brief.");
    ok(answer.response?.includes("Hello"));
    ok(answer.response?.includes("model reached its output limit"));
    strictEqual(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an admin stream can exceed 64000 text tokens without an application generation cap", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const text = "123".repeat(64001);
  const ctx = {
    database,
    from: { id: 1 },
    chat: { id: -800, type: "supergroup" },
    telemetry: { event: () => {} },
  } as unknown as Context;
  try {
    await handleUsageCommand(database, -800, "-50", true, (key) => key);
    globalThis.fetch = (async (_url, init) => {
      strictEqual(JSON.parse(String(init?.body)).max_output_tokens, undefined);
      return sse([
        created,
        { ...delta, delta: text },
        {
          type: "response.completed",
          response: {
            ...response("resp_unlimited_text", [
              {
                type: "message",
                id: "msg_unlimited",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text, annotations: [] }],
              },
            ]),
            usage: {
              input_tokens: 500000,
              output_tokens: 120000,
              total_tokens: 620000,
            },
          },
        },
      ]);
    }) as typeof fetch;
    const answer = await requestLlm(
      "Long answer",
      [],
      undefined,
      { textCredits: createTextCreditCharge(ctx) },
      "Answer the request.",
    );
    strictEqual(answer.response, text);
    strictEqual(
      (await getUsageStatus(database, -800)).used,
      64001 / TOKENS_PER_CREDIT,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

test("streams have no time limit: long silences and long answers both finish", async () => {
  setLlmDeploymentName("small", "stream-test");
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  // Any real limit (a minute up to weeks) fires after 20ms; the stream is silent
  // for 150ms (like long reasoning) and then streams for another 150ms.
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) =>
    originalSetTimeout(
      callback,
      delay !== undefined && delay >= 60_000 && delay < 2 ** 31 - 1
        ? 20
        : delay,
      ...args,
    )) as unknown as typeof setTimeout;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          // Like real fetch, an aborted request errors the body.
          init?.signal?.addEventListener("abort", () =>
            controller.error(init.signal?.reason),
          );
          controller.enqueue(frame(created));
          await Bun.sleep(150);
          for (let i = 0; i < 10; i++) {
            await Bun.sleep(15);
            controller.enqueue(frame({ ...delta, delta: "word " }));
          }
          controller.enqueue(
            frame({
              type: "response.completed",
              response: response("resp_slow"),
            }),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
  try {
    const result = await requestLlm("Long", [], undefined, {}, "Be brief.");
    strictEqual(result.response, "Hello!");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});
