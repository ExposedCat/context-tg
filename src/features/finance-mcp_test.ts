import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

for (const [key, value] of Object.entries({
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  LLM_STREAMING: "false",
  KEENABLE_API_KEY: "test",
  LLM_TEMPERATURE: "0.2",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test",
  QDRANT_URL: "https://qdrant.test",
}))
  Deno.env.set(key, value);

Deno.test("Finance MCP opt-in discovers reports, binds user identity and persists tools through the model loop", async () => {
  let httpRequests = 0;
  const toolCalls: unknown[] = [];
  const http = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      httpRequests++;
      const server = new Server(
        { name: "Eyri test", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(
        ListToolsRequestSchema,
        (request: { params?: { cursor?: string } }) => ({
          tools: [
            {
              name: request.params?.cursor ? "rsu_at" : "number",
              description: "Portfolio report",
              inputSchema: {
                type: "object",
                properties: {
                  userId: { type: "integer" },
                  ...(request.params?.cursor
                    ? { cutoff: { type: "string" } }
                    : { bucketName: { type: "string" } }),
                },
                required: request.params?.cursor
                  ? ["userId", "cutoff"]
                  : ["userId"],
              },
            },
          ],
          ...(request.params?.cursor ? {} : { nextCursor: "next" }),
        }),
      );
      server.setRequestHandler(
        CallToolRequestSchema,
        (request: {
          params: { name: string; arguments?: Record<string, unknown> };
        }) => {
          toolCalls.push(request.params);
          return {
            content: [{ type: "text", text: '{"total":42}' }],
            structuredContent: { total: 42 },
          };
        },
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        await server.close();
      }
    },
  );
  Deno.env.set("FINANCE_MCP_URL", `http://127.0.0.1:${http.addr.port}/mcp`);
  const { initDatabase } = await import("./database.ts");
  const { requestLlm } = await import("./llm.ts");
  const { setLlmDeploymentName } = await import("./llm-deployments.ts");
  const { setFinanceMcpEnabled } = await import("./user-settings.ts");
  const { connectFinanceMcp } = await import("./finance-mcp.ts");
  const database = await initDatabase()();
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  let callFinance = false;
  let disableDuringCall = false;
  let financeFailure: "dns" | "discovery" | undefined;
  const answer = {
    type: "message",
    id: "msg",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Done.", annotations: [] }],
  };
  globalThis.fetch = (async (input, init) => {
    if (!String(input).startsWith("https://llm.test/")) {
      if (financeFailure === "dns")
        throw new TypeError(
          "failed to lookup address information: Name or service not known",
        );
      if (financeFailure === "discovery" && init?.body) {
        const body = JSON.parse(String(init.body));
        if (body.method === "tools/list" && body.params?.cursor)
          return new Response("Finance MCP unavailable", { status: 503 });
      }
      return await originalFetch(input, init);
    }
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const output = callFinance
      ? [
          {
            type: "function_call",
            id: "fc",
            call_id: "call_finance",
            name: "finance_number",
            arguments: JSON.stringify({ userId: 999, bucketName: "Shared" }),
            status: "completed",
          },
        ]
      : [answer];
    callFinance = false;
    if (disableDuringCall) {
      await setFinanceMcpEnabled(database, 2, false);
      disableDuringCall = false;
    }
    return Response.json({
      id: `resp_${requests.length}`,
      object: "response",
      created_at: 1,
      status: "completed",
      output,
      model: "test",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;
  setLlmDeploymentName("small", "test");
  const run = (userId?: number, chatId = -100, previousResponseId?: string) =>
    requestLlm("My portfolio", [], previousResponseId, {
      database,
      context: { chatId, messageId: 1, userId },
    });
  try {
    await run(2);
    strictEqual(httpRequests, 0);
    strictEqual(requests.at(-1)?.tools, undefined);
    await setFinanceMcpEnabled(database, 2, true);
    callFinance = true;
    const result = await run(2);
    strictEqual(result.tool_call_count, 1);
    deepStrictEqual(result.tools, ["finance_number"]);
    deepStrictEqual(toolCalls, [
      { name: "number", arguments: { userId: 2, bucketName: "Shared" } },
    ]);
    const definitions = requests.at(-1)?.tools as Array<{
      name: string;
      parameters: { properties: unknown; required: string[] };
    }>;
    deepStrictEqual(
      definitions.map((tool) => tool.name),
      ["finance_number", "finance_rsu_at"],
    );
    deepStrictEqual(definitions[0].parameters.properties, {
      bucketName: { type: "string" },
    });
    deepStrictEqual(definitions[1].parameters.required, ["cutoff"]);
    deepStrictEqual(requests.at(-1)?.tools, requests.at(-2)?.tools);
    ok(JSON.stringify(requests.at(-1)?.input).includes("total"));
    const before = httpRequests;
    await run(3);
    await run();
    strictEqual(httpRequests, before);
    await run(2, 2);
    ok(httpRequests > before);
    callFinance = true;
    disableDuringCall = true;
    const revoked = await run(2);
    strictEqual(toolCalls.length, 1);
    strictEqual(
      revoked.errors[0].details,
      "Finance MCP is disabled for this user.",
    );
    const after = httpRequests;
    await run(2, -100, result.response_id);
    strictEqual(httpRequests, after);
    strictEqual(requests.at(-1)?.tools, undefined);
    // An unsolicited finance call while disabled must never contact Eyri.
    callFinance = true;
    const disabled = await run(2);
    strictEqual(
      disabled.errors[0].details,
      "Finance MCP tool is unavailable for this user.",
    );
    strictEqual(httpRequests, after);

    await setFinanceMcpEnabled(database, 2, true);
    for (const failure of ["dns", "discovery"] as const) {
      financeFailure = failure;
      const unavailable = await run(2);
      strictEqual(unavailable.response, "Done.");
      deepStrictEqual(unavailable.errors, []);
      strictEqual(requests.at(-1)?.tools, undefined);
      ok(!JSON.stringify(requests.at(-1)).includes("<finance_mcp>"));
    }

    const controller = new AbortController();
    const cancellation = new Error("Request cancelled");
    controller.abort(cancellation);
    financeFailure = "dns";
    await rejects(
      connectFinanceMcp(database, 2, controller.signal),
      (error) => error === cancellation,
    );

    // A later request discovers finance tools again once the server recovers.
    financeFailure = undefined;
    await run(2);
    ok(Array.isArray(requests.at(-1)?.tools));

    // Wrapping up disables dynamically discovered tools as well as local tools.
    const { LlmToolBudget } = await import("./llm-budget.ts");
    callFinance = true;
    const wrapped = await requestLlm("My portfolio", [], undefined, {
      database,
      context: { chatId: -100, messageId: 1, userId: 2 },
      toolBudget: new LlmToolBudget(1),
    });
    strictEqual(wrapped.response, "Done.");
    ok(Array.isArray(requests.at(-2)?.tools));
    strictEqual(requests.at(-1)?.tools, undefined);
    ok(
      String(requests.at(-1)?.instructions).includes(
        "Tool limit reached, wrap up",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    setLlmDeploymentName("small", "");
    await database.destroy();
    await http.shutdown();
  }
});
