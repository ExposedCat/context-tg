import { createDebug } from "@grammyjs/debug";
import OpenAI from "@openai/openai";
import { Composer } from "grammy";
import type { Context } from "../bot.ts";
import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";
import { formatImageMarkdown, saveImageFileId } from "./images.ts";
import { startsWithCommandPrefix } from "./message-filter.ts";

export type RememberedMessage = {
  message_id: number;
  message_thread_id?: number;
  media_group_id?: string;
  is_topic_message?: boolean;
  reply_to_message?: {
    message_id: number;
    message_thread_id?: number;
  };
  date: number;
  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  caption_entities?: MessageEntity[];
  photo?: Array<{
    file_id: string;
    width: number;
    height: number;
  }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
  };
  sticker?: {
    emoji?: string;
  };
  via_bot?: unknown;
  forward_origin?: ForwardOrigin;
  forward_from?: Sender;
  forward_sender_name?: string;
  forward_from_chat?: ForwardChat;
  forward_signature?: string;
};

type Sender = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
};

type ForwardChat = {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
};

type ForwardOrigin =
  | {
      type: "user";
      sender_user: Sender;
    }
  | {
      type: "hidden_user";
      sender_user_name: string;
    }
  | {
      type: "chat";
      sender_chat: ForwardChat;
      author_signature?: string;
    }
  | {
      type: "channel";
      chat: ForwardChat;
      author_signature?: string;
    };

type MessageEntity = {
  type: string;
  offset: number;
};

export type MessageMetadata = {
  text: string;
  date: string;
  date_timestamp: number;
  sender_name: string;
  sender_id: number;
  chat_id: number;
  message_id: number;
  media_group_id?: string;
  thread_id?: number;
  reply_to_message_id?: number;
};

export type MessageSearchMatch = "semantic" | "lexical" | "phrase";

export type MessageSearchOptions = {
  queries: string[];
  exactPhrases?: string[];
  from?: Date;
  to?: Date;
  chatId?: number;
  threadId?: number;
  senderId?: number;
  limit?: number;
};

export type MessageSearchResult = MessageMetadata & {
  id: string | number;
  score: number;
  queries: string[];
  matched_by: MessageSearchMatch[];
};

export type QdrantResponse<T> = {
  result: T;
  status: string;
  time: number;
};

type QdrantPoint = {
  id: string | number;
  score: number;
  payload?: Partial<MessageMetadata>;
};

type QdrantScrollPoint = Omit<QdrantPoint, "score">;

type QdrantScrollResult = {
  points: QdrantScrollPoint[];
};

type QdrantCollectionInfo = {
  payload_schema?: Record<
    string,
    | string
    | {
        data_type?: string;
      }
  >;
};

const logDebug = createDebug("app:messages:debug");
const logError = createDebug("app:messages:error");

const DEFAULT_SEARCH_LIMIT = 20;
const RRF_RANK_CONSTANT = 60;
const MESSAGE_PAYLOAD_INDEXES = [
  { fieldName: "chat_id", fieldSchema: "integer" },
  { fieldName: "thread_id", fieldSchema: "integer" },
  { fieldName: "message_id", fieldSchema: "integer" },
  { fieldName: "media_group_id", fieldSchema: "keyword" },
  { fieldName: "sender_id", fieldSchema: "integer" },
  { fieldName: "date_timestamp", fieldSchema: "integer" },
  {
    fieldName: "text",
    fieldSchema: {
      type: "text",
      tokenizer: "word",
      lowercase: true,
      ascii_folding: true,
      phrase_matching: true,
    },
  },
] as const;

let setupPromise: Promise<void> | undefined;
let setupVectorSize: number | undefined;
let payloadIndexesPromise: Promise<boolean> | undefined;

export const messagesComposer = new Composer<Context>();

type IndexedTextMessageHandler = (
  ctx: Context,
  message: RememberedMessage,
  sender: Sender,
  chatId: number,
) => Promise<void>;

let indexedTextMessageHandler: IndexedTextMessageHandler | undefined;

function getEmbedderClient(): OpenAI {
  return new OpenAI({
    apiKey: APP_ENV.EMBEDDER_API_KEY,
    baseURL: APP_ENV.EMBEDDER_BASE_URL,
  });
}

function getQdrantUrl(path: string): string {
  return `${APP_ENV.QDRANT_URL.replace(/\/+$/, "")}${path}`;
}

export function getCollectionPath(suffix = ""): string {
  return `/collections/${encodeURIComponent(
    APP_ENV.QDRANT_COLLECTION,
  )}${suffix}`;
}

function getQdrantHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    ...(APP_ENV.QDRANT_API_KEY ? { "api-key": APP_ENV.QDRANT_API_KEY } : {}),
  };
}

export async function qdrantRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<QdrantResponse<T>> {
  const response = await fetch(getQdrantUrl(path), {
    ...init,
    headers: {
      ...getQdrantHeaders(),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Qdrant request failed: ${response.status} ${body}`);
  }

  return await response.json();
}

async function collectionExists(): Promise<boolean> {
  const response = await fetch(getQdrantUrl(getCollectionPath()), {
    headers: getQdrantHeaders(),
  });

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Qdrant collection check failed: ${response.status} ${body}`,
    );
  }

  return true;
}

async function getCollectionInfo(): Promise<QdrantCollectionInfo | undefined> {
  const response = await fetch(getQdrantUrl(getCollectionPath()), {
    headers: getQdrantHeaders(),
  });

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Qdrant collection info failed: ${response.status} ${body}`,
    );
  }

  const data = (await response.json()) as QdrantResponse<QdrantCollectionInfo>;
  return data.result;
}

function getPayloadSchemaType(
  payloadSchema: QdrantCollectionInfo["payload_schema"],
  fieldName: string,
): string | undefined {
  const fieldSchema = payloadSchema?.[fieldName];

  if (typeof fieldSchema === "string") {
    return fieldSchema;
  }

  return fieldSchema?.data_type;
}

function getPayloadIndexType(
  fieldSchema: (typeof MESSAGE_PAYLOAD_INDEXES)[number]["fieldSchema"],
): string {
  return typeof fieldSchema === "string" ? fieldSchema : fieldSchema.type;
}

export async function ensureMessagePayloadIndexes(): Promise<boolean> {
  if (payloadIndexesPromise) {
    return payloadIndexesPromise;
  }

  payloadIndexesPromise = (async () => {
    const collectionInfo = await getCollectionInfo();

    if (!collectionInfo) {
      payloadIndexesPromise = undefined;
      return false;
    }

    for (const { fieldName, fieldSchema } of MESSAGE_PAYLOAD_INDEXES) {
      if (
        getPayloadSchemaType(collectionInfo.payload_schema, fieldName) ===
        getPayloadIndexType(fieldSchema)
      ) {
        continue;
      }

      await qdrantRequest(getCollectionPath("/index?wait=true"), {
        method: "PUT",
        body: JSON.stringify({
          field_name: fieldName,
          field_schema: fieldSchema,
        }),
      });
    }

    return true;
  })();

  payloadIndexesPromise.catch(() => {
    payloadIndexesPromise = undefined;
  });

  return payloadIndexesPromise;
}

async function setupQdrant(vectorSize: number): Promise<void> {
  if (setupPromise && setupVectorSize === vectorSize) {
    return setupPromise;
  }

  setupVectorSize = vectorSize;
  setupPromise = (async () => {
    if (await collectionExists()) {
      await ensureMessagePayloadIndexes();
      return;
    }

    await qdrantRequest(getCollectionPath(), {
      method: "PUT",
      body: JSON.stringify({
        vectors: {
          size: vectorSize,
          distance: "Cosine",
        },
      }),
    });

    await ensureMessagePayloadIndexes();
  })();

  setupPromise.catch(() => {
    setupPromise = undefined;
    setupVectorSize = undefined;
  });

  return setupPromise;
}

async function embed(texts: string[]): Promise<number[][]> {
  const input = texts.map((text) => text.trim()).filter(Boolean);

  if (input.length === 0) {
    return [];
  }

  const response = await getEmbedderClient().embeddings.create({
    model: APP_ENV.EMBEDDING_MODEL,
    input,
  });
  const vectors = response.data.map((item) => item.embedding);
  const firstVector = vectors[0];

  if (!firstVector) {
    return [];
  }

  await setupQdrant(firstVector.length);

  return vectors;
}

function getMessageThreadId(message: RememberedMessage): number | undefined {
  return (
    message.message_thread_id ?? message.reply_to_message?.message_thread_id
  );
}

function getReplyToMessageId(message: RememberedMessage): number | undefined {
  const replyMessageId = message.reply_to_message?.message_id;

  if (
    message.is_topic_message === true &&
    replyMessageId === message.message_thread_id
  ) {
    return undefined;
  }

  return replyMessageId;
}

async function getPointId(chatId: number, messageId: number): Promise<string> {
  const data = new TextEncoder().encode(`${chatId}:${messageId}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = [...hash.slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function getSenderName(sender: Sender): string {
  const name = [sender.first_name, sender.last_name].filter(Boolean).join(" ");
  if (name && sender.username) {
    return `${name} (@${sender.username})`;
  }

  return name || (sender.username ? `@${sender.username}` : String(sender.id));
}

function getForwardChatName(chat: ForwardChat): string {
  if (chat.title) {
    return chat.username ? `${chat.title} (@${chat.username})` : chat.title;
  }

  if (chat.first_name) {
    return getSenderName({
      id: chat.id ?? 0,
      first_name: chat.first_name,
      last_name: chat.last_name,
      username: chat.username,
    });
  }

  return chat.username ? `@${chat.username}` : String(chat.id ?? "");
}

function getForwardedFromName(message: RememberedMessage): string | undefined {
  const origin = message.forward_origin;

  if (origin?.type === "user") {
    return getSenderName(origin.sender_user);
  }

  if (origin?.type === "hidden_user") {
    return origin.sender_user_name;
  }

  if (origin?.type === "chat") {
    return origin.author_signature ?? getForwardChatName(origin.sender_chat);
  }

  if (origin?.type === "channel") {
    return origin.author_signature ?? getForwardChatName(origin.chat);
  }

  if (message.forward_from) {
    return getSenderName(message.forward_from);
  }

  if (message.forward_sender_name) {
    return message.forward_sender_name;
  }

  if (message.forward_from_chat) {
    return (
      message.forward_signature ?? getForwardChatName(message.forward_from_chat)
    );
  }

  return undefined;
}

function getMessageText(message: RememberedMessage): string | undefined {
  return message.text ?? message.caption;
}

function isImageDocument(
  document: RememberedMessage["document"],
): document is NonNullable<RememberedMessage["document"]> {
  if (!document) {
    return false;
  }

  const extension = document.file_name?.split(".").at(-1)?.toLocaleLowerCase();
  return (
    document.mime_type?.startsWith("image/") === true ||
    ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"].includes(
      extension ?? "",
    )
  );
}

function hasImageAttachment(message: RememberedMessage): boolean {
  return (
    (message.photo !== undefined && message.photo.length > 0) ||
    isImageDocument(message.document)
  );
}

function getLargestPhoto(message: RememberedMessage) {
  return message.photo?.toSorted(
    (left, right) => right.width * right.height - left.width * left.height,
  )[0];
}

async function getImageMarkdown(
  database: Database,
  message: RememberedMessage,
): Promise<string | undefined> {
  const photo = getLargestPhoto(message);

  if (photo) {
    const image = await saveImageFileId(database, photo.file_id, "photo");
    return formatImageMarkdown(image.id, image.media_type);
  }

  if (isImageDocument(message.document)) {
    const image = await saveImageFileId(
      database,
      message.document.file_id,
      "document",
    );
    return formatImageMarkdown(image.id, image.media_type);
  }

  return undefined;
}

export async function formatRememberedMessageContent(
  database: Database,
  message: RememberedMessage,
): Promise<string | undefined> {
  return getMessageContent(message, await getImageMarkdown(database, message));
}

function formatStickerMarker(emoji: string | undefined): string {
  const trimmedEmoji = emoji?.trim();
  return trimmedEmoji ? `[sticker ${trimmedEmoji}]` : "[sticker]";
}

function getStickerMarker(message: RememberedMessage): string | undefined {
  return message.sticker
    ? formatStickerMarker(message.sticker.emoji)
    : undefined;
}

function getMessageContent(
  message: RememberedMessage,
  photoMarkdown?: string,
): string | undefined {
  const text = getMessageText(message);
  const parts = [photoMarkdown, getStickerMarker(message), text].filter(
    (part): part is string => part !== undefined && part.trim() !== "",
  );

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function getIndexableText(
  message: RememberedMessage,
  photoMarkdown?: string,
): string | undefined {
  const content = getMessageContent(message, photoMarkdown);

  if (!content) {
    return undefined;
  }

  const forwardedFromName = getForwardedFromName(message);

  if (!forwardedFromName) {
    return content;
  }

  return `Forwarded from ${JSON.stringify(forwardedFromName)}\n${content}`;
}

function hasCommandEntity(message: RememberedMessage): boolean {
  return [
    ...(message.entities ?? []),
    ...(message.caption_entities ?? []),
  ].some((entity) => entity.type === "bot_command" && entity.offset === 0);
}

function shouldSkipIndexing(message: RememberedMessage): boolean {
  if (message.via_bot) {
    return true;
  }

  if (
    hasCommandEntity(message) ||
    startsWithCommandPrefix(getMessageText(message))
  ) {
    return true;
  }

  return (
    !hasImageAttachment(message) && getIndexableText(message) === undefined
  );
}

async function indexMessage(
  database: Database,
  message: RememberedMessage,
  sender: Sender,
  chatId: number,
): Promise<void> {
  const senderName = getSenderName(sender);
  const text = getIndexableText(
    message,
    await getImageMarkdown(database, message),
  );
  if (!text) {
    return;
  }

  const vectors = await embed([`${senderName}: ${text}`]);
  const vector = vectors[0];

  if (!vector) {
    return;
  }

  const date = new Date(message.date * 1000);
  const threadId = getMessageThreadId(message);
  const replyToMessageId = getReplyToMessageId(message);
  const payload: MessageMetadata = {
    text,
    date: date.toISOString(),
    date_timestamp: message.date,
    sender_name: senderName,
    sender_id: sender.id,
    chat_id: chatId,
    message_id: message.message_id,
    ...(message.media_group_id !== undefined
      ? { media_group_id: message.media_group_id }
      : {}),
    ...(threadId !== undefined ? { thread_id: threadId } : {}),
    ...(replyToMessageId !== undefined
      ? { reply_to_message_id: replyToMessageId }
      : {}),
  };

  await qdrantRequest(getCollectionPath("/points"), {
    method: "PUT",
    body: JSON.stringify({
      points: [
        {
          id: await getPointId(chatId, message.message_id),
          vector,
          payload,
        },
      ],
    }),
  });
}

async function deleteIndexedMessage(
  chatId: number,
  messageId: number,
): Promise<void> {
  await qdrantRequest(getCollectionPath("/points/delete"), {
    method: "POST",
    body: JSON.stringify({
      points: [await getPointId(chatId, messageId)],
    }),
  });
}

function getSearchFilter(
  options: MessageSearchOptions,
  extraMust: Record<string, unknown>[] = [],
) {
  const must: Record<string, unknown>[] = [];

  if (options.chatId !== undefined) {
    must.push({ key: "chat_id", match: { value: options.chatId } });
  }

  if (options.threadId !== undefined) {
    must.push({ key: "thread_id", match: { value: options.threadId } });
  }

  if (options.senderId !== undefined) {
    must.push({ key: "sender_id", match: { value: options.senderId } });
  }

  if (options.from || options.to) {
    must.push({
      key: "date_timestamp",
      range: {
        ...(options.from
          ? { gte: Math.floor(options.from.getTime() / 1000) }
          : {}),
        ...(options.to ? { lte: Math.floor(options.to.getTime() / 1000) } : {}),
      },
    });
  }

  must.push(...extraMust);

  return must.length > 0 ? { must } : undefined;
}

export function isMessageMetadata(
  payload: Partial<MessageMetadata>,
): payload is MessageMetadata {
  return (
    typeof payload.text === "string" &&
    typeof payload.date === "string" &&
    typeof payload.date_timestamp === "number" &&
    typeof payload.sender_name === "string" &&
    typeof payload.sender_id === "number" &&
    typeof payload.chat_id === "number" &&
    typeof payload.message_id === "number" &&
    (payload.media_group_id === undefined ||
      typeof payload.media_group_id === "string") &&
    (payload.reply_to_message_id === undefined ||
      typeof payload.reply_to_message_id === "number")
  );
}

type RankedMessageList = {
  query: string;
  matchType: MessageSearchMatch;
  points: Array<QdrantPoint | QdrantScrollPoint>;
  weight?: number;
};

type AccumulatedSearchResult = {
  result: MessageSearchResult;
  queries: Set<string>;
  matchTypes: Set<MessageSearchMatch>;
};

export function fuseRankedMessageLists(
  lists: readonly RankedMessageList[],
  limit: number,
): MessageSearchResult[] {
  const results = new Map<string, AccumulatedSearchResult>();

  for (const { query, matchType, points, weight = 1 } of lists) {
    points.forEach((point, rank) => {
      const payload = point.payload ?? {};
      if (!isMessageMetadata(payload)) {
        return;
      }

      const id = String(point.id);
      const fusedScore = weight / (RRF_RANK_CONSTANT + rank + 1);
      const existing = results.get(id);

      if (existing) {
        existing.result.score += fusedScore;
        existing.queries.add(query);
        existing.matchTypes.add(matchType);
        return;
      }

      const queries = new Set([query]);
      const matchTypes = new Set([matchType]);
      const result: MessageSearchResult = {
        ...payload,
        id: point.id,
        score: fusedScore,
        queries: [],
        matched_by: [],
      };
      results.set(id, { result, queries, matchTypes });
    });
  }

  return [...results.values()]
    .map(({ result, queries, matchTypes }) => ({
      ...result,
      queries: [...queries],
      matched_by: [...matchTypes],
    }))
    .sort(
      (left, right) =>
        right.score - left.score || right.date_timestamp - left.date_timestamp,
    )
    .slice(0, limit);
}

async function searchSemanticList(
  vector: number[],
  options: MessageSearchOptions,
  limit: number,
): Promise<QdrantPoint[]> {
  const response = await qdrantRequest<QdrantPoint[]>(
    getCollectionPath("/points/search"),
    {
      method: "POST",
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
        filter: getSearchFilter(options),
      }),
    },
  );

  return response.result;
}

export function containsExactPhrase(text: string, query: string): boolean {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .includes(query.normalize("NFKC").toLocaleLowerCase());
}

async function searchLexicalList(
  query: string,
  matchType: "lexical" | "phrase",
  options: MessageSearchOptions,
  limit: number,
): Promise<QdrantScrollPoint[]> {
  const response = await qdrantRequest<QdrantScrollResult>(
    getCollectionPath("/points/scroll"),
    {
      method: "POST",
      body: JSON.stringify({
        limit,
        with_payload: true,
        with_vector: false,
        filter: getSearchFilter(options, [
          {
            key: "text",
            match: {
              [matchType === "phrase" ? "phrase" : "text"]: query,
            },
          },
        ]),
        order_by: {
          key: "date_timestamp",
          direction: "desc",
        },
      }),
    },
  );

  if (matchType !== "phrase") {
    return response.result.points;
  }

  return response.result.points.filter((point) =>
    point.payload?.text === undefined
      ? false
      : containsExactPhrase(point.payload.text, query),
  );
}

export async function search(
  options: MessageSearchOptions,
): Promise<MessageSearchResult[]> {
  const queries = [
    ...new Set(options.queries.map((query) => query.trim()).filter(Boolean)),
  ];
  const exactPhrases = [
    ...new Set(
      (options.exactPhrases ?? []).map((query) => query.trim()).filter(Boolean),
    ),
  ];
  const vectors = await embed(queries);
  if (
    vectors.length === 0 &&
    (queries.length > 0 || exactPhrases.length > 0) &&
    !(await ensureMessagePayloadIndexes())
  ) {
    return [];
  }
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const branchLimit = Math.max(DEFAULT_SEARCH_LIMIT, limit);
  const lists = await Promise.all([
    ...vectors.map(
      async (vector, index): Promise<RankedMessageList> => ({
        query: queries[index],
        matchType: "semantic",
        points: await searchSemanticList(vector, options, branchLimit),
      }),
    ),
    ...queries.map(
      async (query): Promise<RankedMessageList> => ({
        query,
        matchType: "lexical",
        points: await searchLexicalList(query, "lexical", options, branchLimit),
      }),
    ),
    ...exactPhrases.map(
      async (query): Promise<RankedMessageList> => ({
        query,
        matchType: "phrase",
        weight: 2,
        points: await searchLexicalList(query, "phrase", options, branchLimit),
      }),
    ),
  ]);

  return fuseRankedMessageLists(lists, limit);
}

async function handleIndexMessage(
  database: Database,
  message: RememberedMessage,
  sender: Sender,
  chatId: number,
  action: "indexed" | "reindexed",
): Promise<boolean> {
  if (shouldSkipIndexing(message)) {
    if (action === "reindexed") {
      try {
        await deleteIndexedMessage(chatId, message.message_id);
        logDebug("Message removed from index", {
          chatId,
          messageId: message.message_id,
        });
      } catch (error) {
        logError("Failed to remove skipped message from index", { error });
      }
    }

    return false;
  }

  try {
    await indexMessage(database, message, sender, chatId);
    logDebug(`Message ${action}`, {
      chatId,
      messageId: message.message_id,
    });
    return true;
  } catch (error) {
    logError(`Failed to ${action} message`, { error });
    return false;
  }
}

export function setIndexedTextMessageHandler(
  handler: IndexedTextMessageHandler,
) {
  indexedTextMessageHandler = handler;
}

messagesComposer.on("message", async (ctx, next) => {
  await next();

  void (async () => {
    if (!ctx.from || !ctx.chat) {
      return;
    }

    const indexed = await handleIndexMessage(
      ctx.database,
      ctx.message as RememberedMessage,
      ctx.from,
      ctx.chat.id,
      "indexed",
    );

    if (indexed) {
      await indexedTextMessageHandler?.(
        ctx,
        ctx.message as RememberedMessage,
        ctx.from,
        ctx.chat.id,
      );
    }
  })();
});

messagesComposer.on("edited_message", async (ctx, next) => {
  await next();

  if (!ctx.from || !ctx.chat) {
    return;
  }

  void handleIndexMessage(
    ctx.database,
    ctx.editedMessage as RememberedMessage,
    ctx.from,
    ctx.chat.id,
    "reindexed",
  );
});
