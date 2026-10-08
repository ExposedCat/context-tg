import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type OpenAI from "@openai/openai";
import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";
import type { FunctionToolRunner } from "./llm-tools/types.ts";
import { getFinanceMcpEnabled } from "./user-settings.ts";

export type FinanceToolName = `finance_${string}`;
export type FinanceMcpTools = {
  instructions?: string;
  definitions: OpenAI.Responses.FunctionTool[];
  runners: Map<FinanceToolName, FunctionToolRunner>;
  close: () => Promise<void>;
};

export function isFinanceToolName(name: string): name is FinanceToolName {
  return /^finance_[A-Za-z0-9_-]{1,56}$/.test(name);
}

export async function connectFinanceMcp(
  database: Database | undefined,
  userId: number | undefined,
  signal?: AbortSignal,
): Promise<FinanceMcpTools | undefined> {
  if (
    !database ||
    userId === undefined ||
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !(await getFinanceMcpEnabled(database, userId))
  )
    return undefined;

  const client = new Client({ name: "context-tg", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(APP_ENV.FINANCE_MCP_URL),
    {
      // Bound initialization, discovery and calls to this request's cancellation.
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([
            AbortSignal.timeout(60_000),
            ...(signal ? [signal] : []),
            ...(init?.signal ? [init.signal] : []),
          ]),
        }),
    },
  );
  try {
    await client.connect(transport);
    const definitions: OpenAI.Responses.FunctionTool[] = [];
    const runners = new Map<FinanceToolName, FunctionToolRunner>();
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
      });
      for (const tool of result.tools) {
        const name = `finance_${tool.name}`;
        if (!isFinanceToolName(name))
          throw new Error(`Unsupported Finance MCP tool name: ${tool.name}`);
        const { userId: _userId, ...properties } =
          tool.inputSchema.properties ?? {};
        definitions.push({
          type: "function",
          name,
          description: `Eyri Finance MCP: ${tool.description ?? tool.name}. Reports for the requesting user's own portfolio.`,
          parameters: {
            ...tool.inputSchema,
            properties,
            required:
              tool.inputSchema.required?.filter(
                (key: string) => key !== "userId",
              ) ?? [],
          },
          strict: false,
        });
        runners.set(name, async (args, _context, options) => {
          // Never allow model arguments to select someone else's portfolio.
          if (!(await getFinanceMcpEnabled(database, userId)))
            throw new Error("Finance MCP is disabled for this user.");
          const result = await client.callTool(
            {
              name: tool.name,
              arguments: { ...args, userId },
            },
            undefined,
            { signal: options?.signal, timeout: 120_000 },
          );
          if (result.isError)
            throw new Error(
              JSON.stringify(result.structuredContent ?? result.content),
            );
          return JSON.stringify(result.structuredContent ?? result.content);
        });
      }
      cursor = result.nextCursor;
    } while (cursor);
    return {
      definitions,
      runners,
      instructions: client.getInstructions(),
      close: () => client.close(),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
