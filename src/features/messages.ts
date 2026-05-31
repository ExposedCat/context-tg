import { createDebug } from "@grammyjs/debug";
import OpenAI from "@openai/openai";
import { Composer } from "grammy";
import type { Context } from "../bot.ts";
import { APP_ENV } from "./env.ts";

type TextMessage = {
  message_id: number;
  date: number;
  text: string;
};

type Sender = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
};

export type MessageMetadata = {
  text: string;
  date: string;
  date_timestamp: number;
  sender_name: string;
  sender_id: number;
  chat_id: number;
  message_id: number;
};

export type MessageSearchOptions = {
  queries: string[];
  from?: Date;
  to?: Date;
  chatId?: number;
  senderId?: number;
  limit?: number;
};

export type MessageSearchResult = MessageMetadata & {
  id: string | number;
  score: number;
  queries: string[];
};

type QdrantResponse<T> = {
  result: T;
  status: string;
  time: number;
};

type QdrantPoint = {
  id: string | number;
  score: number;
  payload?: Partial<MessageMetadata>;
};

const logDebug = createDebug("app:messages:debug");
const logError = createDebug("app:messages:error");

const DEFAULT_SEARCH_LIMIT = 20;

let setupPromise: Promise<void> | undefined;
let setupVectorSize: number | undefined;

export const messagesComposer = new Composer<Context>();

function getClient(): OpenAI {
  return new OpenAI({
    apiKey: APP_ENV.LLM_API_KEY,
    baseURL: APP_ENV.LLM_BASE_URL,
  });
}

function getQdrantUrl(path: string): string {
  return `${APP_ENV.QDRANT_URL.replace(/\/+$/, "")}${path}`;
}

function getCollectionPath(suffix = ""): string {
  return `/collections/${encodeURIComponent(APP_ENV.QDRANT_COLLECTION)}${suffix}`;
}

function getQdrantHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    ...(APP_ENV.QDRANT_API_KEY ? { "api-key": APP_ENV.QDRANT_API_KEY } : {}),
  };
}

async function qdrantRequest<T>(
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

async function setupQdrant(vectorSize: number): Promise<void> {
  if (setupPromise && setupVectorSize === vectorSize) {
    return setupPromise;
  }

  setupVectorSize = vectorSize;
  setupPromise = (async () => {
    if (await collectionExists()) {
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

  const response = await getClient().embeddings.create({
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

async function indexMessage(
  message: TextMessage,
  sender: Sender,
  chatId: number,
): Promise<void> {
  const senderName = getSenderName(sender);
  const vectors = await embed([`${senderName}: ${message.text}`]);
  const vector = vectors[0];

  if (!vector) {
    return;
  }

  const date = new Date(message.date * 1000);
  const payload: MessageMetadata = {
    text: message.text,
    date: date.toISOString(),
    date_timestamp: message.date,
    sender_name: senderName,
    sender_id: sender.id,
    chat_id: chatId,
    message_id: message.message_id,
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

function getSearchFilter(options: MessageSearchOptions) {
  const must = [];

  if (options.chatId !== undefined) {
    must.push({ key: "chat_id", match: { value: options.chatId } });
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

  return must.length > 0 ? { must } : undefined;
}

function isMessageMetadata(
  payload: Partial<MessageMetadata>,
): payload is MessageMetadata {
  return (
    typeof payload.text === "string" &&
    typeof payload.date === "string" &&
    typeof payload.date_timestamp === "number" &&
    typeof payload.sender_name === "string" &&
    typeof payload.sender_id === "number" &&
    typeof payload.chat_id === "number" &&
    typeof payload.message_id === "number"
  );
}

export async function search(
  options: MessageSearchOptions,
): Promise<MessageSearchResult[]> {
  const queries = options.queries.map((query) => query.trim()).filter(Boolean);
  const vectors = await embed(queries);
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const results = new Map<string, MessageSearchResult>();

  await Promise.all(
    vectors.map(async (vector, index) => {
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

      for (const point of response.result) {
        const payload = point.payload ?? {};
        if (!isMessageMetadata(payload)) {
          continue;
        }

        const id = String(point.id);
        const existing = results.get(id);

        if (existing) {
          existing.score = Math.max(existing.score, point.score);
          existing.queries.push(queries[index]);
        } else {
          results.set(id, {
            ...payload,
            id: point.id,
            score: point.score,
            queries: [queries[index]],
          });
        }
      }
    }),
  );

  return [...results.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

messagesComposer.on("message:text", async (ctx, next) => {
  try {
    await indexMessage(ctx.message, ctx.from, ctx.chat.id);
    logDebug("Indexed text message", {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
    });
  } catch (error) {
    logError("Failed to index text message", { error });
  }

  await next();
});
