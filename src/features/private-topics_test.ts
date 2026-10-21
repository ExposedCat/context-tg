import { test } from "bun:test";
import { strictEqual } from "node:assert";
import { Api, Context } from "grammy";
import { createPrivateTopicMiddleware } from "./private-topics.ts";
import { isImplicitTopicReply } from "./telegram.ts";

type Message = NonNullable<Context["message"]>;
const bot = {
  id: 42,
  is_bot: true,
  first_name: "Bot",
  username: "test_bot",
} as Context["me"];

function message(id: number, fields: Partial<Message> = {}): Message {
  return {
    message_id: id,
    date: 100,
    chat: { id: 1, type: "private", first_name: "User" },
    from: { id: 1, is_bot: false, first_name: "User" },
    ...fields,
  };
}

function topic(fields: Partial<Message> = {}): Message {
  return message(463, {
    message_thread_id: 2192415,
    is_topic_message: true,
    forum_topic_created: {
      name: "https://youtu.be...",
      icon_color: 7322096,
      is_name_implicit: true,
    },
    ...fields,
  });
}

function context(msg: Message): Context {
  return new Context(
    { update_id: msg.message_id, message: msg },
    new Api("test"),
    bot,
  );
}

test("implicit DM topic events route the first text and album before downstream async work", async () => {
  for (const mediaGroupId of [undefined, "album"]) {
    const middleware = createPrivateTopicMiddleware();
    let finish = () => {};
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const creation = middleware(context(topic()), () => blocked);
    const first = message(464, {
      date: 101,
      text: "Check this",
      media_group_id: mediaGroupId,
    });
    await middleware(context(first), async () => {
      strictEqual(first.message_thread_id, 2192415);
      strictEqual(first.is_topic_message, true);
    });
    const second = message(465, {
      date: 101,
      text: "Next",
      media_group_id: mediaGroupId,
    });
    await middleware(context(second), async () => {});
    strictEqual(second.message_thread_id, mediaGroupId ? 2192415 : undefined);
    finish();
    await creation;
  }
});

test("DM topic recovery leaves unrelated messages, explicit topics and non-DM chats alone", async () => {
  const group = { id: -100, type: "supergroup", title: "Forum" } as const;
  const cases = [
    {
      creation: topic({ chat: group }),
      incoming: message(464, { chat: group, text: "laylo check" }),
      expected: undefined,
    },
    {
      creation: topic({ chat: group }),
      incoming: message(464, {
        chat: group,
        message_thread_id: 7,
        is_topic_message: true,
        text: "laylo check",
      }),
      expected: 7,
    },
    {
      creation: topic(),
      incoming: message(464, {
        chat: { id: 2, type: "private", first_name: "Other" },
      }),
      expected: undefined,
    },
    { creation: topic(), incoming: message(465), expected: undefined },
    {
      creation: topic(),
      incoming: message(464, { date: 110 }),
      expected: undefined,
    },
    {
      creation: topic(),
      incoming: message(464, {
        from: { id: 2, is_bot: false, first_name: "Other" },
      }),
      expected: undefined,
    },
    {
      creation: topic(),
      incoming: message(464, { message_thread_id: 8 }),
      expected: 8,
    },
    {
      creation: topic({
        forum_topic_created: { name: "Manual", icon_color: 0 },
      }),
      incoming: message(464),
      expected: undefined,
    },
  ];
  for (const test of cases) {
    const middleware = createPrivateTopicMiddleware();
    await middleware(context(test.creation), async () => {});
    await middleware(context(test.incoming), async () => {});
    strictEqual(test.incoming.message_thread_id, test.expected);
    const later = message(466);
    await middleware(context(later), async () => {});
    strictEqual(later.message_thread_id, undefined);
  }
});

test("DM topic root service IDs may differ from topic IDs without becoming explicit reply parents", () => {
  const root = topic();
  const dm = message(466, { message_thread_id: 2192415 });
  strictEqual(isImplicitTopicReply(dm, root), true);
  strictEqual(
    isImplicitTopicReply(
      dm,
      message(464, { message_thread_id: 2192415, text: "Answer" }),
    ),
    false,
  );
  strictEqual(isImplicitTopicReply(dm, topic({ message_thread_id: 8 })), false);
  strictEqual(
    isImplicitTopicReply(
      { ...dm, chat: { type: "supergroup" }, is_topic_message: true },
      root,
    ),
    false,
  );
});
