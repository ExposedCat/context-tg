import type { AgentCompletion, AgentEvent, AgentJob } from "../shared/types.ts";

export class GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 65_000): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Gateway ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  next(): Promise<AgentJob | null> {
    return this.request<AgentJob | null>("/v1/jobs/next");
  }

  async isCancelled(jobId: number): Promise<boolean> {
    const result = await this.request<{ cancelled: boolean }>(
      `/v1/jobs/${jobId}/cancelled`,
      {},
      5_000,
    );
    return result.cancelled;
  }

  event(jobId: number, event: AgentEvent): Promise<{ ok: true }> {
    return this.request(`/v1/jobs/${jobId}/events`, {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  complete(jobId: number, completion: AgentCompletion): Promise<{ ok: true }> {
    return this.request(`/v1/jobs/${jobId}/complete`, {
      method: "POST",
      body: JSON.stringify(completion),
    });
  }

  fail(jobId: number, error: string): Promise<{ ok: true }> {
    return this.request(`/v1/jobs/${jobId}/fail`, {
      method: "POST",
      body: JSON.stringify({ error }),
    });
  }
}
