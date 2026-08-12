import { deepStrictEqual, strictEqual } from "node:assert";
import { execute } from "./reply.ts";

Deno.test("set_reply_message_id selects a message", () => {
  deepStrictEqual(execute({ message_id: 42 }), {
    output: '{"reply_message_id":42}',
    replyMessageId: 42,
  });
});

Deno.test("set_reply_message_id clears the reply target", () => {
  deepStrictEqual(execute({ message_id: null }), {
    output: '{"reply_message_id":null}',
    replyMessageId: null,
  });
});

Deno.test("set_reply_message_id rejects invalid ids", () => {
  strictEqual(
    execute({ message_id: 0 }),
    '{"error":"Invalid reply message id."}',
  );
});
