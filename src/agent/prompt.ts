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
  // `exec resume` restores the prior transcript, so follow-ups only need current-turn data.
  const instructions = job.resumeThreadId
    ? [
        "Continue the existing Codex thread with this new Telegram turn.",
        "Answer in the user's language and work for as long as the task genuinely needs.",
        "Re-apply the original constraints and current AGENTS.md; verify the current sender ID before any code or repository action.",
        "The Telegram token is unavailable; use the loylex CLI when Telegram archive, status, media, or outbound actions are needed.",
        "The final answer is delivered automatically; do not send it separately.",
      ]
    : [
        "You received a Telegram request through Loylex.",
        "Answer the user in the user's language. Work for as long as the task genuinely needs.",
        "Use your full Linux environment and terminal. Follow AGENTS.md in your repository.",
        "The Telegram bot token is intentionally unavailable. Use the loylex CLI for archive search, status, media download, and outbound Telegram actions.",
        "Your final response is delivered automatically. Never call `loylex send` merely to send that response; use outbound actions only when the task explicitly requires a separate proactive message.",
        "Do not merely describe a safe in-scope action when you can execute it.",
      ];
  const contextTitle =
    job.contextMode === "delta"
      ? "New Telegram context since the previous Codex turn:"
      : "Recent Telegram context:";
  const emptyContext =
    job.contextMode === "delta" ? "(no new messages archived)" : "(no prior messages archived)";
  return [
    ...instructions,
    "Request metadata:",
    JSON.stringify(metadata, null, 2),
    buckets ? `Automatically selected private memory:\n\n${buckets}` : "",
    `${contextTitle}\n\n${job.context || emptyContext}`,
    `Current request:\n\n${job.prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
