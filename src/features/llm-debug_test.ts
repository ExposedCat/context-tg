import { deepStrictEqual, strictEqual } from "node:assert";
import OpenAI from "@openai/openai";
import {
  createLlmInputDump,
  createLlmInputDumpFetch,
  encodeLlmInputDump,
  type LlmInputDump,
} from "./llm-debug.ts";

Deno.test("LLM input dumps intercept every exact OpenAI transport body", async () => {
  const dump: LlmInputDump = [];
  const forwardedBodies: string[] = [];
  let attempt = 0;
  const client = new OpenAI({
    apiKey: "test",
    baseURL: "https://llm.example/v1",
    maxRetries: 1,
    fetch: createLlmInputDumpFetch(dump, async (input, init) => {
      const request = new Request(input, init);
      forwardedBodies.push(await request.text());
      attempt += 1;

      if (attempt === 1) {
        return Response.json(
          { error: { message: "retry once" } },
          { status: 500, headers: { "retry-after": "0" } },
        );
      }

      return Response.json({
        id: "response",
        object: "chat.completion",
        created: 0,
        model: "model-a",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "done" },
          },
        ],
      });
    }),
  });
  const request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: "model-a",
    messages: [
      {
        role: "system" as const,
        content: "<role>Laylo</role>",
      },
    ],
  };
  const expectedBody = JSON.stringify(request);

  await client.chat.completions.create(request);

  deepStrictEqual(dump, [expectedBody, expectedBody]);
  deepStrictEqual(forwardedBodies, [expectedBody, expectedBody]);
  strictEqual(
    new TextDecoder().decode(encodeLlmInputDump(dump)),
    `${expectedBody}\n${expectedBody}`,
  );
});

Deno.test("LLM input dump interceptors are isolated", async () => {
  const firstDump = createLlmInputDump(true);
  const secondDump = createLlmInputDump(true);

  if (!firstDump || !secondDump) {
    throw new Error("Enabled LLM input dumps must be initialized");
  }

  const forwardedBodies: string[] = [];
  const baseFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    forwardedBodies.push(await request.text());
    return new Response(null, { status: 204 });
  };
  const firstFetch = createLlmInputDumpFetch(firstDump, baseFetch);
  createLlmInputDumpFetch(secondDump, baseFetch);

  await firstFetch(
    new Request("https://llm.example/v1/chat/completions", {
      method: "POST",
      body: '{"messages":[]}',
    }),
  );

  deepStrictEqual(firstDump, ['{"messages":[]}']);
  deepStrictEqual(forwardedBodies, ['{"messages":[]}']);
  strictEqual(secondDump.length, 0);
  strictEqual(createLlmInputDump(false), undefined);
});
