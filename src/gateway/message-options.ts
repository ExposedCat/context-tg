import type { TelegramChat } from "../shared/types.ts";

export type TelegramMessageOptions = {
  replyTo?: number;
  threadId: number | null;
};

export function responseOptions(
  chatType: TelegramChat["type"],
  replyTo: number,
  threadId: number | null,
): TelegramMessageOptions {
  return {
    ...(chatType === "private" ? {} : { replyTo }),
    threadId,
  };
}
