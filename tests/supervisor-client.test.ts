import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleSupervisorOperation, supervisorStatus } from "../src/agent/supervisor.ts";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "loylex-supervisor-client-"));
const socket = join(temporaryDirectory, "supervisor.sock");
const token = join(temporaryDirectory, "token");
writeFileSync(token, "test-secret\n");
process.env.LOYLEX_SUPERVISOR_SOCKET = socket;
process.env.LOYLEX_SUPERVISOR_TOKEN_FILE = token;

const requests: Array<{ path: string; authorization: string | null; body: unknown }> = [];
const server = Bun.serve({
  unix: socket,
  async fetch(request) {
    const body = request.method === "POST" ? await request.json() : null;
    requests.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
      body,
    });
    return Response.json({ accepted: true });
  },
});

afterAll(() => {
  server.stop(true);
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("supervisor client", () => {
  test("authenticates status over the Unix socket", async () => {
    expect(await supervisorStatus()).toEqual({ accepted: true });
    expect(requests.at(-1)).toEqual({
      path: "/v1/status",
      authorization: `Bearer ${readFileSync(token, "utf8").trim()}`,
      body: null,
    });
  });

  test("schedules a scoped delayed operation", async () => {
    expect(await scheduleSupervisorOperation("deploy", "all", 30)).toEqual({ accepted: true });
    expect(requests.at(-1)).toEqual({
      path: "/v1/deploy/all",
      authorization: "Bearer test-secret",
      body: { delaySeconds: 30 },
    });
  });
});
