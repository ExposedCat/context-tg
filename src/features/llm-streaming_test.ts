import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";

for (const [key, value] of Object.entries({
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  LLM_STREAMING: "true",
  KEENABLE_API_KEY: "test",
  LLM_TEMPERATURE: "0.2",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test",
  QDRANT_URL: "https://qdrant.test",
}))
  Deno.env.set(key, value);

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

Deno.test("wallet exhaustion aborts after ten funded text tokens and preserves the partial answer", async () => {
  setLlmDeploymentName("small", "stream-test");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let closed = false;
  try {
    await handleUsageCommand(database, -1, "-49", true, (key) => key);
    const spent = await wallet(database).reserve(TOKENS_PER_CREDIT);
    await spent.settle(TOKENS_PER_CREDIT - 10);
    globalThis.fetch = (async (_url, init) => {
      requests++;
      // Only visible text spends the ten remaining token credits; the
      // application does not cap reasoning or the provider's output size.
      strictEqual(JSON.parse(String(init?.body)).max_output_tokens, undefined);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(frame(created));
            for (const part of [
              "1",
              " ",
              "2",
              " ",
              "3",
              " ",
              "4",
              " ",
              "5",
              " ",
              "6",
              " ",
            ]) {
              controller.enqueue(frame({ ...delta, delta: part }));
            }
          },
          cancel() {
            closed = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const result = await requestLlm(
      "Count",
      [],
      undefined,
      { textCredits: wallet(database) },
      "Be brief.",
    );
    strictEqual(requests, 1);
    strictEqual(closed, true);
    ok(result.response?.startsWith("1 2 3 4 5 "));
    ok(result.response?.includes("Text credit limit reached"));
    ok(!result.response?.includes("6 "));
    strictEqual((await getUsageStatus(database, -1)).used, 1);
    strictEqual(
      (
        await database
          .selectFrom("credit_text_reservations")
          .selectAll()
          .execute()
      ).length,
      0,
    );
    await rejects(
      () =>
        requestLlm(
          "More",
          [],
          undefined,
          { textCredits: wallet(database) },
          "Be brief.",
        ),
      (error) =>
        error instanceof LlmRequestError && error.kind === "token_limit",
    );
    strictEqual(requests, 1);

    // An unlimited chat continues the conversation: the local limit notice in
    // history must not leak its synthetic id, and nothing is cut off.
    await handleUsageCommand(database, -1, "+unlimited", true, (key) => key);
    let replayedIds: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      replayedIds = body.input
        .map((item: { id?: string }) => item.id)
        .filter((id: string | undefined) => id !== undefined);
      return sse([
        created,
        delta,
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
    strictEqual(requests, 2);
    ok(replayedIds.every((id) => !id.startsWith("msg-local-")));
    ok(!continued.response?.includes("Text credit limit reached"));
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

Deno.test("text credits count progress and final text, excluding input, reasoning and tool arguments", async () => {
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
  }) as typeof fetch;
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

Deno.test("canceling streamed text charges only received text and refunds unused reservation", async () => {
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
    )) as typeof fetch;
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
    strictEqual(
      (
        await database
          .selectFrom("credit_text_reservations")
          .selectAll()
          .execute()
      ).length,
      0,
    );
  } finally {
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

Deno.test("streamed text deltas arrive before completion and the final response supplies usage", async () => {
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

Deno.test("streamed tool arguments execute only after a terminal response and follow-up also streams", async () => {
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

Deno.test("canceling an already-started task closes an idle stream without retries or tools", async () => {
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

Deno.test("a dropped stream after partial tool arguments is never retried or executed", async () => {
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
  }) as typeof fetch;
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

Deno.test("a streamed provider output limit preserves partial text without retrying", async () => {
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
  }) as typeof fetch;
  try {
    const answer = await requestLlm("Work", [], undefined, {}, "Be brief.");
    ok(answer.response?.includes("Hello"));
    ok(answer.response?.includes("model reached its output limit"));
    strictEqual(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("an admin stream can exceed 64000 text tokens without an application generation cap", async () => {
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
