import type { AgentJob } from "../shared/types.ts";

export function buildPrompt(job: AgentJob, buckets: string): string {
  const metadata = {
    telegram_chat_id: job.chatId,
    telegram_chat_type: job.chatType,
    telegram_message_id: job.messageId,
    telegram_message_thread_id: job.messageThreadId,
    telegram_user_id: job.userId,
    attachments: job.attachments,
  };
  return [
    "You received a Telegram request through Loylex.",
    "Answer the user in the user's language. Work for as long as the task genuinely needs.",
    "Use your full Linux environment and terminal. Follow AGENTS.md in your repository.",
    "The Telegram bot token is intentionally unavailable. Use the loylex CLI for archive search, status, media download, and outbound Telegram actions.",
    "Your final response is delivered automatically. Never call `loylex send` merely to send that response; use outbound actions only when the task explicitly requires a separate proactive message.",
    "Do not merely describe a safe in-scope action when you can execute it.",
    "Request metadata:",
    JSON.stringify(metadata, null, 2),
    buckets ? `Automatically selected private memory:\n\n${buckets}` : "",
    `Recent Telegram context:\n\n${job.context || "(no prior messages archived)"}`,
    `Current request:\n\n${job.prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
