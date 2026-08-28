import { readMessagesByIds, readMessageWindow } from "./last-messages.ts";
import {
  type MessageMetadata,
  type MessageSearchMatch,
  type MessageSearchOptions,
  type MessageSearchResult,
  search,
} from "./messages.ts";

export type MessageSearchWindowMessage = MessageMetadata & {
  is_anchor: boolean;
  is_reply_context: boolean;
};

export type MessageSearchWindow = {
  anchor_ids: number[];
  score: number;
  queries: string[];
  matched_by: MessageSearchMatch[];
  messages: MessageSearchWindowMessage[];
};

type PendingSearchWindow = {
  window: MessageSearchWindow;
  localMessageIds: Set<number>;
};

const DEFAULT_ANCHOR_LIMIT = 6;
const MAX_ANCHOR_LIMIT = 6;
const CONTEXT_MESSAGES_BEFORE = 3;
const CONTEXT_MESSAGES_AFTER = 3;

function copyMessageMetadata(message: MessageMetadata): MessageMetadata {
  return {
    text: message.text,
    date: message.date,
    date_timestamp: message.date_timestamp,
    sender_name: message.sender_name,
    sender_id: message.sender_id,
    chat_id: message.chat_id,
    message_id: message.message_id,
    ...(message.media_group_id !== undefined
      ? { media_group_id: message.media_group_id }
      : {}),
    ...(message.thread_id !== undefined
      ? { thread_id: message.thread_id }
      : {}),
    ...(message.reply_to_message_id !== undefined
      ? { reply_to_message_id: message.reply_to_message_id }
      : {}),
  };
}

function addWindowMessage(
  messages: Map<number, MessageSearchWindowMessage>,
  message: MessageMetadata,
  flags: Pick<MessageSearchWindowMessage, "is_anchor" | "is_reply_context">,
): void {
  const existing = messages.get(message.message_id);

  if (existing) {
    existing.is_anchor ||= flags.is_anchor;
    existing.is_reply_context ||= flags.is_reply_context;
    return;
  }

  messages.set(message.message_id, {
    ...copyMessageMetadata(message),
    ...flags,
  });
}

function setsIntersect(left: ReadonlySet<number>, right: ReadonlySet<number>) {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }

  return false;
}

function mergePendingWindows(
  left: PendingSearchWindow,
  right: PendingSearchWindow,
): PendingSearchWindow {
  const messages = new Map<number, MessageSearchWindowMessage>();

  for (const message of [...left.window.messages, ...right.window.messages]) {
    addWindowMessage(messages, message, message);
  }

  return {
    localMessageIds: new Set([
      ...left.localMessageIds,
      ...right.localMessageIds,
    ]),
    window: {
      anchor_ids: [
        ...new Set([...left.window.anchor_ids, ...right.window.anchor_ids]),
      ],
      score: Math.max(left.window.score, right.window.score),
      queries: [...new Set([...left.window.queries, ...right.window.queries])],
      matched_by: [
        ...new Set([...left.window.matched_by, ...right.window.matched_by]),
      ],
      messages: [...messages.values()].sort(
        (a, b) => a.message_id - b.message_id,
      ),
    },
  };
}

export function assembleMessageSearchWindows(
  anchors: readonly MessageSearchResult[],
  messagesByAnchor: ReadonlyMap<number, readonly MessageMetadata[]>,
  replyParents: readonly MessageMetadata[],
): MessageSearchWindow[] {
  const replyParentsById = new Map(
    replyParents.map((message) => [message.message_id, message]),
  );
  let pendingWindows: PendingSearchWindow[] = [];

  for (const anchor of anchors) {
    const localMessages = messagesByAnchor.get(anchor.message_id) ?? [];
    const localMessageIds = new Set(
      localMessages.map((message) => message.message_id),
    );
    localMessageIds.add(anchor.message_id);

    const messages = new Map<number, MessageSearchWindowMessage>();
    for (const message of localMessages) {
      addWindowMessage(messages, message, {
        is_anchor: message.message_id === anchor.message_id,
        is_reply_context: false,
      });
    }
    addWindowMessage(messages, anchor, {
      is_anchor: true,
      is_reply_context: false,
    });

    const replyParent =
      anchor.reply_to_message_id === undefined
        ? undefined
        : replyParentsById.get(anchor.reply_to_message_id);
    if (replyParent) {
      addWindowMessage(messages, replyParent, {
        is_anchor: false,
        is_reply_context: true,
      });
    }

    let mergedWindow: PendingSearchWindow = {
      localMessageIds,
      window: {
        anchor_ids: [anchor.message_id],
        score: anchor.score,
        queries: [...anchor.queries],
        matched_by: [...anchor.matched_by],
        messages: [...messages.values()].sort(
          (a, b) => a.message_id - b.message_id,
        ),
      },
    };
    const separateWindows: PendingSearchWindow[] = [];

    for (const existing of pendingWindows) {
      if (
        setsIntersect(mergedWindow.localMessageIds, existing.localMessageIds)
      ) {
        mergedWindow = mergePendingWindows(existing, mergedWindow);
      } else {
        separateWindows.push(existing);
      }
    }

    pendingWindows = [...separateWindows, mergedWindow];
  }

  return pendingWindows
    .map(({ window }) => window)
    .sort((left, right) => right.score - left.score);
}

export async function searchMessageWindows(
  options: MessageSearchOptions,
): Promise<MessageSearchWindow[]> {
  const chatId = options.chatId;
  if (chatId === undefined) {
    return [];
  }

  const anchorLimit = Math.max(
    1,
    Math.min(MAX_ANCHOR_LIMIT, options.limit ?? DEFAULT_ANCHOR_LIMIT),
  );
  const anchors = await search({ ...options, limit: anchorLimit });
  const messageWindows = await Promise.all(
    anchors.map(
      async (anchor) =>
        [
          anchor.message_id,
          await readMessageWindow({
            chatId,
            anchorMessageId: anchor.message_id,
            before: CONTEXT_MESSAGES_BEFORE,
            after: CONTEXT_MESSAGES_AFTER,
            threadId: options.threadId,
          }),
        ] as const,
    ),
  );
  const replyParentIds = anchors.flatMap((anchor) =>
    anchor.reply_to_message_id === undefined
      ? []
      : [anchor.reply_to_message_id],
  );
  const replyParents = await readMessagesByIds(replyParentIds, {
    chatId,
    threadId: options.threadId,
  });

  return assembleMessageSearchWindows(
    anchors,
    new Map(messageWindows),
    replyParents,
  );
}
