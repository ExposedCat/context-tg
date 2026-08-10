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
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  KEENABLE_API_KEY: "test",
  LLM_TEMPERATURE: "0.2",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test-embedding",
  QDRANT_URL: "https://qdrant.test",
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Deno.env.set(name, value);
}

const [{ requestLlm }, { setLlmDeploymentName }] = await Promise.all([
  import("./llm.ts"),
  import("./llm-deployments.ts"),
]);

type ResponseOutput =
  | {
      id: string;
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
      status: "completed";
    }
  | {
      id: string;
      type: "message";
      role: "assistant";
      status: "completed";
      content: Array<{
        type: "output_text";
        text: string;
        annotations: never[];
      }>;
    };

function createApiResponse(id: string, output: ResponseOutput[]) {
  return {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    model: "test-model",
    output,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 15,
    },
  };
}

Deno.test("legacy Chat Completions history is converted to Responses items", () => {
  const inputItems = parseLlmResponseInputItems(
    JSON.stringify([
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AA==", detail: "high" },
          },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_legacy",
            type: "function",
            function: {
              name: "send_sticker",
              arguments: '{"emoji":"👍"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_legacy",
        content: '{"ok":true}',
      },
      { role: "assistant", content: "Done" },
    ]),
  );

  deepStrictEqual(inputItems, [
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
    {
      type: "function_call",
      call_id: "call_legacy",
      name: "send_sticker",
      arguments: '{"emoji":"👍"}',
    },
    {
      type: "function_call_output",
      call_id: "call_legacy",
      output: '{"ok":true}',
    },
    { type: "message", role: "assistant", content: "Done" },
  ]);
});

Deno.test("requestLlm uses Responses items through a function-call round", async () => {
  setLlmDeploymentName("small", "test-model");
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    strictEqual(new URL(request.url).pathname, "/v1/responses");
    requests.push((await request.json()) as Record<string, unknown>);

    const body =
      requests.length === 1
        ? createApiResponse("resp_tool", [
            {
              id: "fc_tool",
              type: "function_call",
              call_id: "call_tool",
              name: "send_sticker",
              arguments: '{"emoji":"👍"}',
              status: "completed",
            },
          ])
        : createApiResponse("resp_final", [
            {
              id: "msg_final",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Done.", annotations: [] },
              ],
            },
          ]);

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
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
      ["send_sticker"],
    );

    strictEqual(response.response_id, "resp_final");
    strictEqual(response.response, "Done.");
    strictEqual(response.tool_call_count, 1);
    deepStrictEqual(response.stickers, [{ emoji: "👍" }]);
    strictEqual(response.debug.responses[0].usage?.input_tokens, 10);
    strictEqual(response.debug.responses[0].usage?.output_tokens, 5);
    strictEqual(requests.length, 2);

    const firstRequest = requests[0];
    strictEqual(firstRequest.model, "test-model");
    strictEqual(firstRequest.store, false);
    deepStrictEqual(firstRequest.include, ["reasoning.encrypted_content"]);
    ok(typeof firstRequest.instructions === "string");
    deepStrictEqual(firstRequest.tools, [
      {
        type: "function",
        name: "send_sticker",
        description:
          "Send one sticker along with response. Use this for expressive sticker reactions when a sticker is more natural than text. Call at most once per response.",
        parameters: {
          type: "object",
          properties: {
            emoji: {
              type: "string",
              description:
                "The emoji to match in the configured sticker packs, for example 😂, 😭, ❤️, or 👍.",
            },
          },
          required: ["emoji"],
          additionalProperties: false,
        },
        strict: true,
      },
    ]);

    const firstInput = firstRequest.input as Array<Record<string, unknown>>;
    strictEqual(firstInput.length, 1);
    deepStrictEqual(firstInput[0].content, [
      {
        type: "input_text",
        text: [
          '<message sender="User">',
          "  <content>Use a sticker</content>",
          "</message>",
        ].join("\n"),
      },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AA==",
        detail: "original",
      },
    ]);

    const secondInput = requests[1].input as Array<Record<string, unknown>>;
    strictEqual(secondInput.length, 3);
    strictEqual(secondInput[1].type, "function_call");
    strictEqual(secondInput[2].type, "function_call_output");
    strictEqual(secondInput[2].call_id, "call_tool");
    ok(
      String(secondInput[2].output).includes(
        '<tool_response tool="send_sticker">',
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("requestLlm retries empty responses twice before succeeding", async () => {
  setLlmDeploymentName("small", "test-model");
  let requestCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    requestCount += 1;
    const body =
      requestCount <= 2
        ? createApiResponse(`resp_empty_${requestCount}`, [])
        : createApiResponse("resp_final", [
            {
              id: "msg_final",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Recovered.", annotations: [] },
              ],
            },
          ]);

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const response = await requestLlm("Try again", []);

    strictEqual(requestCount, 3);
    strictEqual(response.response_id, "resp_final");
    strictEqual(response.response, "Recovered.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("requestLlm stops after three empty response attempts", async () => {
  setLlmDeploymentName("small", "test-model");
  let requestCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    requestCount += 1;

    return new Response(
      JSON.stringify(createApiResponse(`resp_empty_${requestCount}`, [])),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    await assertRejects(
      () => requestLlm("Keep trying", []),
      Error,
      "LLM request failed after retries",
    );
    strictEqual(requestCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
