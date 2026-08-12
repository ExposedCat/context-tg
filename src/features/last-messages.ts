import {
  ensureMessagePayloadIndexes,
  getCollectionPath,
  isMessageMetadata,
  type MessageMetadata,
  type QdrantResponse,
  qdrantRequest,
} from "./messages.ts";

export type LastMessagesContext = {
  chatId: number;
  messageId?: number;
  threadId?: number;
};

export type MessageWindowContext = {
  chatId: number;
  anchorMessageId: number;
  before: number;
  after: number;
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

function getMessageScopeMust({
  chatId,
  threadId,
}: Pick<LastMessagesContext, "chatId" | "threadId">) {
  return [
    { key: "chat_id", match: { value: chatId } },
    ...(threadId !== undefined
      ? [{ key: "thread_id", match: { value: threadId } }]
      : []),
  ];
}

function getLastMessagesFilter({
  chatId,
  messageId,
  threadId,
}: LastMessagesContext) {
  return {
    must: [
      ...getMessageScopeMust({ chatId, threadId }),
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

function getMessagesFromScrollResult(
  response: QdrantResponse<QdrantScrollResult>,
): MessageMetadata[] {
  const messages = new Map<number, MessageMetadata>();

  for (const point of response.result.points) {
    const payload = point.payload ?? {};

    if (isMessageMetadata(payload)) {
      messages.set(payload.message_id, payload);
    }
  }

  return [...messages.values()].sort(
    (left, right) => left.message_id - right.message_id,
  );
}

export async function readLastMessages(
  count: number,
  context: LastMessagesContext,
): Promise<MessageMetadata[]> {
  const limit = clampCount(count);
  const { messageId } = context;

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

  return getMessagesFromScrollResult(response).slice(-limit);
}

export async function readMessageWindow({
  chatId,
  anchorMessageId,
  before,
  after,
  threadId,
}: MessageWindowContext): Promise<MessageMetadata[]> {
  const beforeCount = Math.max(0, Math.floor(before));
  const afterCount = Math.max(0, Math.floor(after));

  if (!(await ensureMessagePayloadIndexes())) {
    return [];
  }

  const scopeMust = getMessageScopeMust({ chatId, threadId });
  const requests: Array<Promise<QdrantResponse<QdrantScrollResult>>> = [];

  requests.push(
    qdrantRequest<QdrantScrollResult>(getCollectionPath("/points/scroll"), {
      method: "POST",
      body: JSON.stringify({
        limit: beforeCount + 1,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            ...scopeMust,
            {
              key: "message_id",
              range: { lte: anchorMessageId },
            },
          ],
        },
        order_by: {
          key: "message_id",
          direction: "desc",
          start_from: anchorMessageId,
        },
      }),
    }),
  );

  if (afterCount > 0) {
    requests.push(
      qdrantRequest<QdrantScrollResult>(getCollectionPath("/points/scroll"), {
        method: "POST",
        body: JSON.stringify({
          limit: afterCount,
          with_payload: true,
          with_vector: false,
          filter: {
            must: [
              ...scopeMust,
              {
                key: "message_id",
                range: { gt: anchorMessageId },
              },
            ],
          },
          order_by: {
            key: "message_id",
            direction: "asc",
            start_from: anchorMessageId,
          },
        }),
      }),
    );
  }

  const messages = new Map<number, MessageMetadata>();
  for (const response of await Promise.all(requests)) {
    for (const message of getMessagesFromScrollResult(response)) {
      messages.set(message.message_id, message);
    }
  }

  return [...messages.values()].sort(
    (left, right) => left.message_id - right.message_id,
  );
}

export async function readMessagesByIds(
  messageIds: readonly number[],
  context: Pick<LastMessagesContext, "chatId" | "threadId">,
): Promise<MessageMetadata[]> {
  const ids = [...new Set(messageIds)].filter(Number.isFinite);

  if (ids.length === 0 || !(await ensureMessagePayloadIndexes())) {
    return [];
  }

  const response = await qdrantRequest<QdrantScrollResult>(
    getCollectionPath("/points/scroll"),
    {
      method: "POST",
      body: JSON.stringify({
        limit: ids.length,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            ...getMessageScopeMust(context),
            { key: "message_id", match: { any: ids } },
          ],
        },
      }),
    },
  );

  return getMessagesFromScrollResult(response);
}
