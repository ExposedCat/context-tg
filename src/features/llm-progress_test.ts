import { deepStrictEqual, strictEqual } from "node:assert";
import type { LlmProgressSegment } from "./llm.ts";
import { createProgressUpdates, PROGRESS_INTERVAL_MS } from "./llm-progress.ts";

function clock() {
  let callback: (() => void) | undefined;
  return {
    schedule(fn: () => void, delay: number) {
      strictEqual(delay, 10_000);
      callback = fn;
      return () => {
        callback = undefined;
      };
    },
    cancel() {
      callback = undefined;
    },
    async tick() {
      const fn = callback;
      callback = undefined;
      fn?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    armed: () => callback !== undefined,
  };
}

Deno.test("progress batches preserve each segment's tools and drain after each interval", async () => {
  const timer = clock();
  const messages: LlmProgressSegment[][] = [];
  const updates = createProgressUpdates({
    ...timer,
    send: (segments) => {
      messages.push(segments);
      return Promise.resolve();
    },
    onError: (error) => {
      throw error;
    },
    random: () => 0,
  });
  updates.add([{ text: "Found relevant articles.", tools: ["web_search"] }]);
  updates.add([
    { text: "I'll check sources.", tools: ["read_web_page"] },
    { text: "Got it. Writing final response.", tools: [] },
  ]);
  strictEqual(messages.length, 0);
  await timer.tick();
  deepStrictEqual(messages, [
    [
      { text: "Found relevant articles.", tools: ["web_search"] },
      { text: "I'll check sources.", tools: ["read_web_page"] },
      { text: "Got it. Writing final response.", tools: [] },
    ],
  ]);
  updates.add([{ tools: ["read_web_page", "read_web_page"] }]);
  await timer.tick();
  deepStrictEqual(messages[1], [
    { text: "Thinking...", tools: ["read_web_page"] },
  ]);
  await timer.tick();
  deepStrictEqual(messages[2], [{ text: "Thinking...", tools: [] }]);
  updates.add([{ text: "Last unsent progress", tools: ["search_chat"] }]);
  deepStrictEqual(await updates.stop(), [
    { text: "Last unsent progress", tools: ["search_chat"] },
  ]);
  strictEqual(timer.armed(), false);
  await timer.tick();
  strictEqual(messages.length, 3);
  strictEqual(PROGRESS_INTERVAL_MS, 10_000);
});

Deno.test("progress stops on cancellation and waits for an in-flight send", async () => {
  const timer = clock();
  const controller = new AbortController();
  let release!: () => void;
  let sent = 0;
  const updates = createProgressUpdates({
    ...timer,
    signal: controller.signal,
    send: () => {
      sent++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    onError: (error) => {
      throw error;
    },
  });
  await timer.tick();
  let stopped = false;
  const stopping = updates.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  strictEqual(stopped, false);
  release();
  await stopping;
  strictEqual(timer.armed(), false);
  await timer.tick();
  strictEqual(sent, 1);

  const canceled = createProgressUpdates({
    ...timer,
    signal: controller.signal,
    send: () => {
      sent++;
      return Promise.resolve();
    },
    onError: () => {},
  });
  controller.abort();
  await timer.tick();
  strictEqual(sent, 1);
  await canceled.stop();
});

Deno.test("failed progress delivery retains queued text and does not break the request", async () => {
  const timer = clock();
  let errors = 0;
  const updates = createProgressUpdates({
    ...timer,
    send: () => Promise.reject(new Error("Telegram unavailable")),
    onError: () => {
      errors++;
    },
  });
  updates.add([{ text: "Searching", tools: ["web_search"] }]);
  await timer.tick();
  strictEqual(errors, 1);
  deepStrictEqual(await updates.stop(), [
    { text: "Searching", tools: ["web_search"] },
  ]);
});

Deno.test("oversized batches send once per interval and preserve the remaining parts", async () => {
  const timer = clock();
  const sent: LlmProgressSegment[][] = [];
  const updates = createProgressUpdates({
    ...timer,
    batchSize: () => 1,
    send: (batch) => {
      sent.push(batch);
      return Promise.resolve();
    },
    onError: () => {},
  });
  updates.add([
    { text: "First", tools: ["web_search"] },
    { text: "Second", tools: ["read_web_page"] },
  ]);
  await timer.tick();
  strictEqual(sent.length, 1);
  deepStrictEqual(sent[0], [{ text: "First", tools: ["web_search"] }]);
  await timer.tick();
  strictEqual(sent.length, 2);
  deepStrictEqual(sent[1], [{ text: "Second", tools: ["read_web_page"] }]);
  deepStrictEqual(await updates.stop(), []);
});
