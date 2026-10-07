import {
  rejects as assertRejects,
  deepStrictEqual,
  ok,
  strictEqual,
} from "node:assert";
import { type Api, InputFile } from "grammy";
import { parseLlmResponseInputItems } from "./llm-chat-responses.ts";
import type { LlmCallTelemetryPayload } from "./telemetry.ts";

const TEST_ENV = {
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  MEDIA_CACHE_CHAT_ID: "-10042",
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

const [
  { LlmRequestError, requestLlm, requestThreadName },
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

Deno.test("thread naming uses the responding model and exact prompt, with three-word fallbacks", async () => {
  const originalFetch = globalThis.fetch;
  const model = setLlmDeploymentName("openminded", "thread-test-model");
  const message = "  Plan\nmy next   trip abroad ";
  const prompt = `According to the following user request:
<message>
${message}
</message>
Respond with a name for this thread. Don't use formatting, don't add anything else, your entire response will be used to name the thread.`;
  const cases = [
    { text: "  Travel plans \n", expected: "Travel plans" },
    { text: "**Travel plans**", expected: "**Travel plans**" },
    { text: "", expected: "Plan my next" },
    { text: " \n ", expected: "Plan my next" },
    { text: "ignored", expected: "Plan my next", failure: true },
  ];

  try {
    for (const test of cases) {
      let calls = 0;
      globalThis.fetch = (async (_input, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        strictEqual(body.model, "thread-test-model");
        strictEqual(body.instructions, "");
        strictEqual(body.tools, undefined);
        strictEqual(body.input.length, 1);
        strictEqual(body.input[0].content, prompt);
        if (test.failure) {
          return new Response(
            JSON.stringify({
              error: { message: "Failed", type: "invalid_request_error" },
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify(
            createApiResponse("resp_title", [
              {
                id: "msg_title",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: test.text, annotations: [] },
                ],
              },
            ]),
          ),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      strictEqual(await requestThreadName(message, model), test.expected);
      strictEqual(calls, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("openminded", "");
  }
});

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
              name: "set_reply_message_id",
              arguments: '{"message_id":42}',
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
      name: "set_reply_message_id",
      arguments: '{"message_id":42}',
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
  const telemetryEvents: LlmCallTelemetryPayload[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    strictEqual(new URL(request.url).pathname, "/v1/responses");
    requests.push((await request.json()) as Record<string, unknown>);

    const body =
      requests.length === 1
        ? createApiResponse("resp_tool", [
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
        text: "Reply to message 42",
        images: [
          {
            image_url: "data:image/png;base64,AA==",
            detail: "original",
          },
        ],
      },
      ["set_reply_message_id"],
      undefined,
      {
        context: { chatId: 1, messageId: 1 },
        telemetry: {
          chatType: "private",
          mode: "normal",
          emit: (payload) => telemetryEvents.push(payload),
        },
      },
    );

    strictEqual(response.response_id, "resp_final");
    strictEqual(response.response, "Done.");
    strictEqual(response.tool_call_count, 1);
    strictEqual(response.replyMessageId, 42);
    strictEqual(response.debug.responses[0].usage?.input_tokens, 10);
    strictEqual(response.debug.responses[0].usage?.output_tokens, 5);
    deepStrictEqual(telemetryEvents, [
      {
        chat_type: "private",
        input_tokens: 20,
        cached_tokens: 4,
        output_tokens: 10,
        tools: ["set_reply_message_id"],
        mode: "normal",
        status: "success",
      },
    ]);
    strictEqual(requests.length, 2);

    const firstRequest = requests[0];
    strictEqual(firstRequest.model, "test-model");
    strictEqual(firstRequest.store, false);
    deepStrictEqual(firstRequest.include, ["reasoning.encrypted_content"]);
    ok(typeof firstRequest.instructions === "string");
    deepStrictEqual(firstRequest.tools, [
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
    strictEqual(firstInput.length, 2);
    deepStrictEqual(firstInput[1], {
      type: "message",
      role: "developer",
      content: '<new-message id="1" />',
    });
    deepStrictEqual(firstInput[0].content, [
      {
        type: "input_text",
        text: [
          "<events>",
          '<message sender="User">',
          "  <content>Reply to message 42</content>",
          "</message>",
          "</events>",
        ].join("\n"),
      },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AA==",
        detail: "original",
      },
    ]);

    const secondInput = requests[1].input as Array<Record<string, unknown>>;
    strictEqual(secondInput.length, 4);
    deepStrictEqual(secondInput.slice(0, firstInput.length), firstInput);
    strictEqual(secondInput[2].type, "function_call");
    strictEqual(secondInput[3].type, "function_call_output");
    strictEqual(secondInput[3].call_id, "call_reply");
    ok(
      String(secondInput[3].output).includes(
        '<tool_response tool="set_reply_message_id">',
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("tool rounds continue past four and credit exhaustion is a normal tool failure", async () => {
  setLlmDeploymentName("small", "test-model");
  const originalFetch = globalThis.fetch;
  try {
    for (const exhaustCredits of [false, true]) {
      const requests: Array<Record<string, unknown>> = [];
      const telemetryEvents: LlmCallTelemetryPayload[] = [];
      let charges = 0;
      globalThis.fetch = (async (input, init) => {
        const request = new Request(input, init);
        strictEqual(new URL(request.url).pathname, "/v1/responses");
        requests.push(await request.json());
        const round = requests.length;
        return Response.json(
          createApiResponse(
            `resp_round_${round}`,
            round <= 6
              ? [
                  {
                    id: `fc_round_${round}`,
                    type: "function_call",
                    call_id: `call_round_${round}`,
                    name: "set_reply_message_id",
                    arguments: JSON.stringify({ message_id: round }),
                    status: "completed",
                  },
                ]
              : [
                  {
                    id: "msg_round_final",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                      { type: "output_text", text: "Done.", annotations: [] },
                    ],
                  },
                ],
          ),
        );
      }) as typeof fetch;

      const response = await requestLlm(
        "Use the tools",
        ["set_reply_message_id"],
        undefined,
        {
          context: { chatId: 1, messageId: 1 },
          chargeCredits: async (kind, tool) => {
            strictEqual(kind, "tool");
            strictEqual(tool, "set_reply_message_id");
            charges += 1;
            if (exhaustCredits && charges === 6) {
              throw new Error("Not enough credits: 5/5 used today.");
            }
          },
          telemetry: {
            chatType: "private",
            mode: "normal",
            emit: (payload) => telemetryEvents.push(payload),
          },
        },
      );

      strictEqual(requests.length, 7);
      strictEqual(charges, 6);
      strictEqual(response.response, "Done.");
      strictEqual(response.tool_call_count, 6);
      strictEqual(response.replyMessageId, exhaustCredits ? 5 : 6);
      deepStrictEqual(
        response.errors,
        exhaustCredits
          ? [
              {
                tool: "set_reply_message_id",
                details: "Not enough credits: 5/5 used today.",
              },
            ]
          : [],
      );
      strictEqual(
        telemetryEvents[0].status,
        exhaustCredits ? "with_errors" : "success",
      );
      for (const request of requests) {
        deepStrictEqual(request.tools, requests[0].tools);
      }
      const outputs = (
        requests[6].input as Array<Record<string, unknown>>
      ).filter((item) => item.type === "function_call_output");
      strictEqual(outputs.length, 6);
      for (const [index, output] of outputs.entries()) {
        strictEqual(output.call_id, `call_round_${index + 1}`);
        if (exhaustCredits && index === 5) {
          ok(String(output.output).includes('"error":"Tool call failed"'));
          ok(
            String(output.output).includes(
              "Not enough credits: 5/5 used today.",
            ),
          );
        } else {
          ok(String(output.output).includes(`"reply_message_id":${index + 1}`));
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("requestLlm telemetry repeats tool names and reports tool errors", async () => {
  setLlmDeploymentName("small", "test-model");
  const telemetryEvents: LlmCallTelemetryPayload[] = [];
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount += 1;
    const body =
      requestCount === 1
        ? createApiResponse("resp_tools", [
            {
              id: "fc_reply_valid",
              type: "function_call",
              call_id: "call_reply_valid",
              name: "set_reply_message_id",
              arguments: '{"message_id":42}',
              status: "completed",
            },
            {
              id: "fc_reply_invalid",
              type: "function_call",
              call_id: "call_reply_invalid",
              name: "set_reply_message_id",
              arguments: '{"message_id":0}',
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
    await requestLlm("Set a reply", ["set_reply_message_id"], undefined, {
      context: { chatId: 1, messageId: 1 },
      telemetry: {
        chatType: "group",
        mode: "guest",
        emit: (payload) => telemetryEvents.push(payload),
      },
    });

    deepStrictEqual(telemetryEvents, [
      {
        chat_type: "group",
        input_tokens: 20,
        cached_tokens: 4,
        output_tokens: 10,
        tools: ["set_reply_message_id", "set_reply_message_id"],
        mode: "guest",
        status: "with_errors",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("requestLlm telemetry defaults missing cached usage to zero", async (t) => {
  setLlmDeploymentName("small", "test-model");
  const response = createApiResponse("resp_no_cached_usage", [
    {
      id: "msg_final",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done.", annotations: [] }],
    },
  ]);

  for (const usage of [
    { input_tokens: 10, output_tokens: 5 },
    { input_tokens: 10, output_tokens: 5, input_tokens_details: {} },
    { input_tokens: 10, output_tokens: 5, input_tokens_details: null },
    undefined,
  ]) {
    await t.step(`usage: ${JSON.stringify(usage)}`, async () => {
      const telemetryEvents: LlmCallTelemetryPayload[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ ...response, usage }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;

      try {
        await requestLlm("Hello", [], undefined, {
          context: { chatId: 1, messageId: 1 },
          telemetry: {
            chatType: "private",
            mode: "normal",
            emit: (payload) => telemetryEvents.push(payload),
          },
        });

        deepStrictEqual(telemetryEvents, [
          {
            chat_type: "private",
            input_tokens: usage?.input_tokens ?? 0,
            cached_tokens: 0,
            output_tokens: usage?.output_tokens ?? 0,
            tools: [],
            mode: "normal",
            status: "success",
          },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
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

    const tools = requests[0].tools as Array<Record<string, unknown>>;
    const readImageTool = tools.find((tool) => tool.name === "read_image");
    ok(readImageTool);
    const parameters = readImageTool.parameters as Record<string, unknown>;
    strictEqual(parameters.type, "object");
    for (const keyword of ["oneOf", "anyOf", "allOf", "enum", "const", "not"]) {
      strictEqual(Object.hasOwn(parameters, keyword), false);
    }

    const secondInput = requests[1].input as Array<Record<string, unknown>>;
    const functionOutput = secondInput.find(
      (item) => item.type === "function_call_output",
    );
    ok(functionOutput);
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
    const failedOutput = failedInput.find(
      (item) => item.type === "function_call_output",
    );
    ok(failedOutput);
    strictEqual(Array.isArray(failedOutput.output), true);

    const recoveredInput = requests[2].input as Array<Record<string, unknown>>;
    const recoveredOutput = recoveredInput.find(
      (item) => item.type === "function_call_output",
    );
    ok(recoveredOutput);
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

Deno.test("corrupted request images are removed before retrying", async () => {
  setLlmDeploymentName("small", "test-model");
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push((await request.json()) as Record<string, unknown>);

    if (requests.length <= 2) {
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_value",
            type: "invalid_request_error",
            message:
              "The image data you provided does not represent a valid image. Please check your input and try again with one of the supported image formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify(
        createApiResponse("resp_without_corrupted_image", [
          {
            id: "msg_without_corrupted_image",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "I continued without the corrupted image.",
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
      {
        text: "Inspect these images",
        images: [
          { image_url: "data:image/png;base64,VALID" },
          { image_url: "data:image/png;base64,CORRUPTED" },
        ],
      },
      [],
      undefined,
      { context: { chatId: 1, messageId: 1 } },
    );

    strictEqual(response.response, "I continued without the corrupted image.");
    strictEqual(requests.length, 3);
    ok(JSON.stringify(requests[0]).includes("CORRUPTED"));
    ok(!JSON.stringify(requests[1]).includes("CORRUPTED"));
    ok(JSON.stringify(requests[1]).includes("VALID"));
    ok(
      JSON.stringify(requests[1]).includes(
        "1 attached images were removed due to corrupted contents.",
      ),
    );
    ok(!JSON.stringify(requests[2]).includes("CORRUPTED"));
    ok(!JSON.stringify(requests[2]).includes("VALID"));
    ok(
      JSON.stringify(requests[2]).includes(
        "2 attached images were removed due to corrupted contents.",
      ),
    );
    ok(
      !JSON.stringify(requests[2]).includes(
        "1 attached images were removed due to corrupted contents.",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("corrupted images are removed from conversation history", async () => {
  setLlmDeploymentName("small", "test-model");
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push((await request.json()) as Record<string, unknown>);

    if (requests.length === 2) {
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_value",
            type: "invalid_request_error",
            message:
              "The image data you provided does not represent a valid image.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const id = requests.length === 1 ? "resp_with_image" : "resp_recovered";
    return new Response(
      JSON.stringify(
        createApiResponse(id, [
          {
            id: `msg_${id}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: requests.length === 1 ? "Image received." : "Recovered.",
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
    const firstResponse = await requestLlm(
      {
        text: "Remember this image",
        images: [{ image_url: "data:image/png;base64,LATER_CORRUPTED" }],
      },
      [],
      undefined,
      { context: { chatId: 1, messageId: 1 } },
    );
    const recoveredResponse = await requestLlm(
      "Continue the conversation",
      [],
      firstResponse.response_id,
      { context: { chatId: 1, messageId: 2 } },
    );

    strictEqual(recoveredResponse.response, "Recovered.");
    strictEqual(requests.length, 3);
    ok(JSON.stringify(requests[1]).includes("LATER_CORRUPTED"));
    ok(!JSON.stringify(requests[2]).includes("LATER_CORRUPTED"));
    ok(
      JSON.stringify(requests[2]).includes(
        "1 attached images were removed due to corrupted contents.",
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
  const telemetryEvents: LlmCallTelemetryPayload[] = [];
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
          telemetry: {
            chatType: "private",
            mode: "normal",
            emit: (payload) => telemetryEvents.push(payload),
          },
        }),
      Error,
      "LLM request failed after retries",
    );
    strictEqual(requestCount, 3);
    deepStrictEqual(telemetryEvents, [
      {
        chat_type: "private",
        input_tokens: 30,
        cached_tokens: 6,
        output_tokens: 15,
        tools: [],
        mode: "normal",
        status: "failed",
      },
    ]);
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
          name: "set_reply_message_id",
          arguments: '{"message_id":42}',
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
        "Reply to message 42",
        ["set_reply_message_id"],
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
    strictEqual(resumedInput.length, 9);
    ok(JSON.stringify(resumedInput).includes("pineapple"));
    ok(JSON.stringify(resumedInput).includes("Reply to message 42"));
    const toolOutput = resumedInput.find(
      (item) => item.type === "function_call_output",
    );
    strictEqual(toolOutput?.call_id, "call_before_error");
    ok(String(toolOutput?.output).includes('tool="set_reply_message_id"'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("generate_image caches media and returns reusable rich Markdown", async () => {
  setLlmDeploymentName("small", "test-model");
  const creditCharges: string[] = [];
  const database = await initDatabase()();
  setLlmDeploymentName("image_small", "test-image");
  const originalFetch = globalThis.fetch;
  const llmRequests: Array<Record<string, unknown>> = [];
  const telemetryEvents: LlmCallTelemetryPayload[] = [];
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
    if (request.url.startsWith("data:"))
      return await originalFetch(input, init);

    if (request.url === "https://llm.test/v1/images/generations") {
      return new Response(
        JSON.stringify({
          data: [
            {
              b64_json: "AA==",
              revised_prompt: "A tiny generated test image",
            },
          ],
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens: 200,
            total_tokens: 300,
          },
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
        chargeCredits: async (kind) => {
          creditCharges.push(kind);
        },
        api,
        database,
        context: { chatId: 1, messageId: 1 },
        telemetry: {
          chatType: "group",
          mode: "normal",
          emit: (payload) => telemetryEvents.push(payload),
        },
      },
    );

    deepStrictEqual(creditCharges, ["tool", "image_attempt"]);
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
    deepStrictEqual(telemetryEvents, [
      {
        chat_type: "group",
        input_tokens: 120,
        cached_tokens: 44,
        output_tokens: 210,
        tools: ["generate_image"],
        mode: "normal",
        status: "success",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

Deno.test("memory snapshots and memo events preserve replay prefixes across tools and restarts", async () => {
  setLlmDeploymentName("small", "test-model");
  const database = await initDatabase()();
  const { saveMemo, forgetMemo } = await import("./memos.ts");
  const {
    getLlmResponseMemory,
    getLlmResponseInputItems,
    saveLlmResponseInputItems,
  } = await import("./llm-chat-responses.ts");
  const old = await saveMemo(
    database,
    500,
    "normal",
    "chat",
    7,
    "Opening memory",
  );
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    instructions: string;
    input: Array<Record<string, unknown>>;
  }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push(await new Request(input, init).json());
    const index = requests.length;
    const output: ResponseOutput[] =
      index === 1
        ? [
            {
              id: "fc_memory",
              type: "function_call",
              call_id: "call_memory",
              name: "remember",
              arguments: '{"memo":"Conversation memory","bucket":"chat"}',
              status: "completed",
            },
          ]
        : [
            {
              id: `msg_memory_${index}`,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Done", annotations: [] }],
            },
          ];
    return new Response(
      JSON.stringify(createApiResponse(`resp_memory_${index}`, output)),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    const options = {
      database,
      context: { chatId: 500, messageId: 10, userId: 7, userName: "Alice" },
    };
    const first = await requestLlm(
      "Remember something",
      ["remember"],
      undefined,
      options,
    );
    strictEqual(requests.length, 2);
    ok(String(requests[0].input[0].content).startsWith("<memory>"));
    ok(String(requests[0].input[0].content).includes("Opening memory"));
    ok(String(requests[0].input[1].content).startsWith("<events>"));
    ok(!requests[0].instructions.includes("<memory>" + "\n"));
    ok(!requests[0].instructions.includes("<metadata>"));
    ok(!requests[0].instructions.includes("https://t.me/c/500/"));
    deepStrictEqual(
      requests[1].input.slice(0, requests[0].input.length),
      requests[0].input,
    );
    const delta = String(requests[1].input.at(-1)?.content);
    ok(delta.includes("<events>"));
    ok(delta.includes('action="upsert"'));
    ok(delta.includes("Conversation memory"));
    ok(!delta.includes("Opening memory"));

    // Copy the persisted checkpoint to an uncached ID to exercise restart loading.
    ok(first.response_id);
    const savedInput = await getLlmResponseInputItems(
      database,
      first.response_id,
    );
    const savedMemory = await getLlmResponseMemory(database, first.response_id);
    ok(savedInput);
    ok(savedMemory);
    await saveLlmResponseInputItems(database, {
      responseId: "resp_memory_restart",
      inputItems: savedInput,
      memoryState: savedMemory,
    });
    await forgetMemo(database, 500, "normal", 7, old.id);
    const second = await requestLlm(
      "Continue",
      ["remember"],
      "resp_memory_restart",
      options,
    );
    deepStrictEqual(
      requests[2].input.slice(0, requests[1].input.length),
      requests[1].input,
    );
    const removal = requests[2].input.find((item) =>
      String(item.content).includes('action="remove"'),
    );
    ok(String(removal?.content).includes(`id="${old.id}"`));
    strictEqual(requests[2].instructions, requests[0].instructions);
    await requestLlm(
      "Continue again",
      ["remember"],
      second.response_id,
      options,
    );
    deepStrictEqual(
      requests[3].input.slice(0, requests[2].input.length),
      requests[2].input,
    );
    // No repeated memory snapshot or delta on an unchanged continuation.
    strictEqual(requests[3].input.length, requests[2].input.length + 3);
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

Deno.test("memo events deactivate another speaker's memories and restore their scope on return", async () => {
  const { formatMemoryUpdate } = await import("./llm-memory.ts");
  const { saveMemo } = await import("./memos.ts");
  const database = await initDatabase()();
  try {
    const chatMemo = await saveMemo(
      database,
      501,
      "normal",
      "chat",
      7,
      "Shared fact",
    );
    const userMemo = await saveMemo(
      database,
      501,
      "normal",
      "user",
      7,
      'Alice prefers "tea"',
    );
    const alice = {
      agentId: "normal" as const,
      userId: 7,
      userName: "Alice",
      memos: [chatMemo, userMemo],
    };
    const bob = {
      agentId: "normal" as const,
      userId: 8,
      userName: "Bob",
      memos: [chatMemo],
    };
    strictEqual(formatMemoryUpdate(alice, structuredClone(alice)), undefined);
    const toBob = formatMemoryUpdate(alice, bob);
    ok(toBob?.includes(`<memo id="${userMemo.id}" action="remove" />`));
    ok(toBob?.includes('user_id="8"'));
    ok(!toBob?.includes("Shared fact"));
    const toAlice = formatMemoryUpdate(bob, alice);
    ok(
      toAlice?.includes(
        'action="upsert" bucket="user" agent="normal" user_id="7"',
      ),
    );
    ok(toAlice?.includes("&quot;tea&quot;"));
    ok(!toAlice?.includes("Shared fact"));
  } finally {
    await database.destroy();
  }
});

Deno.test("web search adds a surcharge and denied tools never execute", async () => {
  setLlmDeploymentName("small", "test-model");
  const originalFetch = globalThis.fetch;
  try {
    for (const denied of [false, true]) {
      let requests = 0;
      const charges: string[] = [];
      globalThis.fetch = (async (input, init) => {
        const request = new Request(input, init);
        strictEqual(new URL(request.url).pathname, "/v1/responses");
        requests++;
        return Response.json(
          createApiResponse(
            `credits_${requests}`,
            requests === 1
              ? [
                  {
                    id: "credit_tool",
                    type: "function_call",
                    call_id: "credit_call",
                    name: denied ? "set_reply_message_id" : "web_search",
                    arguments: denied ? '{"message_id":42}' : "{}",
                    status: "completed",
                  },
                ]
              : [
                  {
                    id: "credit_final",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                      { type: "output_text", text: "Done.", annotations: [] },
                    ],
                  },
                ],
          ),
        );
      }) as typeof fetch;
      const result = await requestLlm(
        "Use the tool",
        [denied ? "set_reply_message_id" : "web_search"],
        undefined,
        {
          context: { chatId: 1, messageId: 1 },
          chargeCredits: async (kind) => {
            charges.push(kind);
            if (denied) throw new Error("No credits left");
          },
        },
      );
      deepStrictEqual(charges, denied ? ["tool"] : ["tool", "web_search"]);
      if (denied) {
        strictEqual(result.replyMessageId, undefined);
        ok(result.errors.length > 0);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("troll requests load the current chat trolling mode, including follow-ups", async () => {
  const { trollAgent } = await import("./agents/index.ts");
  const { setTrollingMode } = await import("./trolling.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  setLlmDeploymentName("openminded", "test-troll-model");
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify(createApiResponse(`resp_mode_${requests.length}`, [{
        id: `msg_mode_${requests.length}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: "A topical quip.",
          annotations: [],
        }],
      }])),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const call = (chatId: number, responseId?: string) =>
      requestLlm(
        "Make a joke about this typo",
        [],
        responseId,
        { database, context: { chatId, messageId: 1 }, agentId: "troll" },
        trollAgent.buildInstructions(chatId),
        trollAgent.MODEL,
      );
    const first = await call(500);
    ok(
      String(requests[0].instructions).includes(
        "This chat's trolling mode is clean.",
      ),
    );
    await setTrollingMode(database, 500, "mild");
    const second = await call(500, first.response_id);
    ok(
      String(requests[1].instructions).includes(
        "This chat's trolling mode is mild.",
      ),
    );
    await call(501);
    ok(
      String(requests[2].instructions).includes(
        "This chat's trolling mode is clean.",
      ),
    );
    await setTrollingMode(database, 500, "clean");
    await call(500, second.response_id);
    ok(
      String(requests[3].instructions).includes(
        "This chat's trolling mode is clean.",
      ),
    );
    await assertRejects(
      () =>
        requestLlm(
          "hello",
          [],
          undefined,
          { agentId: "troll" },
          "troll",
          trollAgent.MODEL,
        ),
      /require a database and chatId/,
    );
    await setTrollingMode(database, 500, "aggressive");
    await call(500, second.response_id);
    ok(String(requests[4].instructions).includes("This chat's trolling mode is aggressive."));
    ok(String(requests[4].instructions).includes("crude, profane, chaotic"));
    strictEqual(requests.length, 5);
  } finally {
    globalThis.fetch = originalFetch;
    await database.destroy();
  }
});

Deno.test("trolling migration upgrades existing rows without changing state", async () => {
  const { migrateTrolling, setTrollingMode } = await import("./trolling.ts");
  const { sql } = await import("@kysely/kysely");
  const database = await initDatabase()();
  try {
    await database.schema.alterTable("chat_trolling").dropColumn(
      "trolling_mode",
    ).execute();
    // Simulate the previous schema with a disabled chat and an in-progress counter.
    await sql`insert into chat_trolling (chat_id, message_count, interval_message_count, enabled) values (500, 42, 137, 0)`
      .execute(database);
    await migrateTrolling(database);
    await migrateTrolling(database);
    const columns = (await database.introspection.getTables()).find((table) =>
      table.name === "chat_trolling"
    )?.columns;
    ok(columns?.some((column) => column.name === "trolling_mode"));
    deepStrictEqual(
      await database.selectFrom("chat_trolling").selectAll().where(
        "chat_id",
        "=",
        500,
      ).executeTakeFirst(),
      {
        chat_id: 500,
        message_count: 42,
        interval_message_count: 137,
        enabled: 0,
        trolling_mode: "clean",
      },
    );
    await setTrollingMode(database, 500, "mild");
    await migrateTrolling(database);
    const row = await database.selectFrom("chat_trolling").selectAll().where(
      "chat_id",
      "=",
      500,
    ).executeTakeFirstOrThrow();
    strictEqual(row.message_count, 42);
    strictEqual(row.interval_message_count, 137);
    strictEqual(row.enabled, 0);
    strictEqual(row.trolling_mode, "mild");
  } finally {
    await database.destroy();
  }
});

Deno.test("two-mode trolling preferences migrate once to mild and clean", async () => {
  const { migrateTrolling, getTrollingSettings, setTrollingMode } = await import("./trolling.ts");
  const { sql } = await import("@kysely/kysely");
  const database = await initDatabase()();
  try {
    await database.schema.alterTable("chat_trolling").dropColumn("trolling_mode").execute();
    await database.schema.alterTable("chat_trolling").addColumn("allow_insults", "integer", (column) => column.notNull().defaultTo(0)).execute();
    await sql`insert into chat_trolling (chat_id, message_count, interval_message_count, enabled, allow_insults) values (500, 42, 137, 0, 1), (501, 7, 100, 1, 0)`.execute(database);
    await migrateTrolling(database);
    strictEqual((await getTrollingSettings(database, 500)).mode, "mild");
    strictEqual((await getTrollingSettings(database, 501)).mode, "clean");
    await setTrollingMode(database, 500, "aggressive");
    await migrateTrolling(database);
    strictEqual((await getTrollingSettings(database, 500)).mode, "aggressive");
    const row = await database.selectFrom("chat_trolling").select(["message_count", "interval_message_count", "enabled"]).where("chat_id", "=", 500).executeTakeFirstOrThrow();
    deepStrictEqual(row, { message_count: 42, interval_message_count: 137, enabled: 0 });
  } finally {
    await database.destroy();
  }
});

Deno.test("trolling validation uses Sol high with strict boolean structured output", async () => {
  const { requestTrollingValidation } = await import("./llm.ts");
  const originalFetch = globalThis.fetch;
  const input = {
    messages: ["<message>context</message>"],
    candidate: "A topical quip.",
    mode: "clean" as const,
  };
  let requests = 0;
  let output = '{"valid":true}';
  globalThis.fetch = (async (_input, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    strictEqual(body.model, "gpt-61-sol");
    deepStrictEqual(body.reasoning, { effort: "high" });
    strictEqual(body.store, false);
    strictEqual(body.previous_response_id, undefined);
    strictEqual(body.tools, undefined);
    deepStrictEqual(JSON.parse(body.input[0].content), { messages: input.messages, candidate: input.candidate });
    ok(body.instructions.includes("This chat's trolling mode is clean."));
    ok(!/\b(aggressive|mild|clean)\s+permits/.test(body.instructions));
    deepStrictEqual(body.text.format, {
      type: "json_schema",
      name: "trolling_validation",
      strict: true,
      schema: {
        type: "object",
        properties: { valid: { type: "boolean" } },
        required: ["valid"],
        additionalProperties: false,
      },
    });
    return new Response(
      JSON.stringify(createApiResponse("resp_review", [{
        id: "msg_review",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: output, annotations: [] }],
      }])),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    deepStrictEqual(await requestTrollingValidation(input), { valid: true });
    output = '{"valid":false}';
    deepStrictEqual(await requestTrollingValidation(input), { valid: false });
    for (
      const invalid of [
        '{"valid":"false"}',
        '{"valid":true,"extra":1}',
        "{}",
        "[]",
        "not JSON",
        "",
      ]
    ) {
      output = invalid;
      await assertRejects(
        () => requestTrollingValidation(input),
        /Trolling validation/,
      );
    }
    strictEqual(requests, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("trolling validation telemetry tracks verdicts, response failures and API failures", async (t) => {
  const { requestTrollingValidation } = await import("./llm.ts");
  const originalFetch = globalThis.fetch;
  const input = {
    messages: ["context"],
    candidate: "A topical quip.",
    mode: "clean" as const,
  };
  const events: LlmCallTelemetryPayload[] = [];
  const respond = (text: string) =>
    createApiResponse("resp_review", [{
      id: "msg_review",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }]);
  const fullUsage = { input_tokens: 10, cached_tokens: 2, output_tokens: 5 };
  const cases = [
    {
      name: "approval",
      response: respond('{"valid":true}'),
      valid: true,
      usage: fullUsage,
    },
    {
      name: "rejection",
      response: respond('{"valid":false}'),
      valid: false,
      usage: fullUsage,
    },
    {
      name: "invalid JSON",
      response: respond("not JSON"),
      error: /invalid JSON/,
      usage: fullUsage,
    },
    {
      name: "invalid verdict",
      response: respond('{"valid":"true"}'),
      error: /exactly/,
      usage: fullUsage,
    },
    {
      name: "refusal",
      response: {
        ...respond(""),
        output: [{
          type: "message",
          content: [{ type: "refusal", refusal: "No" }],
        }],
      },
      error: /refused/,
      usage: fullUsage,
    },
    {
      name: "incomplete response",
      response: { ...respond('{"valid":true}'), status: "incomplete" },
      error: /did not complete/,
      usage: fullUsage,
    },
    {
      name: "failed response",
      response: {
        ...respond(""),
        status: "failed",
        error: { code: "server_error", message: "Review failed" },
      },
      error: /Trolling validation failed/,
      usage: fullUsage,
    },
    {
      name: "missing usage",
      response: { ...respond('{"valid":true}'), usage: undefined },
      valid: true,
      usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0 },
    },
    {
      name: "missing cached usage",
      response: {
        ...respond('{"valid":true}'),
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      valid: true,
      usage: { ...fullUsage, cached_tokens: 0 },
    },
    {
      name: "API failure",
      response: {
        error: { message: "API failed", type: "invalid_request_error" },
      },
      httpStatus: 400,
      error: /API failed/,
      usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0 },
    },
  ];
  try {
    for (const test of cases) {
      await t.step(test.name, async () => {
        events.length = 0;
        globalThis.fetch = (() =>
          Promise.resolve(
            Response.json(test.response, { status: test.httpStatus ?? 200 }),
          )) as typeof fetch;
        const options = {
          telemetry: {
            chatType: "group" as const,
            mode: "normal" as const,
            emit: (payload: LlmCallTelemetryPayload) =>
              events.push(payload),
          },
        };
        if (test.error) {
          await assertRejects(
            () => requestTrollingValidation(input, options),
            test.error,
          );
        } else {
          deepStrictEqual(await requestTrollingValidation(input, options), {
            valid: test.valid,
          });
        }
        deepStrictEqual(events, [{
          chat_type: "group",
          ...test.usage,
          tools: [],
          mode: "normal",
          status: test.error ? "failed" : "success",
        }]);
      });
    }
    await t.step(
      "telemetry failures preserve the verdict and original error",
      async () => {
        const options = {
          telemetry: {
            chatType: "private" as const,
            mode: "normal" as const,
            emit: () => {
              throw new Error("Telemetry unavailable");
            },
          },
        };
        globalThis.fetch = (() =>
          Promise.resolve(
            Response.json(respond('{"valid":false}')),
          )) as typeof fetch;
        deepStrictEqual(await requestTrollingValidation(input, options), {
          valid: false,
        });
        globalThis.fetch = (() =>
          Promise.resolve(Response.json(respond("not JSON")))) as typeof fetch;
        await assertRejects(() =>
          requestTrollingValidation(input, options), /invalid JSON/);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("periodic trolling delivers to the selected context message or without a reply", async (t) => {
  const { maybeSendPeriodicTroll, setTrollingInterval } = await import(
    "./trolling.ts"
  );
  const { getLlmDeployment } = await import("./llm-deployments.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const originalModel = getLlmDeployment("openminded").deploymentName;
  const candidate = "A specific topical quip.";
  const sent: Array<{ text: string; options: Record<string, unknown> }> = [];
  let selectedId: number | null | undefined;
  let approved = true;
  let validations = 0;
  const ctx = {
    database,
    chat: { id: -100, type: "supergroup" },
    telemetry: { event: () => {} },
    reply: (text: string, options: Record<string, unknown>) => {
      sent.push({ text, options });
      return Promise.resolve();
    },
  } as unknown as import("../bot.ts").Context;
  const respond = (id: string, output: ResponseOutput[]) =>
    Response.json(createApiResponse(id, output));
  const textOutput = (text: string): ResponseOutput[] => [
    {
      id: "msg_reply",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ];
  globalThis.fetch = (async (url, init) => {
    const request = new Request(url, init);
    if (new URL(request.url).hostname === "qdrant.test") {
      if (!request.url.endsWith("/points/scroll")) {
        return Response.json({ result: { payload_schema: {} } });
      }
      const body = await request.json();
      ok(
        body.filter.must.some(
          (filter: Record<string, unknown>) =>
            filter.key === "thread_id" &&
            (filter.match as { value: number }).value === 7,
        ),
      );
      return Response.json({
        result: {
          points: [1, 2].map((id) => ({
            id: String(id),
            payload: {
              text: id === 1 ? "Earlier claim" : "Trigger message",
              date: "2026-10-02",
              date_timestamp: id,
              sender_name: id === 1 ? "Earlier user" : "Trigger user",
              sender_id: id,
              chat_id: -100,
              thread_id: 7,
              message_id: id,
            },
          })),
        },
      });
    }
    const body = await request.json();
    if (body.model === "test-troll-reply-model") {
      deepStrictEqual(
        body.tools.map((tool: { name: string }) => tool.name),
        ["set_reply_message_id"],
      );
      const result = body.input.find(
        (item: { type: string }) => item.type === "function_call_output",
      );
      if (selectedId !== undefined && !result) {
        return respond("resp_select", [
          {
            id: "tool_select",
            type: "function_call",
            call_id: "call_select",
            name: "set_reply_message_id",
            arguments: JSON.stringify({ message_id: selectedId }),
            status: "completed",
          },
        ]);
      }
      if (selectedId !== undefined) {
        ok(
          result.output.includes(
            JSON.stringify({ reply_message_id: selectedId }),
          ),
        );
      }
      return respond("resp_final", textOutput(candidate));
    }
    strictEqual(body.model, "gpt-61-sol");
    validations++;
    const input = JSON.parse(body.input[0].content);
    strictEqual(
      input.reply_message_id,
      selectedId === undefined ? 2 : selectedId,
    );
    strictEqual(input.candidate, candidate);
    ok(input.messages[0].includes('id="1"'));
    return respond(
      "resp_review",
      textOutput(JSON.stringify({ valid: approved })),
    );
  }) as typeof fetch;
  try {
    setLlmDeploymentName("openminded", "test-troll-reply-model");
    for (const test of [
      { name: "earlier participant", id: 1, replyId: 1 },
      { name: "explicit trigger", id: 2, replyId: 2 },
      { name: "default trigger", id: undefined, replyId: 2 },
      { name: "shared situation", id: null, replyId: null },
      { name: "unknown message is not sent", id: 99, skip: true },
      { name: "rejected earlier reply is not sent", id: 1, rejected: true },
    ]) {
      await t.step(test.name, async () => {
        selectedId = test.id;
        approved = !test.rejected;
        validations = 0;
        sent.length = 0;
        await setTrollingInterval(database, -100, 1);
        await maybeSendPeriodicTroll(
          ctx,
          {
            message_id: 2,
            message_thread_id: 7,
          },
          { id: 2, first_name: "Trigger user" },
          -100,
        );
        strictEqual(validations, test.skip ? 0 : 1);
        if (test.skip || test.rejected) {
          deepStrictEqual(sent, []);
          return;
        }
        deepStrictEqual(sent, [
          {
            text: candidate,
            options: {
              link_preview_options: { is_disabled: true },
              message_thread_id: 7,
              ...(test.replyId === null
                ? {}
                : { reply_parameters: { message_id: test.replyId } }),
            },
          },
        ]);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("openminded", originalModel);
    await database.destroy();
  }
});

Deno.test("periodic trolling always generates at its interval and sends only approved replies", async () => {
  const { maybeSendPeriodicTroll, setTrollingInterval } = await import(
    "./trolling.ts"
  );
  const { getUsageStatus } = await import("./usage.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  const sent: string[] = [];
  const telemetryEvents: LlmCallTelemetryPayload[] = [];
  let generations = 0;
  let validations = 0;
  let verdict = '{"valid":false}';
  let messageId = 0;
  const candidate = "A specific topical quip.";
  const ctx = {
    database,
    chat: { id: -100, type: "supergroup" },
    telemetry: {
      event: (name: string, payload: LlmCallTelemetryPayload) => {
        if (name === "llm_call") telemetryEvents.push(payload);
      },
    },
    reply: (text: string) => {
      sent.push(text);
      return Promise.resolve();
    },
  } as unknown as import("../bot.ts").Context;
  const respond = (text: string) =>
    Response.json(createApiResponse("resp_periodic", [{
      id: "msg_periodic",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }]));
  globalThis.fetch = (async (url, init) => {
    const request = new Request(url, init);
    if (new URL(request.url).hostname === "qdrant.test") {
      if (request.url.endsWith("/points/scroll")) {
        return Response.json({
          result: {
            points: [{
              id: "last",
              payload: {
                text: "A concrete chat message",
                date: "2026-10-01",
                date_timestamp: 1,
                sender_name: "User",
                sender_id: 2,
                chat_id: -100,
                message_id: messageId,
              },
            }],
          },
        });
      }
      return Response.json({ result: { payload_schema: {} } });
    }
    const body = await request.json();
    if (body.model === "test-troll-model") {
      generations++;
      return respond(candidate);
    }
    strictEqual(body.model, "gpt-61-sol");
    validations++;
    const input = JSON.parse(body.input[0].content);
    strictEqual(input.candidate, candidate);
    strictEqual(input.mode, undefined);
    ok(body.instructions.includes("This chat's trolling mode is clean."));
    ok(input.messages.at(-1).includes("A concrete chat message"));
    return respond(verdict);
  }) as typeof fetch;
  Math.random = () => 1; // The old 25% trigger would suppress all these replies.
  try {
    setLlmDeploymentName("openminded", "test-troll-model");
    await setTrollingInterval(database, -100, 2);
    const receive = () =>
      maybeSendPeriodicTroll(ctx, { message_id: ++messageId }, {
        id: 2,
        first_name: "User",
      }, -100);
    await receive();
    strictEqual(generations, 0);
    await receive();
    deepStrictEqual([generations, validations, sent.length], [1, 1, 0]);
    deepStrictEqual(telemetryEvents.map((event) => event.status), ["success", "success"]);
    verdict = '{"valid":true}';
    await receive();
    await receive();
    deepStrictEqual([generations, validations, sent.length], [2, 2, 1]);
    strictEqual(sent[0], candidate);
    verdict = '{"valid":"true"}';
    await receive();
    await assertRejects(receive, /Trolling validation/);
    deepStrictEqual([generations, validations, sent.length], [3, 3, 1]);
    deepStrictEqual(telemetryEvents.map((event) => event.status), ["success", "success", "success", "success", "success", "failed"]);
    const { used } = await getUsageStatus(database, -100);
    strictEqual(used, 6);
    await database.insertInto("credit_limits").values({
      chat_id: -100,
      quota: used + 1,
      unlimited: 0,
    }).execute();
    await receive();
    await receive();
    deepStrictEqual([generations, validations, sent.length], [4, 3, 1]);
    strictEqual(telemetryEvents.length, 7);
    for (const event of telemetryEvents) {
      deepStrictEqual(event, {
        chat_type: "group",
        input_tokens: 10,
        cached_tokens: 2,
        output_tokens: 5,
        tools: [],
        mode: "normal",
        status: event.status,
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
    await database.destroy();
  }
});
