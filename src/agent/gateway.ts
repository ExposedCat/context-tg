import { randomUUID } from "node:crypto";
import type { AgentCompletion, AgentEvent, AgentJob, WorkerRegistration } from "../shared/types.ts";
import { retryTransient } from "./retry.ts";

export class GatewayClient {
  private readonly workerId = randomUUID();

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private fetchResponse(
    path: string,
    init: RequestInit = {},
    timeoutMs = 65_000,
  ): Promise<Response> {
    return fetch(this.baseUrl + path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 65_000): Promise<T> {
    const response = await this.fetchResponse(path, init, timeoutMs);
    if (!response.ok) {
      throw new Error(`Gateway ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async registerWorker(): Promise<WorkerRegistration> {
    return this.request<WorkerRegistration>("/v1/workers/register", {
      method: "POST",
      headers: { "x-loylex-worker-id": this.workerId },
    });
  }

  async heartbeatWorker(): Promise<boolean> {
    const result = await this.request<{ alive: boolean }>("/v1/workers/heartbeat", {
      method: "POST",
      headers: { "x-loylex-worker-id": this.workerId },
    });
    return result.alive;
  }

  async stopWorker(): Promise<boolean> {
    const result = await this.request<{ stopped: boolean }>("/v1/workers/stop", {
      method: "POST",
      headers: { "x-loylex-worker-id": this.workerId },
    });
    return result.stopped;
  }

  async next(): Promise<{ job: AgentJob | null; draining: boolean }> {
    const response = await this.fetchResponse("/v1/jobs/next", {
      headers: { "x-loylex-worker-id": this.workerId },
    });
    if (!response.ok) {
      throw new Error(`Gateway ${response.status}: ${await response.text()}`);
    }
    return {
      job: (await response.json()) as AgentJob | null,
      draining: response.headers.get("x-loylex-drain") === "true",
    };
  }

  async isCancelled(jobId: number): Promise<boolean> {
    const result = await this.request<{ cancelled: boolean }>(
      `/v1/jobs/${jobId}/cancelled`,
      {},
      5_000,
    );
    return result.cancelled;
  }

  async downloadMedia(fileId: string, maxBytes?: number): Promise<Uint8Array> {
    return retryTransient(async () => {
      const response = await fetch(
        `${this.baseUrl}/v1/media?file_id=${encodeURIComponent(fileId)}`,
        {
          headers: { authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(65_000),
        },
      );
      if (!response.ok) {
        throw new Error(`Gateway ${response.status}: ${await response.text()}`);
      }
      const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (
        maxBytes !== undefined &&
        Number.isSafeInteger(declaredLength) &&
        declaredLength > maxBytes
      ) {
        throw new Error(`file is larger than ${maxBytes} bytes`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
        throw new Error(`file is larger than ${maxBytes} bytes`);
      }
      return bytes;
    });
  }

  event(jobId: number, event: AgentEvent): Promise<{ ok: true }> {
    return this.request(`/v1/jobs/${jobId}/events`, {
      method: "POST",
      body: JSON.stringify(event),
      headers: { "x-loylex-worker-id": this.workerId },
    });
  }

  async heartbeat(jobId: number): Promise<boolean> {
    const result = await this.request<{ owned: boolean }>(`/v1/jobs/${jobId}/heartbeat`, {
      method: "POST",
      headers: { "x-loylex-worker-id": this.workerId },
    });
    return result.owned;
  }

  complete(jobId: number, completion: AgentCompletion): Promise<{ ok: true }> {
    return this.request(`/v1/jobs/${jobId}/complete`, {
      method: "POST",
      body: JSON.stringify(completion),
      headers: { "x-loylex-worker-id": this.workerId },
    });
  }

  fail(jobId: number, error: string): Promise<{ ok: true }> {
    return this.request(`/v1/jobs/${jobId}/fail`, {
      method: "POST",
      body: JSON.stringify({ error }),
      headers: { "x-loylex-worker-id": this.workerId },
    });
  }
}
