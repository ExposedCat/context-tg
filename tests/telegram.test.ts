import { afterEach, expect, test } from "bun:test";
import { TelegramClient } from "../src/gateway/telegram.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("does not downgrade a rejected rich send to an unformatted message", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    return Response.json(
      { ok: false, error_code: 400, description: "rich message rejected" },
      { status: 400 },
    );
  }) as typeof fetch;

  const client = new TelegramClient("test-token");
  await expect(client.sendRich(42, "<details>formatted</details>")).rejects.toThrow(
    "sendRichMessage: rich message rejected",
  );

  expect(requests).toEqual(["https://api.telegram.org/bottest-token/sendRichMessage"]);
});

test("treats an idempotent rich edit as success", async () => {
  globalThis.fetch = (async (_input: string | URL | Request) =>
    Response.json(
      {
        ok: false,
        error_code: 400,
        description:
          "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      },
      { status: 400 },
    )) as unknown as typeof fetch;

  const client = new TelegramClient("test-token");
  const result = await client.editRich(42, 17, "<details>same</details>");

  expect(result.message_id).toBe(17);
  expect(result.chat.id).toBe(42);
});

test("deletes a Telegram message", async () => {
  let requestBody: unknown;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bottest-token/deleteMessage");
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;

  const client = new TelegramClient("test-token");
  await expect(client.deleteMessage(42, 17)).resolves.toBe(true);
  expect(requestBody).toEqual({ chat_id: 42, message_id: 17 });
});
