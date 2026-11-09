import { test } from "bun:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { qdrantRequest } from "./messages.ts";

const searchPath = "/collections/messages/points/search";
const reset = () =>
  Object.assign(
    new TypeError("The socket connection was closed unexpectedly."),
    {
      code: "ECONNRESET",
    },
  );

test("Qdrant reads recover on the third retry and replay the same request", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const body = JSON.stringify({ vector: [1, 0], limit: 6 });
  const result = { result: [], status: "ok", time: 0 };
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    calls.push({ url: String(input), init });
    if (calls.length < 4) throw reset();
    return Response.json(result);
  }) as unknown as typeof fetch;
  try {
    deepStrictEqual(
      await qdrantRequest(searchPath, { method: "POST", body }),
      result,
    );
    strictEqual(calls.length, 4);
    for (const call of calls) {
      deepStrictEqual(call, calls[0]);
      strictEqual(call.init?.body, body);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qdrant stops after three retries and preserves the last transport error", async () => {
  const originalFetch = globalThis.fetch;
  const errors: Error[] = [];
  globalThis.fetch = (async () => {
    const error = reset();
    errors.push(error);
    throw error;
  }) as unknown as typeof fetch;
  try {
    await rejects(qdrantRequest(searchPath, { method: "POST" }), (error) => {
      strictEqual(errors.length, 4);
      strictEqual(error, errors[3]);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qdrant metadata and scroll reads retry nested and response-body transport errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const entry of [
      { path: "/collections/messages", init: {} },
      {
        path: "/collections/messages/points/scroll",
        init: { method: "POST" },
      },
    ]) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 1)
          throw new TypeError("fetch failed", { cause: reset() });
        if (calls === 2) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(reset());
              },
            }),
          );
        }
        return Response.json({ result: [] });
      }) as unknown as typeof fetch;
      deepStrictEqual(await qdrantRequest(entry.path, entry.init), {
        result: [],
      });
      strictEqual(calls, 3);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qdrant writes and permanent read errors fail without retrying", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const entry of [
      {
        path: "/collections/messages",
        init: { method: "PUT" },
        failure: reset(),
      },
      {
        path: "/collections/messages/points",
        init: { method: "PUT", body: "{}" },
        failure: reset(),
      },
      {
        path: "/collections/messages/points/delete",
        init: { method: "POST", body: "{}" },
        failure: reset(),
      },
      { path: searchPath, init: { method: "POST" }, failure: new Error("bug") },
      {
        path: searchPath,
        init: { method: "POST" },
        response: new Response("Bad query", { status: 400 }),
      },
      {
        path: searchPath,
        init: { method: "POST" },
        response: new Response("Unavailable", { status: 503 }),
      },
      {
        path: searchPath,
        init: { method: "POST" },
        response: new Response("not JSON"),
      },
    ]) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (entry.failure) throw entry.failure;
        return entry.response;
      }) as unknown as typeof fetch;
      await rejects(qdrantRequest(entry.path, entry.init));
      strictEqual(calls, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancelling a Qdrant retry wait stops further requests", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const reason = new Error("cancelled");
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    setTimeout(() => controller.abort(reason), 10);
    throw reset();
  }) as unknown as typeof fetch;
  try {
    await rejects(
      qdrantRequest(searchPath, { method: "POST", signal: controller.signal }),
      (error) => error === reason,
    );
    strictEqual(calls, 1);
    await rejects(
      qdrantRequest(searchPath, { method: "POST", signal: controller.signal }),
      (error) => error === reason,
    );
    strictEqual(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
