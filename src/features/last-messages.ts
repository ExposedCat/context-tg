import {
  getCollectionPath,
  isMessageMetadata,
  type MessageMetadata,
  qdrantRequest,
} from "./messages.ts";

export type LastMessagesContext = {
  chatId: number;
  messageId: number;
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

export async function readLastMessages(
  count: number,
  { chatId, messageId }: LastMessagesContext,
): Promise<MessageMetadata[]> {
  const limit = clampCount(count);
  const fromMessageId = Math.max(0, messageId - limit);
  const response = await qdrantRequest<QdrantScrollResult>(
    getCollectionPath("/points/scroll"),
    {
      method: "POST",
      body: JSON.stringify({
        limit,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            { key: "chat_id", match: { value: chatId } },
            {
              key: "message_id",
              range: {
                gt: fromMessageId,
                lte: messageId,
              },
            },
          ],
        },
      }),
    },
  );

  return response.result.points
    .map((point) => point.payload ?? {})
    .filter(isMessageMetadata)
    .sort((left, right) => left.message_id - right.message_id);
}
