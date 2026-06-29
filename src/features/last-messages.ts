import {
  ensureMessagePayloadIndexes,
  getCollectionPath,
  isMessageMetadata,
  type MessageMetadata,
  qdrantRequest,
} from "./messages.ts";

export type LastMessagesContext = {
  chatId: number;
  messageId?: number;
  threadId?: number;
};

type QdrantScrollPoint = {
  id: string | number;
  payload?: Partial<MessageMetadata>;
};

type QdrantScrollResult = {
  points: QdrantScrollPoint[];
  next_page_offset?: string | number | null;
};

export const MAX_LAST_MESSAGES_COUNT = 300;

function clampCount(count: number): number {
  if (!Number.isFinite(count)) {
    return 1;
  }

  return Math.max(1, Math.min(MAX_LAST_MESSAGES_COUNT, Math.floor(count)));
}

function getLastMessagesFilter({
  chatId,
  messageId,
  threadId,
}: LastMessagesContext) {
  return {
    must: [
      { key: "chat_id", match: { value: chatId } },
      ...(threadId !== undefined
        ? [{ key: "thread_id", match: { value: threadId } }]
        : []),
      ...(messageId !== undefined
        ? [
            {
              key: "message_id",
              range: {
                lte: messageId,
              },
            },
          ]
        : []),
    ],
  };
}

export async function readLastMessages(
  count: number,
  context: LastMessagesContext,
): Promise<MessageMetadata[]> {
  const limit = clampCount(count);
  const { messageId } = context;
  const messages = new Map<number, MessageMetadata>();

  if (!(await ensureMessagePayloadIndexes())) {
    return [];
  }

  const response = await qdrantRequest<QdrantScrollResult>(
    getCollectionPath("/points/scroll"),
    {
      method: "POST",
      body: JSON.stringify({
        limit,
        with_payload: true,
        with_vector: false,
        filter: getLastMessagesFilter(context),
        order_by: {
          key: "message_id",
          direction: "desc",
          ...(messageId !== undefined ? { start_from: messageId } : {}),
        },
      }),
    },
  );

  for (const point of response.result.points) {
    const payload = point.payload ?? {};

    if (isMessageMetadata(payload)) {
      messages.set(payload.message_id, payload);
    }
  }

  return [...messages.values()]
    .sort((left, right) => left.message_id - right.message_id)
    .slice(-limit);
}
