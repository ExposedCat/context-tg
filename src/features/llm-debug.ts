export type LlmInputDump = string[];

type LlmFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createLlmInputDump(enabled: boolean): LlmInputDump | undefined {
  return enabled ? [] : undefined;
}

export function createLlmInputDumpFetch(
  dump: LlmInputDump,
  baseFetch: LlmFetch = fetch,
): LlmFetch {
  return async (input, init) => {
    const request = new Request(input, init);
    dump.push(await request.clone().text());
    return await baseFetch(request);
  };
}

export function encodeLlmInputDump(dump: LlmInputDump): Uint8Array {
  return new TextEncoder().encode(dump.join("\n"));
}
