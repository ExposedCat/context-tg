import type { TelegramChat } from "../shared/types.ts";

export type TelegramMessageOptions = {
  replyTo?: number;
  threadId: number | null;
};

export function responseOptions(
  chatType: TelegramChat["type"],
  replyTo: number | undefined,
  threadId: number | null,
): TelegramMessageOptions {
  return {
    ...(chatType === "private" || replyTo === undefined ? {} : { replyTo }),
    threadId,
  };
}
