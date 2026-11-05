import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { CALENDAR_SCOPES } from "../features/google-calendar-scopes.ts";

// One-time local authorization. The callback is loopback-only, state-bound and
// protected by PKCE. Never log authorization codes, access or refresh tokens.
const [clientPath, outputPath, mode] = process.argv.slice(2);
const allowTesting = mode === "--allow-testing";
if (mode && !allowTesting)
  throw new Error(
    "Unknown option. Use --allow-testing only for a temporary seven-day authorization.",
  );
if (!clientPath || !outputPath) {
  console.error(
    "Usage: bun src/scripts/calendar-oauth.ts CLIENT_JSON OUTPUT_JSON [--allow-testing]",
  );
  process.exit(1);
}
const output = resolve(outputPath);
if (await Bun.file(output).exists())
  throw new Error(
    "Output already exists. Choose a new path to avoid replacing a working credential.",
  );
const downloaded = (await Bun.file(clientPath).json()) as {
  installed?: { client_id: string; client_secret: string };
};
if (!downloaded.installed?.client_id || !downloaded.installed.client_secret)
  throw new Error("Expected a downloaded Desktop OAuth client JSON.");
const client = downloaded.installed;
const oauth = new OAuth2Client({
  clientId: client.client_id,
  clientSecret: client.client_secret,
});
const pkce = await oauth.generateCodeVerifierAsync();
const state = crypto.randomUUID();
let complete: () => void = () => {};
const completed = new Promise<void>((resolve) => {
  complete = resolve;
});
let handling = false;
let succeeded = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/oauth/callback")
      return new Response("Not found", { status: 404 });
    if (url.searchParams.get("state") !== state)
      return new Response("Invalid OAuth state", { status: 400 });
    if (handling)
      return new Response("Authorization already being processed", {
        status: 409,
      });
    if (url.searchParams.has("error")) {
      complete();
      return new Response(
        "Google authorization was declined. No credentials saved.",
        { status: 400 },
      );
    }
    const code = url.searchParams.get("code");
    if (!code)
      return new Response("Missing authorization code", { status: 400 });
    handling = true;
    try {
      const { tokens } = await oauth.getToken({
        code,
        codeVerifier: pkce.codeVerifier,
        redirect_uri: `http://127.0.0.1:${server.port}/oauth/callback`,
      });
      if (!tokens.refresh_token || !tokens.id_token)
        throw new Error("Missing offline credential or identity");
      const ticket = await oauth.verifyIdToken({
        idToken: tokens.id_token,
        audience: client.client_id,
      });
      const identity = ticket.getPayload();
      if (!identity?.email_verified || !identity.email)
        throw new Error("Google account email is not verified");
      const granted = new Set((tokens.scope ?? "").split(" "));
      if (!CALENDAR_SCOPES.every((scope) => granted.has(scope)))
        throw new Error("Calendar permission was not granted");
      if (
        (tokens as typeof tokens & { refresh_token_expires_in?: number })
          .refresh_token_expires_in &&
        !allowTesting
      )
        throw new Error(
          "Google issued a time-limited refresh token; switch the OAuth app to production and authorize again",
        );
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(
        output,
        `${JSON.stringify(
          {
            type: "authorized_user",
            client_id: client.client_id,
            client_secret: client.client_secret,
            refresh_token: tokens.refresh_token,
            account_email: identity.email,
            ...(allowTesting
              ? {
                  authorization_mode: "testing",
                  refresh_token_expires_at: Date.now() + 7 * 24 * 60 * 60_000,
                }
              : {}),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600, flag: "wx" },
      );
      await chmod(output, 0o600);
      succeeded = true;
      if (allowTesting)
        console.log(
          "Testing authorization expires within seven days. Reauthorize after publishing the OAuth app.",
        );
      console.log(
        `Calendar OAuth authorized as ${identity.email}. Credential saved to ${output}.`,
      );
      return new Response(
        "Calendar authorization complete. You can close this tab.",
        {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        },
      );
    } catch {
      console.error(
        "Calendar authorization failed. No usable credential was saved. Check consent, app publishing status, and try again.",
      );
      return new Response(
        "Calendar authorization failed. Check the local terminal; no tokens are shown here.",
        { status: 400 },
      );
    } finally {
      complete();
    }
  },
});
console.log(
  oauth.generateAuthUrl({
    redirect_uri: `http://127.0.0.1:${server.port}/oauth/callback`,
    access_type: "offline",
    prompt: "consent",
    scope: [...CALENDAR_SCOPES, "openid", "email"],
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  }),
);
const expiry = setTimeout(() => {
  console.error("Calendar authorization timed out.");
  complete();
}, 10 * 60_000);
await completed;
clearTimeout(expiry);
await server.stop();
if (!succeeded) process.exitCode = 1;
