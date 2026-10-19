import { deepStrictEqual, strictEqual } from "node:assert";
import type { LlmProgressSegment } from "./llm.ts";
import {
  createProgressUpdates,
  formatProgressToolSummary,
  PROGRESS_INTERVAL_MS,
  PROGRESS_PLACEHOLDER_INTERVAL_MS,
  PROGRESS_TOOL_INTERVAL_MS,
} from "./llm-progress.ts";

function clock() {
  let callback: (() => void) | undefined;
  let scheduledDelay = 0;
  let now = 0;
  return {
    now: () => now,
    schedule(fn: () => void, delay: number) {
      scheduledDelay = delay;
      callback = fn;
      return () => {
        callback = undefined;
      };
    },
    cancel() {
      callback = undefined;
    },
    async tick() {
      now += scheduledDelay;
      const fn = callback;
      callback = undefined;
      fn?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    armed: () => callback !== undefined,
  };
}

async function tickUntil(timer: ReturnType<typeof clock>, time: number) {
  while (timer.now() < time) await timer.tick();
  strictEqual(timer.now(), time);
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
  strictEqual(timer.now(), 60_000);
  strictEqual(messages.length, 1);
  await timer.tick();
  strictEqual(timer.now(), 90_000);
  deepStrictEqual(messages[1], [
    {
      text: "Read 2 webpages",
      tools: ["read_web_page"],
    },
  ]);
  await timer.tick();
  strictEqual(messages.length, 2);
  await tickUntil(timer, 390_000);
  deepStrictEqual(messages[2], [{ text: "Thinking...", tools: [] }]);
  updates.add([{ text: "Last unsent progress", tools: ["search_chat"] }]);
  deepStrictEqual(await updates.stop(), [
    { text: "Last unsent progress", tools: ["search_chat"] },
  ]);
  strictEqual(timer.armed(), false);
  await timer.tick();
  strictEqual(messages.length, 3);
  strictEqual(PROGRESS_INTERVAL_MS, 30_000);
  strictEqual(PROGRESS_TOOL_INTERVAL_MS, 60_000);
  strictEqual(PROGRESS_PLACEHOLDER_INTERVAL_MS, 300_000);
});

Deno.test("idle progress summarizes only new tools and returns to placeholders when idle", async () => {
  const timer = clock();
  const messages: LlmProgressSegment[][] = [];
  let randomCalls = 0;
  const updates = createProgressUpdates({
    ...timer,
    send: async (segments) => {
      messages.push(segments);
    },
    onError: (error) => {
      throw error;
    },
    random: () => {
      randomCalls++;
      return 0.25;
    },
  });
  await timer.tick();
  strictEqual(timer.now(), 30_000);
  strictEqual(messages.length, 0);
  await timer.tick();
  strictEqual(timer.now(), 60_000);
  strictEqual(messages.length, 0);
  await tickUntil(timer, 270_000);
  strictEqual(messages.length, 0);
  await timer.tick();
  strictEqual(timer.now(), 300_000);
  deepStrictEqual(messages[0], [{ text: "Working...", tools: [] }]);
  updates.add([
    {
      tools: [
        "web_search",
        "read_web_page",
        "read_web_page",
        "read_web_page",
        "read_last_messages",
      ],
    },
  ]);
  await timer.tick();
  strictEqual(timer.now(), 330_000);
  strictEqual(messages.length, 1);
  await timer.tick();
  strictEqual(timer.now(), 360_000);
  deepStrictEqual(messages[1], [
    {
      text: "Searched web, read 3 webpages, read recent messages",
      tools: ["web_search", "read_web_page", "read_last_messages"],
    },
  ]);
  await timer.tick();
  strictEqual(messages.length, 2);
  await tickUntil(timer, 660_000);
  deepStrictEqual(messages[2], [{ text: "Working...", tools: [] }]);
  updates.add([{ tools: ["web_search", "web_search"] }]);
  await tickUntil(timer, 720_000);
  deepStrictEqual(messages[3], [
    { text: "Searched web 2 times", tools: ["web_search"] },
  ]);
  strictEqual(randomCalls, 2);
  await updates.stop();
});

Deno.test("tool summaries cover built-in and dynamic finance tools", () => {
  strictEqual(formatProgressToolSummary([]), "");
  strictEqual(
    formatProgressToolSummary(["web_search", "read_web_page"]),
    "Searched web, read webpage",
  );
  strictEqual(
    formatProgressToolSummary([
      "web_search",
      "web_search",
      "get_message_context",
      "finance_portfolio",
      "finance_positions",
    ]),
    "Searched web 2 times, read message context, read 2 finance reports",
  );
});

Deno.test("retrying an idle tool summary does not count calls twice", async () => {
  const timer = clock();
  const attempts: LlmProgressSegment[][] = [];
  let errors = 0;
  const updates = createProgressUpdates({
    ...timer,
    send: async (segments) => {
      attempts.push(segments);
      if (attempts.length === 1) throw new Error("Telegram unavailable");
    },
    onError: () => {
      errors++;
    },
    random: () => {
      throw new Error("Tools should replace the placeholder");
    },
  });
  updates.add([{ tools: ["read_web_page", "read_web_page", "read_web_page"] }]);
  await timer.tick();
  await timer.tick();
  await timer.tick();
  strictEqual(attempts.length, 2);
  deepStrictEqual(attempts, [
    [{ text: "Read 3 webpages", tools: ["read_web_page"] }],
    [{ text: "Read 3 webpages", tools: ["read_web_page"] }],
  ]);
  strictEqual(errors, 1);
  deepStrictEqual(await updates.stop(), []);
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
  strictEqual(sent, 0);
  await tickUntil(timer, 300_000);
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

Deno.test("tool summaries include only the delivered batch", async () => {
  const timer = clock();
  const sent: LlmProgressSegment[][] = [];
  const updates = createProgressUpdates({
    ...timer,
    batchSize: () => 1,
    send: async (batch) => {
      sent.push(batch);
    },
    onError: (error) => {
      throw error;
    },
  });
  updates.add([
    { tools: ["web_search"] },
    { tools: ["read_web_page", "read_web_page"] },
  ]);
  await tickUntil(timer, 60_000);
  deepStrictEqual(sent, [[{ text: "Searched web", tools: ["web_search"] }]]);
  await tickUntil(timer, 120_000);
  deepStrictEqual(sent[1], [
    { text: "Read 2 webpages", tools: ["read_web_page"] },
  ]);
  deepStrictEqual(await updates.stop(), []);
});

Deno.test("tools arriving during delivery are retained for the next update", async () => {
  const timer = clock();
  const sent: LlmProgressSegment[][] = [];
  let release!: () => void;
  const updates = createProgressUpdates({
    ...timer,
    send: async (batch) => {
      sent.push(batch);
      if (sent.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
    onError: (error) => {
      throw error;
    },
  });
  updates.add([{ tools: ["web_search"] }]);
  await tickUntil(timer, 60_000);
  updates.add([{ tools: ["read_web_page"] }]);
  release();
  await Promise.resolve();
  await Promise.resolve();
  await tickUntil(timer, 120_000);
  deepStrictEqual(sent, [
    [{ text: "Searched web", tools: ["web_search"] }],
    [{ text: "Read webpage", tools: ["read_web_page"] }],
  ]);
  deepStrictEqual(await updates.stop(), []);
});
