export const disabledLinkPreviewOptions = {
  link_preview_options: {
    is_disabled: true,
  },
} as const;

type TopicMessage = {
  message_thread_id?: number;
  is_topic_message?: boolean;
  chat?: { type?: string };
};

// Supergroups also use message_thread_id for ordinary reply chains. Only
// forum messages and private chat topics should scope history and delivery.
export function getMessageTopicId(
  message: TopicMessage,
  reply: TopicMessage | undefined,
): number | undefined {
  if (message.chat?.type === "private" || message.is_topic_message === true) {
    return message.message_thread_id ?? reply?.message_thread_id;
  }

  return reply?.is_topic_message === true ? reply.message_thread_id : undefined;
}

export function isImplicitTopicReply(
  message: TopicMessage,
  reply: { message_id: number } | undefined,
): boolean {
  return (
    (message.chat?.type === "private" || message.is_topic_message === true) &&
    message.message_thread_id !== undefined &&
    reply?.message_id === message.message_thread_id
  );
}
