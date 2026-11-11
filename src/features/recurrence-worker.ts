import { calculateOccurrences, type Recurrence } from "./recurrence.ts";

self.onmessage = (
  event: MessageEvent<{ input: Recurrence; after: number; count: number }>,
) => {
  try {
    const { input, after, count } = event.data;
    self.postMessage({ dates: calculateOccurrences(input, after, count) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
