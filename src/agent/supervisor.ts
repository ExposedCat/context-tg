import { readFileSync } from "node:fs";

type SupervisorOperation = "restart" | "deploy";
type SupervisorScope = "agent" | "gateway" | "all";

function loadToken(): string {
  const path = process.env.LOYLEX_SUPERVISOR_TOKEN_FILE;
  const value = path ? readFileSync(path, "utf8").trim() : process.env.LOYLEX_SUPERVISOR_TOKEN;
  if (!value) {
    throw new Error("LOYLEX_SUPERVISOR_TOKEN_FILE or LOYLEX_SUPERVISOR_TOKEN is required");
  }
  return value;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const baseUrl = process.env.LOYLEX_SUPERVISOR_URL ?? "http://host.containers.internal:8790";
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${loadToken()}`,
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Supervisor ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export async function supervisorStatus(): Promise<unknown> {
  return request("/v1/status");
}

export async function scheduleSupervisorOperation(
  operation: SupervisorOperation,
  scope: SupervisorScope,
  delaySeconds: number,
): Promise<unknown> {
  return request(`/v1/${operation}/${scope}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delaySeconds }),
  });
}
