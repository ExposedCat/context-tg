import { createDebug } from "@grammyjs/debug";
import type { Context } from "../bot.ts";
import { prepareProactiveAgentResponse } from "./chat.ts";
import { preparePeriodicTroll } from "./trolling.ts";

const logError = createDebug("app:automatic-responses:error");

export async function safelyMaybeSendAutomaticResponse(
  ctx: Context,
  message: Parameters<typeof prepareProactiveAgentResponse>[1],
  sender: Parameters<typeof preparePeriodicTroll>[2],
  chatId: number,
): Promise<void> {
  const responses: Array<() => Promise<void>> = [];
  // Advance both counters before selecting a response or spending credits.
  for (const prepare of [
    () => preparePeriodicTroll(ctx, message, sender, chatId),
    () => prepareProactiveAgentResponse(ctx, message, chatId),
  ]) {
    try {
      const respond = await prepare();
      if (respond) responses.push(respond);
    } catch (error) {
      logError("Failed to check automatic response trigger", { error });
    }
  }

  if (responses.length === 0) return;
  const respond =
    responses.length === 1
      ? responses[0]
      : responses[Math.floor(Math.random() * responses.length)];
  try {
    // A rejected troll or failed response does not run the other candidate.
    await respond();
  } catch (error) {
    logError("Failed to send automatic response", { error });
  }
}
