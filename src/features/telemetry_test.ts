import { deepStrictEqual } from "node:assert";
import { createLlmCallTiming } from "./telemetry.ts";

Deno.test("call timing includes tool waits and final generation, with per-call progress statistics", () => {
  let now = 100;
  const timing = createLlmCallTiming(() => now);
  now += 2000;
  timing.progress();
  now += 8000;
  timing.progress();
  now += 3000;
  timing.progress();
  now += 5000;
  deepStrictEqual(timing.snapshot(), {
    duration_ms: 18000,
    progress_intervals_ms: [2000, 8000, 3000],
    progress_count: 3,
    progress_total_ms: 13000,
    progress_median_ms: 3000,
    progress_min_ms: 2000,
    progress_max_ms: 8000,
  });
});

Deno.test("no-progress calls have no interval samples; even-sized medians average both middle values", () => {
  let now = 0;
  const timing = createLlmCallTiming(() => now);
  now = 500;
  deepStrictEqual(timing.snapshot(), {
    duration_ms: 500,
    progress_intervals_ms: [],
    progress_count: 0,
    progress_total_ms: 0,
    progress_median_ms: 0,
    progress_min_ms: 0,
    progress_max_ms: 0,
  });
  timing.progress();
  now = 2000;
  timing.progress();
  deepStrictEqual(timing.snapshot().progress_median_ms, 1000);
});
