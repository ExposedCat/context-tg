import type { PlotInput } from "./html-plot-engine.ts";

const PLOT = /<tg-plot\b([^>]*)>([\s\S]*?)<\/tg-plot\s*>/gi;
const MAX_PLOTS = 4;
const PLOT_TIMEOUT_MS = 15_000;

type PlotResult = { svg?: string; error?: string };

/**
 * Replaces `<tg-plot>` elements in a visual with SVG. Expressions run in a
 * worker that is terminated after a deadline. A failed plot becomes a warning
 * note so the rest of the visual still renders.
 */
export async function expandHtmlPlots(
  html: string,
  signal?: AbortSignal,
  timeoutMs = PLOT_TIMEOUT_MS,
): Promise<string> {
  const matches = [...html.matchAll(PLOT)];
  if (!matches.length) return html;

  const plots = matches
    .slice(0, MAX_PLOTS)
    .map(([, attributes = "", body = ""]) => ({ attributes, body }));
  const results = await runPlotWorker(plots, timeoutMs, signal);
  let index = 0;
  return html.replace(PLOT, () => {
    const result: PlotResult =
      results[index++] ??
      ({ error: `Use at most ${MAX_PLOTS} plots per visual.` } as const);
    return (
      result.svg ??
      `<aside class="v-note is-warn"><b>Plot unavailable</b>${escapeHtml(result.error ?? "")}</aside>`
    );
  });
}

function runPlotWorker(
  plots: PlotInput[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PlotResult[]> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./html-plot-worker.ts", import.meta.url).href,
    );
    const finish = (results?: PlotResult[], error?: unknown) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(results ?? []);
    };
    const abort = () => finish(undefined, signal?.reason);
    const timeout = setTimeout(
      () =>
        finish(
          plots.map(() => ({
            error: `Plot calculation exceeded the ${timeoutMs / 1000} s limit. Try simpler expressions or fewer mesh lines.`,
          })),
        ),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ results: PlotResult[] }>) =>
      finish(event.data.results);
    worker.onerror = (event) =>
      finish(plots.map(() => ({ error: event.message })));
    worker.postMessage({ plots });
  });
}

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char,
  );
}
