import type { AgentEvent } from "../shared/types.ts";
import type { AgentConfig } from "./config.ts";

type CodexItem = {
  type?: string;
  text?: string;
  command?: string;
  exit_code?: number;
};

type CodexJsonEvent = {
  type?: string;
  thread_id?: string;
  message?: string;
  item?: CodexItem;
};

export type CodexRunResult = {
  answer: string;
  threadId: string;
};

export async function runCodex(
  config: AgentConfig,
  prompt: string,
  resumeThreadId: string | null,
  onEvent: (event: AgentEvent) => Promise<void>,
): Promise<CodexRunResult> {
  const common = [
    "--json",
    "--model",
    config.model,
    "-c",
    `model_reasoning_effort=${config.reasoningEffort}`,
    "-c",
    "check_for_update_on_startup=false",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  const arguments_ = resumeThreadId
    ? ["exec", "resume", ...common, resumeThreadId, "-"]
    : [
        "exec",
        ...common,
        "--cd",
        config.repositoryPath,
        "--add-dir",
        config.memoryPath,
        "--add-dir",
        "/workspace",
        "-",
      ];
  const child = Bun.spawn([config.codexBinary, ...arguments_], {
    cwd: config.repositoryPath,
    env: {
      ...process.env,
      CODEX_HOME: config.codexHome,
      LOYLEX_MEMORY_PATH: config.memoryPath,
    },
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
  });

  let threadId = resumeThreadId;
  let finalAnswer = "";
  let pendingAgentMessage = "";
  let buffered = "";
  const decoder = new TextDecoder();

  async function flushCommentary(): Promise<void> {
    if (!pendingAgentMessage.trim()) {
      return;
    }
    await onEvent({
      kind: "commentary",
      text: pendingAgentMessage,
      ...(threadId ? { threadId } : {}),
    });
    pendingAgentMessage = "";
  }

  for await (const chunk of child.stdout) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const event = JSON.parse(line) as CodexJsonEvent;
      if (event.type === "thread.started" && event.thread_id) {
        threadId = event.thread_id;
        await onEvent({ kind: "status", text: "Начал работу", threadId });
      } else if (event.type === "item.completed" && event.item?.type === "agent_message") {
        await flushCommentary();
        pendingAgentMessage = event.item.text ?? pendingAgentMessage;
      } else if (event.type === "turn.completed") {
        finalAnswer = pendingAgentMessage || finalAnswer;
        pendingAgentMessage = "";
      } else if (event.type === "item.started" && event.item?.type === "command_execution") {
        await flushCommentary();
        await onEvent({
          kind: "command",
          text: (event.item.command ?? "terminal command").slice(0, 500),
          ...(threadId ? { threadId } : {}),
        });
      } else if (event.type === "item.completed" && event.item?.type === "command_execution") {
        await onEvent({
          kind: "status",
          text: `Команда завершена с кодом ${event.item.exit_code ?? "unknown"}`,
          ...(threadId ? { threadId } : {}),
        });
      } else if (event.type === "item.completed" && event.item?.type === "reasoning") {
        const text = event.item.text?.trim();
        if (text) {
          await onEvent({
            kind: "reasoning",
            text: text.slice(0, 1_500),
            ...(threadId ? { threadId } : {}),
          });
        }
      } else if (event.type === "error") {
        await onEvent({
          kind: "status",
          text: event.message ?? "Codex reported an error",
          ...(threadId ? { threadId } : {}),
        });
      }
    }
  }

  const status = await child.exited;
  if (!finalAnswer && pendingAgentMessage) {
    finalAnswer = pendingAgentMessage;
  }
  if (status !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`Codex exited with ${status}: ${stderr.slice(-4_000)}`);
  }
  if (!threadId) {
    throw new Error("Codex did not provide a thread ID");
  }
  if (!finalAnswer.trim()) {
    throw new Error("Codex completed without an answer");
  }
  return { answer: finalAnswer, threadId };
}
