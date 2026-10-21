import type { MiddlewareFn } from "grammy";

const MAX_PENDING_TOPICS = 1_000;
const PENDING_TOPIC_TTL_MS = 30_000;

type PendingTopic = {
  topicId: number;
  nextMessageId: number;
  senderId: number;
  date: number;
  expiresAt: number;
  mediaGroupId?: string;
};

// Telegram can omit the topic ID on the first DM message, even though the
// immediately preceding service message supplies it. Resolve this before
// commands, indexing and conversation handling see the message.
export function createPrivateTopicMiddleware(): MiddlewareFn {
  const pending = new Map<number, PendingTopic>();

  return (ctx, next) => {
    const message = ctx.message;
    if (message?.chat.type !== "private" || !message.from) return next();

    const now = Date.now();
    for (const [chatId, topic] of pending) {
      if (topic.expiresAt <= now) pending.delete(chatId);
    }

    const chatId = message.chat.id;
    if (
      message.forum_topic_created?.is_name_implicit &&
      message.message_thread_id !== undefined
    ) {
      pending.delete(chatId);
      if (pending.size >= MAX_PENDING_TOPICS) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      pending.set(chatId, {
        topicId: message.message_thread_id,
        nextMessageId: message.message_id + 1,
        senderId: message.from.id,
        date: message.date,
        expiresAt: now + PENDING_TOPIC_TTL_MS,
      });
    } else {
      const topic = pending.get(chatId);
      if (topic && message.message_id >= topic.nextMessageId) {
        pending.delete(chatId);
        if (
          message.message_thread_id === undefined &&
          message.message_id === topic.nextMessageId &&
          message.from.id === topic.senderId &&
          message.date >= topic.date &&
          message.date <= topic.date + 2 &&
          (topic.mediaGroupId === undefined ||
            message.media_group_id === topic.mediaGroupId)
        ) {
          message.message_thread_id = topic.topicId;
          message.is_topic_message = true;
          if (message.media_group_id !== undefined) {
            pending.set(chatId, {
              ...topic,
              nextMessageId: message.message_id + 1,
              mediaGroupId: message.media_group_id,
            });
          }
        }
      }
    }

    // Registration must happen synchronously: the runner processes the next
    // update while downstream middleware is still handling this one.
    return next();
  };
}
