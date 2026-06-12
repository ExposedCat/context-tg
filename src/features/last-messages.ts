import {
  getCollectionPath,
  isMessageMetadata,
  type MessageMetadata,
  qdrantRequest,
} from "./messages.ts";

export type LastMessagesContext = {
  chatId: number;
  messageId: number;
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
const MIN_LAST_MESSAGES_SCAN_WINDOW = 100;
const MAX_LAST_MESSAGES_SCAN_RANGE = 10_000;

function clampCount(count: number): number {
  if (!Number.isFinite(count)) {
    return 1;
  }

  return Math.max(1, Math.min(MAX_LAST_MESSAGES_COUNT, Math.floor(count)));
}

export async function readLastMessages(
  count: number,
  { chatId, messageId, threadId }: LastMessagesContext,
): Promise<MessageMetadata[]> {
  const limit = clampCount(count);
  const scanWindow = Math.max(limit, MIN_LAST_MESSAGES_SCAN_WINDOW);
  const maxScanRange = Math.max(scanWindow, MAX_LAST_MESSAGES_SCAN_RANGE);
  const messages = new Map<number, MessageMetadata>();
  let toMessageId = messageId;

  while (
    toMessageId > 0 &&
    messages.size < limit &&
    messageId - toMessageId < maxScanRange
  ) {
    const fromMessageId = Math.max(0, toMessageId - scanWindow);
    const response = await qdrantRequest<QdrantScrollResult>(
      getCollectionPath("/points/scroll"),
      {
        method: "POST",
        body: JSON.stringify({
          limit: scanWindow,
          with_payload: true,
          with_vector: false,
          filter: {
            must: [
              { key: "chat_id", match: { value: chatId } },
              ...(threadId !== undefined
                ? [{ key: "thread_id", match: { value: threadId } }]
                : []),
              {
                key: "message_id",
                range: {
                  gt: fromMessageId,
                  lte: toMessageId,
                },
              },
            ],
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

    toMessageId = fromMessageId;
  }

  return [...messages.values()]
    .sort((left, right) => left.message_id - right.message_id)
    .slice(-limit);
}
