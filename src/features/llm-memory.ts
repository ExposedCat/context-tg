import { escapeXmlAttribute } from "../utils/text.ts";
import type { AgentId } from "./agents/types.ts";
import {
  formatMemoryMemo,
  formatMemosMetadataSection,
  type Memo,
} from "./memos.ts";

export type ConversationMemory = {
  agentId: AgentId;
  userId?: number;
  userName?: string;
  memos: Memo[];
};

// History is append-only: a snapshot is written once, then only changes are sent.
// Removal also covers memories no longer in scope (e.g. a different speaker).
export function formatMemoryUpdate(
  previous: ConversationMemory | undefined,
  current: ConversationMemory,
): string | undefined {
  if (!previous) {
    return formatMemosMetadataSection(current.memos, current.userName);
  }

  const oldMemos = new Map(previous.memos.map((memo) => [memo.id, memo]));
  const newMemos = new Map(current.memos.map((memo) => [memo.id, memo]));
  const events: string[] = [];
  for (const memo of previous.memos) {
    if (!newMemos.has(memo.id)) {
      events.push(`  <memo id="${memo.id}" action="remove" />`);
    }
  }
  for (const memo of current.memos) {
    const old = oldMemos.get(memo.id);
    if (
      !old ||
      old.text !== memo.text ||
      old.bucket !== memo.bucket ||
      old.user_id !== memo.user_id
    ) {
      const scope = ` action="upsert" bucket="${memo.bucket}" agent="${memo.agent_id}"${memo.user_id === null ? "" : ` user_id="${memo.user_id}"`}`;
      events.push(formatMemoryMemo(memo).replace("<memo ", `<memo${scope} `));
    }
  }
  if (
    previous.agentId !== current.agentId ||
    previous.userId !== current.userId ||
    previous.userName !== current.userName
  ) {
    events.unshift(
      `  <memory-context agent="${current.agentId}" user_id="${current.userId ?? ""}" user_name="${escapeXmlAttribute(current.userName ?? "")}" />`,
    );
  }
  return events.length
    ? ["<events>", ...events, "</events>"].join("\n")
    : undefined;
}
