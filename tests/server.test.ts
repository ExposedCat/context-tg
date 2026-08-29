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

test("sends a self-contained final message and deletes group progress", async () => {
  const sent: string[] = [];
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
    appendStatus: () => "status: Готово",
    complete: (jobId: number, messageId: number, threadId: string) => {
      completed = { jobId, messageId, threadId };
    },
  } as unknown as LoylexDatabase;

  const telegram = {
    sendRich: async (_chatId: number, markdown: string) => {
      calls.push("send");
      sent.push(markdown);
      return botMessage(12);
    },
    deleteMessage: async (chatId: number, messageId: number) => {
      calls.push("delete");
      deleted.push({ chatId, messageId });
      return true;
    },
  } as unknown as TelegramClient;

  const config: GatewayConfig = {
    botToken: "unused",
    bridgeToken: "unused",
    databasePath: ":memory:",
    listenHost: "127.0.0.1",
    listenPort: 8787,
    pollTimeoutSeconds: 1,
    contextMessages: 10,
  };
  const server = new GatewayServer(config, database, telegram);
  const complete = (
    server as unknown as {
      complete: (jobId: number, completion: AgentCompletion) => Promise<void>;
    }
  ).complete;

  await complete.call(server, 7, { answer: "Ответ", threadId: "thread-1" });

  expect(calls).toEqual(["send", "delete"]);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Ответ");
  expect(sent[0]).toContain("Ход работы");
  expect(deleted).toEqual([{ chatId: -10042, messageId: 11 }]);
  expect(completed as { jobId: number; messageId: number; threadId: string } | null).toEqual({
    jobId: 7,
    messageId: 12,
    threadId: "thread-1",
  });
});
