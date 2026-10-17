import type { LlmProgressSegment, ToolName } from "./llm.ts";

export const PROGRESS_INTERVAL_MS = 30_000;
export const PROGRESS_TOOL_INTERVAL_MS = 60_000;
export const PROGRESS_PLACEHOLDER_INTERVAL_MS = 80_000;
export const PROGRESS_PLACEHOLDERS = [
  "Thinking...",
  "Working...",
  "Analyzing...",
  "Processing...",
] as const;

const TOOL_PROGRESS_LABELS = {
  web_search: ["searched web", "searched web {count} times"],
  read_web_page: ["read webpage", "read {count} webpages"],
  search_images: ["searched images", "searched images {count} times"],
  search_danbooru: ["searched Danbooru", "searched Danbooru {count} times"],
  search_danbooru_tags: [
    "looked up Danbooru tags",
    "looked up Danbooru tags {count} times",
  ],
  read_image: ["read image", "read {count} images"],
  search_chat: ["searched chat", "searched chat {count} times"],
  get_message_context: [
    "read message context",
    "read message context {count} times",
  ],
  read_last_messages: [
    "read recent messages",
    "read recent messages {count} times",
  ],
  get_markets_state: ["checked markets", "checked markets {count} times"],
  get_recent_news: ["read recent news", "read recent news {count} times"],
  read_youtube_video: ["read YouTube video", "read {count} YouTube videos"],
  generate_image: ["generated image", "generated {count} images"],
  set_reply_message_id: [
    "selected reply target",
    "selected reply target {count} times",
  ],
  send_report: ["prepared report", "prepared {count} reports"],
  send_trading_report: [
    "prepared trading report",
    "prepared {count} trading reports",
  ],
  schedule_message: ["scheduled message", "scheduled {count} messages"],
  cron_message: [
    "scheduled recurring message",
    "scheduled {count} recurring messages",
  ],
  get_scheduled_messages: [
    "checked scheduled messages",
    "checked scheduled messages {count} times",
  ],
  cancel_scheduled_message: [
    "canceled scheduled message",
    "canceled {count} scheduled messages",
  ],
  remember: ["saved memory", "saved {count} memories"],
  forget: ["removed memory", "removed {count} memories"],
} satisfies Record<Exclude<ToolName, `finance_${string}`>, [string, string]>;

export function formatProgressToolSummary(tools: readonly ToolName[]): string {
  const counts = new Map<string, { labels: [string, string]; count: number }>();
  for (const tool of tools) {
    const key = tool.startsWith("finance_") ? "finance" : tool;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      const labels = tool.startsWith("finance_")
        ? (["read finance report", "read {count} finance reports"] as [
            string,
            string,
          ])
        : TOOL_PROGRESS_LABELS[tool as keyof typeof TOOL_PROGRESS_LABELS];
      counts.set(key, { labels, count: 1 });
    }
  }
  const summary = [...counts.values()]
    .map(({ labels, count }) =>
      count === 1 ? labels[0] : labels[1].replace("{count}", String(count)),
    )
    .join(", ");
  return summary ? summary[0].toUpperCase() + summary.slice(1) : "";
}

/** One queue per request: text and its tools stay together across timer ticks. */
export function createProgressUpdates(options: {
  send: (segments: LlmProgressSegment[]) => Promise<void>;
  onError: (error: unknown) => void;
  signal?: AbortSignal;
  schedule?: (callback: () => void, delay: number) => () => void;
  random?: () => number;
  batchSize?: (segments: LlmProgressSegment[]) => number;
  now?: () => number;
}) {
  const schedule =
    options.schedule ??
    ((callback, delay) => {
      const timeout = setTimeout(callback, delay);
      return () => clearTimeout(timeout);
    });
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => performance.now());
  let lastRealProgressAt = now();
  let lastPlaceholderAt = lastRealProgressAt;
  let pending: LlmProgressSegment[] = [];
  let stopped = false;
  let timer: (() => void) | undefined;
  let sending: Promise<void> | undefined;

  function arm(delay = PROGRESS_INTERVAL_MS) {
    if (stopped) return;
    timer = schedule(() => {
      timer = undefined;
      sending = flush();
    }, delay);
  }

  async function flush() {
    if (stopped) return;
    const hasText = pending.some((segment) => segment.text?.trim());
    const hasTools = pending.some((segment) => segment.tools.length > 0);
    const idleFor = now() - Math.max(lastRealProgressAt, lastPlaceholderAt);
    const idleInterval = hasTools
      ? PROGRESS_TOOL_INTERVAL_MS
      : PROGRESS_PLACEHOLDER_INTERVAL_MS;
    if (!hasText && idleFor < idleInterval) {
      arm(Math.min(PROGRESS_INTERVAL_MS, idleInterval - idleFor));
      return;
    }
    const count = options.batchSize?.(pending) ?? pending.length;
    const batch = pending.slice(0, count);
    pending = pending.slice(count);
    const hasRealText = batch.some((segment) => segment.text?.trim());
    const tools = batch.flatMap((segment) => segment.tools);
    const segments = hasRealText
      ? batch
      : [
          {
            text:
              formatProgressToolSummary(tools) ||
              PROGRESS_PLACEHOLDERS[
                Math.floor(random() * PROGRESS_PLACEHOLDERS.length)
              ],
            tools: [...new Set(tools)],
          },
        ];
    try {
      await options.send(segments);
      if (hasRealText) lastRealProgressAt = now();
      else lastPlaceholderAt = now();
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
      if (stopped) return;
      if (segments.some((segment) => segment.text?.trim()))
        lastRealProgressAt = now();
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
