import { expect, test } from "bun:test";
import type { GatewayConfig } from "../src/gateway/config.ts";
import type { LoylexDatabase } from "../src/gateway/database.ts";
import { GatewayServer } from "../src/gateway/server.ts";
import type { TelegramClient } from "../src/gateway/telegram.ts";
import type { AgentCompletion, TelegramMessage } from "../src/shared/types.ts";

function botMessage(id: number): TelegramMessage {
  return {
    message_id: id,
    date: 1,
    chat: { id: -10042, type: "supergroup", title: "Test" },
  };
}

function config(): GatewayConfig {
  return {
    botToken: "unused",
    bridgeToken: "unused",
    databasePath: ":memory:",
    listenHost: "127.0.0.1",
    listenPort: 8787,
    pollTimeoutSeconds: 1,
    contextMessages: 10,
  };
}

test("starts progress as a persistent rich details message", async () => {
  const sent: Array<{
    chatId: number;
    markdown: string;
    options: { replyTo?: number; threadId?: number | null };
  }> = [];
  let thinkingMessageId: number | null = null;

  const database = {
    jobAddress: () => ({
      chatId: -10042,
      chatType: "supergroup" as const,
      messageId: 10,
      threadId: null,
    }),
    thinkingMessage: () => thinkingMessageId,
    isJobCancelled: () => false,
    appendStatus: (_jobId: number, line: string) => line,
    setThinkingMessage: (_jobId: number, messageId: number) => {
      thinkingMessageId = messageId;
    },
  } as unknown as LoylexDatabase;

  const telegram = {
    sendRich: async (
      chatId: number,
      markdown: string,
      options: { replyTo?: number; threadId?: number | null },
    ) => {
      sent.push({ chatId, markdown, options });
      return botMessage(11);
    },
  } as unknown as TelegramClient;

  const server = new GatewayServer(config(), database, telegram);
  const event = (
    server as unknown as {
      event: (jobId: number, event: { kind: "commentary"; text: string }) => Promise<void>;
    }
  ).event;

  await event.call(server, 7, { kind: "commentary", text: "Проверяю код" });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({
    chatId: -10042,
    markdown: "<details><summary>Ход работы</summary>\n\n- Проверяю код\n\n</details>",
    options: { replyTo: 10, threadId: null },
  });
  expect(sent[0]?.markdown).not.toContain("tg-spoiler");
});

test("sends a new final reply and removes the temporary progress message", async () => {
  const sent: Array<{
    chatId: number;
    markdown: string;
    options: { replyTo?: number; threadId?: number | null };
  }> = [];
  const deleted: Array<{ chatId: number; messageId: number }> = [];
  const calls: string[] = [];
  let completed: { jobId: number; messageId: number; threadId: string } | null = null;

  const database = {
    jobAddress: () => ({
      chatId: -10042,
      chatType: "supergroup" as const,
      messageId: 10,
      threadId: null,
    }),
    thinkingMessage: () => 11,
    isJobCancelled: () => false,
    appendStatus: () => "status: Готово",
    recordOutboundMessage: () => {},
    complete: (jobId: number, messageId: number, threadId: string) => {
      completed = { jobId, messageId, threadId };
    },
  } as unknown as LoylexDatabase;

  const telegram = {
    sendRich: async (
      chatId: number,
      markdown: string,
      options: { replyTo?: number; threadId?: number | null },
    ) => {
      calls.push("send");
      sent.push({ chatId, markdown, options });
      return botMessage(12);
    },
    deleteMessage: async (chatId: number, messageId: number) => {
      calls.push("delete");
      deleted.push({ chatId, messageId });
      return true;
    },
  } as unknown as TelegramClient;

  const server = new GatewayServer(config(), database, telegram);
  const complete = (
    server as unknown as {
      complete: (jobId: number, completion: AgentCompletion) => Promise<void>;
    }
  ).complete;

  await complete.call(server, 7, { answer: "Ответ", threadId: "thread-1" });

  expect(calls).toEqual(["send", "delete"]);
  expect(sent).toEqual([
    {
      chatId: -10042,
      markdown: "<details><summary>Ход работы</summary>\n\n- Готово\n\n</details>\n\nОтвет",
      options: { replyTo: 10, threadId: null },
    },
  ]);
  expect(deleted).toEqual([{ chatId: -10042, messageId: 11 }]);
  expect(completed as { jobId: number; messageId: number; threadId: string } | null).toEqual({
    jobId: 7,
    messageId: 12,
    threadId: "thread-1",
  });
});

test("uses ephemeral rich drafts in private chats", async () => {
  const drafts: Array<{
    chatId: number;
    markdown: string;
    options: { draftId: number; threadId?: number | null; canStop?: boolean };
  }> = [];
  const sent: Array<{
    markdown: string;
    options: { replyTo?: number; threadId?: number | null };
  }> = [];
  const deleted: Array<{ chatId: number; messageId: number }> = [];
  let completedMessageId: number | null = null;
  let status = "";

  const database = {
    jobAddress: () => ({
      chatId: 42,
      chatType: "private" as const,
      messageId: 10,
      threadId: null,
    }),
    thinkingMessage: () => null,
    isJobCancelled: () => false,
    appendStatus: (_jobId: number, line: string) => {
      status = status ? `${status}\n\n${line}` : line;
      return status;
    },
    recordOutboundMessage: () => {},
    complete: (_jobId: number, messageId: number) => {
      completedMessageId = messageId;
    },
  } as unknown as LoylexDatabase;

  const telegram = {
    sendRichMessageDraft: async (
      chatId: number,
      markdown: string,
      options: { draftId: number; threadId?: number | null; canStop?: boolean },
    ) => {
      drafts.push({ chatId, markdown, options });
      return true;
    },
    sendRich: async (
      _chatId: number,
      markdown: string,
      options: { replyTo?: number; threadId?: number | null },
    ) => {
      sent.push({ markdown, options });
      return botMessage(22);
    },
    deleteMessage: async (chatId: number, messageId: number) => {
      deleted.push({ chatId, messageId });
      return true;
    },
  } as unknown as TelegramClient;

  const server = new GatewayServer(config(), database, telegram);
  const event = (
    server as unknown as {
      event: (jobId: number, event: { kind: "commentary"; text: string }) => Promise<void>;
    }
  ).event;
  const complete = (
    server as unknown as {
      complete: (jobId: number, completion: AgentCompletion) => Promise<void>;
    }
  ).complete;

  await event.call(server, 7, { kind: "commentary", text: "Проверяю код" });
  await complete.call(server, 7, { answer: "Ответ", threadId: "thread-1" });

  expect(drafts).toEqual([
    {
      chatId: 42,
      markdown: "<details><summary>Ход работы</summary>\n\n- Проверяю код\n\n</details>",
      options: { draftId: 7, threadId: null, canStop: true },
    },
  ]);
  expect(sent).toEqual([
    {
      markdown: "<details><summary>Ход работы</summary>\n\n- Проверяю код\n\n</details>\n\nОтвет",
      options: { threadId: null },
    },
  ]);
  expect(deleted).toEqual([]);
  expect(completedMessageId as number | null).toBe(22);
});

test("keeps progress when replacing a temporary message with a failure", async () => {
  let edited = "";
  let failed: { jobId: number; error: string; threadId: string | null } | null = null;

  const database = {
    jobAddress: () => ({
      chatId: -10042,
      chatType: "supergroup" as const,
      messageId: 10,
      threadId: null,
    }),
    thinkingMessage: () => 11,
    isJobCancelled: () => false,
    isJobOwned: () => true,
    statusLog: () =>
      "commentary: Проверяю архив\n\ncommand: loylex media file-id /tmp/archive.json",
    jobThreadId: () => "thread-1",
    recordOutboundMessage: () => {},
    fail: (
      jobId: number,
      error: string,
      _workerId: string | undefined,
      threadId: string | null,
    ) => {
      failed = { jobId, error, threadId };
    },
  } as unknown as LoylexDatabase;

  const telegram = {
    editRich: async (_chatId: number, _messageId: number, markdown: string) => {
      edited = markdown;
      return botMessage(11);
    },
  } as unknown as TelegramClient;

  const server = new GatewayServer(config(), database, telegram);
  const fail = (
    server as unknown as {
      fail: (jobId: number, error: string, workerId?: string) => Promise<void>;
    }
  ).fail;

  await fail.call(server, 7, "The socket connection was closed unexpectedly", "worker-1");

  expect(edited).toContain("<summary>Ход работы</summary>");
  expect(edited).toContain("- Проверяю архив");
  expect(edited).toContain("Не получилось завершить задачу.");
  expect(edited).toContain("The socket connection was closed unexpectedly");
  expect(failed as { jobId: number; error: string; threadId: string | null } | null).toEqual({
    jobId: 7,
    error: "The socket connection was closed unexpectedly",
    threadId: "thread-1",
  });
});
