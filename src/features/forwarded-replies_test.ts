import { jest, test } from "bun:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { ForwardBatcher, isForwardedMessage } from "./forwarded-replies.ts";

test("forward detection uses Telegram metadata, never ordinary text or reply parents", () => {
  for (const forward of [
    { forward_origin: { type: "channel" } },
    { forward_origin: { type: "hidden_user" } },
    { forward_from: { id: 1 } },
    { forward_from_chat: { id: -1 } },
    { forward_sender_name: "Hidden sender" },
    { forward_date: 100 },
  ])
    strictEqual(isForwardedMessage(forward), true);
  strictEqual(isForwardedMessage({}), false);
});

test("each new forward restarts the two-second window", async () => {
  jest.useFakeTimers();
  try {
    const batches: number[][] = [];
    const batcher = new ForwardBatcher<number>(async (posts) => {
      batches.push(posts);
    });
    const first = batcher.add("chat:7", 1);
    jest.advanceTimersByTime(1_999);
    const second = batcher.add("chat:7", 2);
    jest.advanceTimersByTime(1_999);
    await Promise.resolve();
    deepStrictEqual(batches, []);
    jest.advanceTimersByTime(1);
    await Promise.all([first, second]);
    deepStrictEqual(batches, [[1, 2]]);
  } finally {
    jest.useRealTimers();
  }
});

test("ten forwards wait for silence and an oversized burst is discarded until silence", async () => {
  jest.useFakeTimers();
  const release = Promise.withResolvers<void>();
  try {
    const batches: number[][] = [];
    const batcher = new ForwardBatcher<number>(async (posts) => {
      batches.push(posts);
      if (posts[0] === 1) await release.promise;
    });
    const queue = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => batcher.add("chat:7", start + i));
    const first = queue(1, 10);
    jest.advanceTimersByTime(1_999);
    await Promise.resolve();
    deepStrictEqual(batches, []);
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    deepStrictEqual(batches, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
    const overflow = queue(11, 10);
    jest.advanceTimersByTime(1_999);
    overflow.push(batcher.add("chat:7", 21));
    await Promise.all(overflow);
    jest.advanceTimersByTime(1_999);
    await batcher.add("chat:7", 22);
    const otherTopic = batcher.add("chat:8", 23);
    jest.advanceTimersByTime(2_000);
    await otherTopic;
    deepStrictEqual(
      batches.map((batch) => batch[0]),
      [1, 23],
    );
    const next = batcher.add("chat:7", 24);
    jest.advanceTimersByTime(2_000);
    release.resolve();
    await Promise.all([...first, next]);
    deepStrictEqual(batches.slice(2), [[24]]);
  } finally {
    release.resolve();
    jest.useRealTimers();
  }
});

test("a failed batch leaves subsequent batches eligible for processing", async () => {
  jest.useFakeTimers();
  try {
    const batches: number[][] = [];
    const batcher = new ForwardBatcher<number>(async (posts) => {
      batches.push(posts);
      if (posts[0] === 1) throw new Error("failed batch");
    });
    const first = batcher.add("chat:7", 1);
    const failed = rejects(first, /failed batch/);
    jest.advanceTimersByTime(2_000);
    const second = batcher.add("chat:7", 2);
    jest.advanceTimersByTime(2_000);
    await Promise.all([failed, second]);
    deepStrictEqual(batches, [[1], [2]]);
  } finally {
    jest.useRealTimers();
  }
});
