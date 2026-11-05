import { test } from "bun:test";
import { ok, strictEqual } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("OAuth login binds a loopback callback to unpredictable state and PKCE before accepting any authorization code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calendar-oauth-"));
  const clientPath = join(directory, "client.json");
  const outputPath = join(directory, "credential.json");
  await writeFile(
    clientPath,
    JSON.stringify({
      installed: { client_id: "client-id", client_secret: "secret" },
    }),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./src/test-setup.ts",
      "src/scripts/calendar-oauth.ts",
      clientPath,
      outputPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    ok(first.value);
    const authorization = new URL(new TextDecoder().decode(first.value).trim());
    strictEqual(authorization.origin, "https://accounts.google.com");
    strictEqual(authorization.searchParams.get("access_type"), "offline");
    strictEqual(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    ok((authorization.searchParams.get("code_challenge")?.length ?? 0) >= 43);
    ok((authorization.searchParams.get("state")?.length ?? 0) >= 32);
    const callback = new URL(
      authorization.searchParams.get("redirect_uri") ?? "",
    );
    strictEqual(callback.hostname, "127.0.0.1");
    callback.searchParams.set("state", "attacker-state");
    callback.searchParams.set("code", "attacker-code");
    const response = await fetch(callback);
    strictEqual(response.status, 400);
    strictEqual(await Bun.file(outputPath).exists(), false);
    callback.searchParams.set(
      "state",
      authorization.searchParams.get("state") ?? "",
    );
    callback.searchParams.delete("code");
    callback.searchParams.set("error", "access_denied");
    strictEqual((await fetch(callback)).status, 400);
    strictEqual(await child.exited, 1);
    strictEqual(await Bun.file(outputPath).exists(), false);
    const client = await readFile(clientPath, "utf8");
    ok(
      client.includes("client-id"),
      "Failed authorization must not overwrite the OAuth client file",
    );
  } finally {
    child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
