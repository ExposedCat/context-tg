import type { LlmProgressSegment } from "./llm.ts";

export const PROGRESS_INTERVAL_MS = 10_000;
export const PROGRESS_PLACEHOLDERS = [
  "Thinking...",
  "Working...",
  "Analyzing...",
  "Processing...",
] as const;

/** One queue per request: text and its tools stay together across timer ticks. */
export function createProgressUpdates(options: {
  send: (segments: LlmProgressSegment[]) => Promise<void>;
  onError: (error: unknown) => void;
  signal?: AbortSignal;
  schedule?: (callback: () => void, delay: number) => () => void;
  random?: () => number;
  batchSize?: (segments: LlmProgressSegment[]) => number;
}) {
  const schedule =
    options.schedule ??
    ((callback, delay) => {
      const timeout = setTimeout(callback, delay);
      return () => clearTimeout(timeout);
    });
  const random = options.random ?? Math.random;
  let pending: LlmProgressSegment[] = [];
  let stopped = false;
  let timer: (() => void) | undefined;
  let sending: Promise<void> | undefined;

  function arm() {
    if (stopped) return;
    timer = schedule(() => {
      timer = undefined;
      sending = flush();
    }, PROGRESS_INTERVAL_MS);
  }

  async function flush() {
    if (stopped) return;
    const count = options.batchSize?.(pending) ?? pending.length;
    const batch = pending.slice(0, count);
    pending = pending.slice(count);
    const placeholder =
      PROGRESS_PLACEHOLDERS[
        Math.floor(random() * PROGRESS_PLACEHOLDERS.length)
      ];
    const segments = batch.some((segment) => segment.text?.trim())
      ? batch
      : [
          {
            text: placeholder,
            tools: [...new Set(batch.flatMap((segment) => segment.tools))],
          },
        ];
    try {
      await options.send(segments);
    } catch (error) {
      pending = [...batch, ...pending];
      options.onError(error);
    } finally {
      arm();
    }
  }

  function halt() {
    stopped = true;
    timer?.();
    timer = undefined;
  }

  options.signal?.addEventListener("abort", halt, { once: true });
  if (options.signal?.aborted) halt();
  arm();

  return {
    add(segments: LlmProgressSegment[]) {
      if (!stopped)
        pending.push(
          ...segments.map((segment) => ({
            ...segment,
            tools: [...segment.tools],
          })),
        );
    },
    async stop(): Promise<LlmProgressSegment[]> {
      halt();
      options.signal?.removeEventListener("abort", halt);
      await sending;
      const remaining = pending;
      pending = [];
      return remaining;
    },
  };
}
