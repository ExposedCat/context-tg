import { test } from "bun:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  createGuestThreadReference,
  decodeGuestInlineMessageId,
  getGuestInlineMessageId,
  getGuestMessageScope,
  getGuestThreadReference,
} from "./guest-threads.ts";

test("inline identifiers decode the actual legacy and 64-bit message identity", () => {
  // Captured SentGuestMessage identifiers: the low word is a real message ID,
  // not an ID predicted from the trigger or from delivery order.
  deepStrictEqual(decodeGuestInlineMessageId("AgAAACeOIQBk8aQy97yFbQ8jPvQ"), {
    ownerId: 849670500,
    messageId: 2199079,
  });
  deepStrictEqual(decodeGuestInlineMessageId("AgAAAO99KwBve4YTeU3EX5JbKf8"), {
    ownerId: 327580527,
    messageId: 2850287,
  });
  const bytes = Buffer.alloc(24);
  bytes.writeInt32LE(4, 0);
  bytes.writeBigInt64LE(8_000_000_000n, 4);
  bytes.writeInt32LE(500, 12);
  bytes.writeBigInt64LE(123n, 16);
  deepStrictEqual(decodeGuestInlineMessageId(bytes.toString("base64url")), {
    ownerId: 8_000_000_000,
    messageId: 500,
  });
  bytes.writeBigInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 4);
  strictEqual(
    decodeGuestInlineMessageId(bytes.toString("base64url")),
    undefined,
  );
  for (const id of [
    "",
    "inline-1",
    "AgAAACeOIQBk8aQy97yFbQ8jPvQ!",
    Buffer.alloc(20).toString("base64url"),
    Buffer.alloc(28).toString("base64url"),
  ])
    strictEqual(decodeGuestInlineMessageId(id), undefined);
});

test("native numeric links verify which account owns the identifier", () => {
  const reference = {
    inline_message_id: "AgAAACeOIQBk8aQy97yFbQ8jPvQ",
    conversation_key: "dm:270886500:849670500:0",
    chat_id: 270886500,
    caller_id: 849670500,
  };
  strictEqual(getGuestInlineMessageId(reference), 2199079);
  strictEqual(
    getGuestInlineMessageId({ ...reference, caller_id: 270886500 }),
    undefined,
  );
  strictEqual(
    getGuestInlineMessageId({ ...reference, conversation_key: null }),
    undefined,
  );
  strictEqual(
    getGuestInlineMessageId({ ...reference, inline_message_id: "unknown" }),
    undefined,
  );
  strictEqual(
    getGuestInlineMessageId({
      inline_message_id: "AgAAAEWMAQBNQi6HRYeGTjlpilk",
      conversation_key: "chat:-1002027011507:0",
      chat_id: -1002027011507,
      caller_id: 100,
    }),
    101445,
  );
  strictEqual(
    getGuestMessageScope("chat:-123:0", -123, 100),
    "chat:-123:0:viewer:100",
  );
  strictEqual(
    getGuestMessageScope("chat:-1000000000123:0", -1000000000123, 100),
    "chat:-1000000000123:0:messages",
  );
});

test("guest references are unique, fit callback limits and reject conflicting buttons", () => {
  const first = createGuestThreadReference();
  const second = createGuestThreadReference();
  ok(first.referenceId !== second.referenceId);
  ok(Buffer.byteLength(first.callbackData) <= 64);
  const button = (callback_data: string) => ({ callback_data });
  strictEqual(
    getGuestThreadReference({
      inline_keyboard: [[button(first.callbackData)]],
    }),
    first.referenceId,
  );
  strictEqual(
    getGuestThreadReference({
      inline_keyboard: [
        [button(first.callbackData), button(first.callbackData)],
      ],
    }),
    first.referenceId,
  );
  strictEqual(
    getGuestThreadReference({
      inline_keyboard: [
        [button(first.callbackData), button(second.callbackData)],
      ],
    }),
    undefined,
  );
  strictEqual(
    getGuestThreadReference({
      inline_keyboard: [[button("guest-thread:garbage")]],
    }),
    undefined,
  );
  strictEqual(getGuestThreadReference(undefined), undefined);
});
