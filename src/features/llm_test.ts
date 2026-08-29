import {
  rejects as assertRejects,
  deepStrictEqual,
  ok,
  strictEqual,
} from "node:assert";
import { parseLlmResponseInputItems } from "./llm-chat-responses.ts";

const TEST_ENV = {
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  MEDIA_CACHE_CHAT_ID: "-10042",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  LLM_IMAGE_BASE_URL: "https://images.test/v1",
  LLM_IMAGE_MODEL: "test-image",
  LLM_IMAGE_API_KEY: "test",
  KEENABLE_API_KEY: "test",
  LLM_TEMPERATURE: "0.2",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test-embedding",
  QDRANT_URL: "https://qdrant.test",
  CODEX_APP_SERVER_TOKEN: "test-codex-token",
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Deno.env.set(name, value);
}

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

type ConnectionScenario = (socket: WebSocket, request: Request) => void;

const THREAD_ID = "0198f47b-f27c-7000-8000-000000000001";
const RESUMED_THREAD_ID = "0198f47b-f27c-7000-8000-000000000002";
let connectionScenario: ConnectionScenario | undefined;

const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  (request) => {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("not found", { status: 404 });
    }

    strictEqual(
      request.headers.get("authorization"),
      `Bearer ${TEST_ENV.CODEX_APP_SERVER_TOKEN}`,
    );
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.addEventListener("open", () => {
      if (!connectionScenario) {
        socket.close(1011, "No test scenario configured");
        return;
      }
      connectionScenario(socket, request);
    });
    return response;
  },
);

const serverAddress = server.addr as Deno.NetAddr;
Deno.env.set(
  "CODEX_APP_SERVER_URL",
  `ws://${serverAddress.hostname}:${serverAddress.port}`,
);

function parseMessage(event: MessageEvent): RpcMessage {
  return JSON.parse(String(event.data)) as RpcMessage;
}

function send(socket: WebSocket, message: RpcMessage): void {
  socket.send(JSON.stringify(message));
}

function sendInitialized(socket: WebSocket, id: number | string): void {
  send(socket, {
    id,
    result: {
      userAgent: "codex-test",
      codexHome: "/codex-home",
      platformFamily: "unix",
      platformOs: "linux",
    },
  });
}

function sendThreadResponse(
  socket: WebSocket,
  id: number | string,
  threadId: string,
): void {
  send(socket, {
    id,
    result: {
      thread: { id: threadId },
      model: "test-model",
    },
  });
}

function sendCompletedTurn(
  socket: WebSocket,
  threadId: string,
  turnId: string,
  text: string,
): void {
  send(socket, {
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      turnId,
      tokenUsage: {
        last: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
          totalTokens: 15,
        },
      },
    },
  });
  send(socket, {
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status: "completed",
        error: null,
        items: [
          {
            type: "agentMessage",
            id: `${turnId}-commentary`,
            text: "Working on it.",
            phase: "commentary",
            delivery: null,
          },
          {
            type: "agentMessage",
            id: `${turnId}-final`,
            text,
            phase: "final_answer",
            delivery: null,
          },
        ],
      },
    },
  });
}

Deno.test("Codex-backed LLM requests", async (test) => {
  const [{ LlmRequestError, requestLlm }, { setLlmDeploymentName }] =
    await Promise.all([import("./llm.ts"), import("./llm-deployments.ts")]);
  setLlmDeploymentName("small", "test-model");

  try {
    await test.step("legacy Chat Completions history remains readable for migration", () => {
      const items = parseLlmResponseInputItems(
        JSON.stringify([
          {
            role: "user",
            content: [
              { type: "text", text: "Look at this" },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64,AA==",
                  detail: "high",
                },
              },
            ],
          },
          { role: "assistant", content: "Done" },
        ]),
      );

      deepStrictEqual(items, [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Look at this" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AA==",
              detail: "high",
            },
          ],
        },
        { type: "message", role: "assistant", content: "Done" },
      ]);
    });

    await test.step("starts a durable thread and executes existing tools dynamically", async () => {
      let threadStart: RpcMessage | undefined;
      let turnStart: RpcMessage | undefined;
      let toolResult: RpcMessage | undefined;

      connectionScenario = (socket) => {
        socket.addEventListener("message", (event) => {
          const message = parseMessage(event);
          if (message.method === "initialize" && message.id !== undefined) {
            sendInitialized(socket, message.id);
            return;
          }
          if (message.method === "thread/start" && message.id !== undefined) {
            threadStart = message;
            sendThreadResponse(socket, message.id, THREAD_ID);
            return;
          }
          if (message.method === "turn/start" && message.id !== undefined) {
            turnStart = message;
            send(socket, {
              id: message.id,
              result: {
                turn: {
                  id: "turn-new",
                  status: "inProgress",
                  items: [],
                  error: null,
                },
              },
            });
            send(socket, {
              id: "tool-call-1",
              method: "item/tool/call",
              params: {
                threadId: THREAD_ID,
                turnId: "turn-new",
                callId: "call-1",
                namespace: null,
                tool: "send_sticker",
                arguments: { emoji: "👍" },
              },
            });
            return;
          }
          if (message.id === "tool-call-1" && message.result) {
            toolResult = message;
            sendCompletedTurn(socket, THREAD_ID, "turn-new", "Done.");
          }
        });
      };

      const progress: Array<{ toolCallCount: number; responseId?: string }> =
        [];
      const response = await requestLlm(
        {
          text: "Use a sticker",
          images: [
            {
              image_url: "data:image/png;base64,AA==",
              detail: "original",
            },
          ],
        },
        ["send_sticker", "set_reply_message_id"],
        undefined,
        {
          context: { chatId: 1, messageId: 1 },
          onProgress: (item) => {
            progress.push(item);
          },
        },
      );

      strictEqual(response.response_id, THREAD_ID);
      strictEqual(response.response, "Done.");
      strictEqual(response.tool_call_count, 1);
      deepStrictEqual(response.tools, ["send_sticker"]);
      deepStrictEqual(response.stickers, [{ emoji: "👍" }]);
      strictEqual(response.debug.responses[0].usage?.input_tokens, 10);
      strictEqual(response.debug.responses[0].usage?.cached_tokens, 2);
      strictEqual(threadStart?.params?.ephemeral, false);
      strictEqual(threadStart?.params?.historyMode, "paginated");
      strictEqual(threadStart?.params?.sandbox, "read-only");
      strictEqual(threadStart?.params?.approvalPolicy, "never");
      ok(
        String(threadStart?.params?.baseInstructions).includes("Telegram bot"),
      );
      deepStrictEqual(
        (threadStart?.params?.dynamicTools as Array<{ name: string }>).map(
          (tool) => tool.name,
        ),
        ["send_sticker", "set_reply_message_id"],
      );
      const input = turnStart?.params?.input as Array<Record<string, unknown>>;
      strictEqual(input.length, 2);
      ok(String(input[0].text).includes("Use a sticker"));
      strictEqual(input[1].url, "data:image/png;base64,AA==");
      deepStrictEqual(progress, [
        { toolCallCount: 0, responseId: THREAD_ID },
        { toolCallCount: 1, responseId: THREAD_ID },
      ]);
      const dynamicResult = toolResult?.result as {
        success: boolean;
        contentItems: Array<{ text: string }>;
      };
      strictEqual(dynamicResult.success, true);
      ok(dynamicResult.contentItems[0].text.includes("requested"));
    });

    await test.step("resumes a persisted thread and sends only the new message", async () => {
      let resume: RpcMessage | undefined;
      let turnStart: RpcMessage | undefined;

      connectionScenario = (socket) => {
        socket.addEventListener("message", (event) => {
          const message = parseMessage(event);
          if (message.method === "initialize" && message.id !== undefined) {
            sendInitialized(socket, message.id);
            return;
          }
          if (message.method === "thread/resume" && message.id !== undefined) {
            resume = message;
            sendThreadResponse(socket, message.id, RESUMED_THREAD_ID);
            return;
          }
          if (message.method === "turn/start" && message.id !== undefined) {
            turnStart = message;
            send(socket, {
              id: message.id,
              result: {
                turn: {
                  id: "turn-resumed",
                  status: "inProgress",
                  items: [],
                  error: null,
                },
              },
            });
            sendCompletedTurn(
              socket,
              RESUMED_THREAD_ID,
              "turn-resumed",
              "Welcome back.",
            );
          }
        });
      };

      const response = await requestLlm(
        "Only this message",
        [],
        RESUMED_THREAD_ID,
        { context: { chatId: 1, messageId: 2 } },
      );

      strictEqual(response.response_id, RESUMED_THREAD_ID);
      strictEqual(response.response, "Welcome back.");
      strictEqual(resume?.params?.threadId, RESUMED_THREAD_ID);
      strictEqual(resume?.params?.excludeTurns, true);
      const input = turnStart?.params?.input as Array<Record<string, unknown>>;
      strictEqual(input.length, 1);
      ok(String(input[0].text).includes("Only this message"));
    });

    await test.step("starts a replacement when a persisted rollout is missing", async () => {
      let resumeAttempts = 0;
      let starts = 0;

      connectionScenario = (socket) => {
        socket.addEventListener("message", (event) => {
          const message = parseMessage(event);
          if (message.method === "initialize" && message.id !== undefined) {
            sendInitialized(socket, message.id);
            return;
          }
          if (message.method === "thread/resume" && message.id !== undefined) {
            resumeAttempts += 1;
            send(socket, {
              id: message.id,
              error: {
                code: -32600,
                message: `no rollout found for thread id ${RESUMED_THREAD_ID}`,
              },
            });
            return;
          }
          if (message.method === "thread/start" && message.id !== undefined) {
            starts += 1;
            sendThreadResponse(socket, message.id, THREAD_ID);
            return;
          }
          if (message.method === "turn/start" && message.id !== undefined) {
            send(socket, {
              id: message.id,
              result: {
                turn: {
                  id: "turn-replacement",
                  status: "inProgress",
                  items: [],
                  error: null,
                },
              },
            });
            sendCompletedTurn(
              socket,
              THREAD_ID,
              "turn-replacement",
              "New thread.",
            );
          }
        });
      };

      const response = await requestLlm("Continue", [], RESUMED_THREAD_ID, {
        context: { chatId: 1, messageId: 3 },
      });

      strictEqual(resumeAttempts, 1);
      strictEqual(starts, 1);
      strictEqual(response.response_id, THREAD_ID);
      strictEqual(response.response, "New thread.");
    });

    await test.step("failed turns retain their resumable thread id", async () => {
      connectionScenario = (socket) => {
        socket.addEventListener("message", (event) => {
          const message = parseMessage(event);
          if (message.method === "initialize" && message.id !== undefined) {
            sendInitialized(socket, message.id);
            return;
          }
          if (message.method === "thread/start" && message.id !== undefined) {
            sendThreadResponse(socket, message.id, THREAD_ID);
            return;
          }
          if (message.method === "turn/start" && message.id !== undefined) {
            send(socket, {
              id: message.id,
              result: {
                turn: {
                  id: "turn-failed",
                  status: "inProgress",
                  items: [],
                  error: null,
                },
              },
            });
            send(socket, {
              method: "turn/completed",
              params: {
                threadId: THREAD_ID,
                turn: {
                  id: "turn-failed",
                  status: "failed",
                  items: [],
                  error: { message: "content filter" },
                },
              },
            });
          }
        });
      };

      const warnings: string[] = [];
      await assertRejects(
        () =>
          requestLlm("Blocked", [], undefined, {
            context: { chatId: 1, messageId: 4 },
            onWarning: (warning) => {
              warnings.push(warning);
            },
          }),
        (error) => {
          ok(error instanceof LlmRequestError);
          strictEqual(error.kind, "content_filter");
          strictEqual(error.lastResponseId, THREAD_ID);
          return true;
        },
      );
      deepStrictEqual(warnings, ["content filter"]);
    });
  } finally {
    connectionScenario = undefined;
    await server.shutdown();
  }
});
