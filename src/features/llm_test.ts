import {
  rejects as assertRejects,
  deepStrictEqual,
  ok,
  strictEqual,
} from "node:assert";
import { type Api, InputFile } from "grammy";
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
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Deno.env.set(name, value);
}

const [
  { LlmRequestError, requestLlm },
  { setLlmDeploymentName },
  { initDatabase },
] = await Promise.all([
  import("./llm.ts"),
  import("./llm-deployments.ts"),
  import("./database.ts"),
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
            {
              id: "fc_reply",
              type: "function_call",
              call_id: "call_reply",
              name: "set_reply_message_id",
              arguments: '{"message_id":42}',
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
      ["send_sticker", "set_reply_message_id"],
      undefined,
      { context: { chatId: 1, messageId: 1 } },
    );

    strictEqual(response.response_id, "resp_final");
    strictEqual(response.response, "Done.");
    strictEqual(response.tool_call_count, 2);
    strictEqual(response.replyMessageId, 42);
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
      {
        type: "function",
        name: "set_reply_message_id",
        description:
          "Set the Telegram message that the final response replies to. This is optional: by default the response replies to the latest user message. Call this only before the final response when you need to change its reply target. Only use a message ID explicitly provided in the conversation context or a tool result; never guess or invent one. Pass null to explicitly send without replying to any message.",
        parameters: {
          type: "object",
          properties: {
            message_id: {
              type: ["integer", "null"],
              description:
                "The explicitly known Telegram message id to reply to, or null to send without replying. Never guess or invent an id. Default: last user message.",
              minimum: 1,
            },
          },
          required: ["message_id"],
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
    strictEqual(secondInput.length, 5);
    strictEqual(secondInput[1].type, "function_call");
    strictEqual(secondInput[3].type, "function_call_output");
    strictEqual(secondInput[3].call_id, "call_tool");
    ok(
      String(secondInput[3].output).includes(
        '<tool_response tool="send_sticker">',
      ),
    );
    strictEqual(secondInput[4].type, "function_call_output");
    strictEqual(secondInput[4].call_id, "call_reply");
    ok(
      String(secondInput[4].output).includes(
        '<tool_response tool="set_reply_message_id">',
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("read_image returns an image in the function-call output", async () => {
  setLlmDeploymentName("small", "test-model");
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push((await request.json()) as Record<string, unknown>);

    const body =
      requests.length === 1
        ? createApiResponse("resp_read_image", [
            {
              id: "fc_read_image",
              type: "function_call",
              call_id: "call_read_image",
              name: "read_image",
              arguments: '{"url":"https://images.example.com/cat.jpg"}',
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
                {
                  type: "output_text",
                  text: "It is an orange cat.",
                  annotations: [],
                },
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
      "Inspect the image",
      ["read_image"],
      undefined,
      { context: { chatId: 1, messageId: 1 } },
    );

    strictEqual(response.response, "It is an orange cat.");
    strictEqual(requests.length, 2);

    const secondInput = requests[1].input as Array<Record<string, unknown>>;
    const functionOutput = secondInput[2];
    strictEqual(functionOutput.type, "function_call_output");
    deepStrictEqual(functionOutput.output, [
      {
        type: "input_text",
        text: [
          '<tool_response tool="read_image">',
          '{"image_url":"https://images.example.com/cat.jpg","loaded":true}',
          "</tool_response>",
        ].join("\n"),
      },
      {
        type: "input_image",
        image_url: "https://images.example.com/cat.jpg",
        detail: "auto",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("read_image download failure is reported to the agent as unavailable", async () => {
  setLlmDeploymentName("small", "test-model");
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push((await request.json()) as Record<string, unknown>);

    if (requests.length === 1) {
      return new Response(
        JSON.stringify(
          createApiResponse("resp_read_image", [
            {
              id: "fc_read_image",
              type: "function_call",
              call_id: "call_read_image",
              name: "read_image",
              arguments: '{"url":"https://images.example.com/blocked.jpg"}',
              status: "completed",
            },
          ]),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (requests.length === 2) {
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_value",
            type: "invalid_request_error",
            message: "Error while downloading file. Upstream status code: 403.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify(
        createApiResponse("resp_final", [
          {
            id: "msg_final",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "That image is unavailable, so I could not inspect it.",
                annotations: [],
              },
            ],
          },
        ]),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const response = await requestLlm(
      "Inspect the image",
      ["read_image"],
      undefined,
      { context: { chatId: 1, messageId: 1 } },
    );

    strictEqual(
      response.response,
      "That image is unavailable, so I could not inspect it.",
    );
    strictEqual(requests.length, 3);

    const failedInput = requests[1].input as Array<Record<string, unknown>>;
    const failedOutput = failedInput[2];
    strictEqual(Array.isArray(failedOutput.output), true);

    const recoveredInput = requests[2].input as Array<Record<string, unknown>>;
    const recoveredOutput = recoveredInput[2];
    strictEqual(recoveredOutput.type, "function_call_output");
    strictEqual(
      recoveredOutput.output,
      [
        '<tool_response tool="read_image">',
        '{"error":"Image unavailable","details":"The vision service could not download this image. Try another image result or tell the user it is unavailable."}',
        "</tool_response>",
      ].join("\n"),
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
    const response = await requestLlm("Try again", [], undefined, {
      context: { chatId: 1, messageId: 1 },
    });

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
      () =>
        requestLlm("Keep trying", [], undefined, {
          context: { chatId: 1, messageId: 1 },
        }),
      Error,
      "LLM request failed after retries",
    );
    strictEqual(requestCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("failed tool follow-up preserves the complete context for the next turn", async () => {
  setLlmDeploymentName("small", "test-model");
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  let resumeFromCheckpoint = false;

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push((await request.json()) as Record<string, unknown>);

    let body: Record<string, unknown>;

    if (requests.length === 1) {
      body = createApiResponse("resp_context_before_error", [
        {
          id: "msg_context_before_error",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "I will remember the pineapple.",
              annotations: [],
            },
          ],
        },
      ]);
    } else if (requests.length === 2) {
      body = createApiResponse("resp_tool_before_error", [
        {
          id: "fc_before_error",
          type: "function_call",
          call_id: "call_before_error",
          name: "send_sticker",
          arguments: '{"emoji":"👍"}',
          status: "completed",
        },
      ]);
    } else if (!resumeFromCheckpoint) {
      body = {
        ...createApiResponse("resp_failed_tool_follow_up", []),
        status: "failed",
        error: {
          code: "server_error",
          message: "Tool follow-up failed",
        },
      };
    } else {
      body = createApiResponse("resp_after_error", [
        {
          id: "msg_after_error",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "The earlier context is still available.",
              annotations: [],
            },
          ],
        },
      ]);
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const firstResponse = await requestLlm(
      "Remember that the keyword is pineapple",
      [],
      undefined,
      { context: { chatId: 1, messageId: 1 } },
    );
    let failure: unknown;

    try {
      await requestLlm(
        "Acknowledge it with a sticker",
        ["send_sticker"],
        firstResponse.response_id,
        { context: { chatId: 1, messageId: 2 } },
      );
    } catch (error) {
      failure = error;
    }

    ok(failure instanceof LlmRequestError);
    ok(failure.lastResponseId?.startsWith("resp-local-"));

    resumeFromCheckpoint = true;
    const resumedResponse = await requestLlm(
      "What was the keyword?",
      [],
      failure.lastResponseId,
      { context: { chatId: 1, messageId: 3 } },
    );

    strictEqual(
      resumedResponse.response,
      "The earlier context is still available.",
    );

    const resumedInput = requests.at(-1)?.input as Array<
      Record<string, unknown>
    >;
    strictEqual(resumedInput.length, 6);
    ok(JSON.stringify(resumedInput).includes("pineapple"));
    ok(JSON.stringify(resumedInput).includes("Acknowledge it with a sticker"));
    const toolOutput = resumedInput.find(
      (item) => item.type === "function_call_output",
    );
    strictEqual(toolOutput?.call_id, "call_before_error");
    ok(String(toolOutput?.output).includes('tool="send_sticker"'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("generate_image caches media and returns reusable rich Markdown", async () => {
  setLlmDeploymentName("small", "test-model");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const llmRequests: Array<Record<string, unknown>> = [];
  let cachedPhotoInput: unknown;
  const api = {
    sendPhoto: async (chatId: number, input: unknown) => {
      strictEqual(chatId, -10042);
      cachedPhotoInput = input;
      return {
        photo: [
          { file_id: "generated-small", width: 90, height: 90 },
          { file_id: "generated-large", width: 1024, height: 1024 },
        ],
      };
    },
  } as unknown as Api;

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);

    if (request.url === "https://images.test/v1/images/generations") {
      return new Response(
        JSON.stringify({
          data: [
            {
              b64_json: "AA==",
              revised_prompt: "A tiny generated test image",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const payload = (await request.json()) as Record<string, unknown>;
    llmRequests.push(payload);

    if (llmRequests.length === 1) {
      return new Response(
        JSON.stringify(
          createApiResponse("resp_generate_image", [
            {
              id: "fc_generate_image",
              type: "function_call",
              call_id: "call_generate_image",
              name: "generate_image",
              arguments: '{"prompt":"Draw a tiny test image"}',
              status: "completed",
            },
          ]),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const imageId = JSON.stringify(payload).match(/image_[a-f0-9]{32}/)?.[0];
    ok(imageId);

    return new Response(
      JSON.stringify(
        createApiResponse("resp_generated_image_final", [
          {
            id: "msg_generated_image_final",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: `Here it is.\n\n![](tg://photo?id=${imageId})`,
                annotations: [],
              },
            ],
          },
        ]),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const response = await requestLlm(
      "Generate an image",
      ["generate_image"],
      undefined,
      {
        api,
        database,
        context: { chatId: 1, messageId: 1 },
      },
    );

    strictEqual(llmRequests.length, 2);
    ok(cachedPhotoInput instanceof InputFile);
    strictEqual(response.generatedImageIds.length, 1);
    strictEqual(
      response.response,
      `Here it is.\n\n![](tg://photo?id=${response.generatedImageIds[0]})`,
    );
    const storedImages = await database
      .selectFrom("images")
      .selectAll()
      .execute();
    strictEqual(storedImages.length, 1);
    strictEqual(storedImages[0].id, response.generatedImageIds[0]);
    strictEqual(storedImages[0].file_id, "generated-large");
    strictEqual(storedImages[0].media_type, "photo");
    ok(!Number.isNaN(Date.parse(storedImages[0].created_at)));
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});
