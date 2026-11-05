import { createDebug } from "@grammyjs/debug";
import type { Api } from "grammy";
import { escapeHtml } from "../utils/text.ts";
import {
  type CalendarApi,
  type ChatCalendarTable,
  getCalendarMcpEnabled,
  getChatCalendars,
} from "./calendar-settings.ts";
import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";
import {
  CalendarApiError,
  type CalendarEvent,
  type CalendarEventsPage,
  getGoogleCalendarApi,
} from "./google-calendar.ts";

const logError = createDebug("app:calendar-watch:error");
let running = false;
let timer: ReturnType<typeof setInterval> | undefined;

async function fetchChanges(
  api: CalendarApi,
  calendarId: string,
  syncToken?: string,
  signal?: AbortSignal,
) {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await api.request<CalendarEventsPage>(calendarId, "/events", {
      signal,
      query: {
        showDeleted: "true",
        maxResults: "2500",
        ...(syncToken ? { syncToken } : {}),
        ...(pageToken ? { pageToken } : {}),
      },
    });
    // Baseline pages need no event storage. Keep notification payloads bounded.
    if (syncToken)
      events.push(
        ...(page.items ?? []).slice(0, Math.max(0, 100 - events.length)),
      );
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken;
  } while (pageToken);
  if (!nextSyncToken)
    throw new Error("Google did not return a calendar sync token.");
  return { events, nextSyncToken };
}

export async function watchCalendar(
  database: Database,
  binding: ChatCalendarTable,
  threadId: number | undefined,
  api: CalendarApi,
  options: { signal?: AbortSignal; authorize?: () => Promise<unknown> } = {},
) {
  const baseline = await fetchChanges(
    api,
    binding.calendar_id,
    undefined,
    options.signal,
  );
  options.signal?.throwIfAborted();
  await options.authorize?.();
  const row = {
    chat_id: binding.chat_id,
    calendar_id: binding.calendar_id,
    verification_id: binding.verification_id,
    registration_id: crypto.randomUUID(),
    thread_id: threadId ?? null,
    enabled: 1,
    sync_token: baseline.nextSyncToken,
    last_polled_at: Date.now(),
  };
  await database
    .insertInto("calendar_watches")
    .values(row)
    .onConflict((c) => c.columns(["chat_id", "calendar_id"]).doUpdateSet(row))
    .execute();
  return { watching: true, calendar: binding.name, intervalSeconds: 60 };
}

export async function unwatchCalendar(
  database: Database,
  chatId: number,
  calendarId: string,
) {
  await database
    .updateTable("calendar_watches")
    .set({ enabled: 0 })
    .where("chat_id", "=", chatId)
    .where("calendar_id", "=", calendarId)
    .execute();
  return { watching: false };
}

export async function pollCalendarWatches(
  database: Database,
  telegram: Pick<Api, "sendRichMessage">,
  suppliedApi?: CalendarApi,
) {
  if (running) return;
  running = true;
  try {
    const watches = await database
      .selectFrom("calendar_watches")
      .selectAll()
      .where("enabled", "=", 1)
      .execute();
    if (!watches.length) return;
    const api = suppliedApi ?? (await getGoogleCalendarApi());
    for (const watch of watches) {
      try {
        if (!(await getCalendarMcpEnabled(database, watch.chat_id))) continue;
        const binding = (await getChatCalendars(database, watch.chat_id)).find(
          (item) => item.calendar_id === watch.calendar_id,
        );
        if (!binding || binding.verification_id !== watch.verification_id) {
          await unwatchCalendar(database, watch.chat_id, watch.calendar_id);
          continue;
        }
        const signal = AbortSignal.timeout(55_000);
        let changes: Awaited<ReturnType<typeof fetchChanges>>;
        try {
          changes = await fetchChanges(
            api,
            watch.calendar_id,
            watch.sync_token ?? undefined,
            signal,
          );
        } catch (error) {
          if (!(error instanceof CalendarApiError) || error.status !== 410)
            throw error;
          // Expired Google tokens require a new baseline, never a replay of all history.
          changes = await fetchChanges(
            api,
            watch.calendar_id,
            undefined,
            signal,
          );
        }
        const events = changes.events.filter(
          (event) => !event.summary?.startsWith("Telegram Integration #"),
        );
        // Recheck after network I/O so disable/unlink stops delivery too.
        const stillLinked = (
          await getChatCalendars(database, watch.chat_id)
        ).some(
          (item) =>
            item.calendar_id === watch.calendar_id &&
            item.verification_id === watch.verification_id,
        );
        const currentWatch = await database
          .selectFrom("calendar_watches")
          .selectAll()
          .where("chat_id", "=", watch.chat_id)
          .where("calendar_id", "=", watch.calendar_id)
          .executeTakeFirst();
        if (
          !stillLinked ||
          !currentWatch?.enabled ||
          currentWatch.sync_token !== watch.sync_token ||
          currentWatch.registration_id !== watch.registration_id ||
          currentWatch.verification_id !== watch.verification_id ||
          !(await getCalendarMcpEnabled(database, watch.chat_id))
        )
          continue;
        if (events.length) {
          const items = events
            .slice(0, 10)
            .map(
              (event) =>
                `<li>${event.status === "cancelled" ? "Cancelled" : "Updated"}: ${escapeHtml(event.summary ?? "Event")}${event.start ? ` — ${escapeHtml(event.start.date ?? event.start.dateTime ?? "")}` : ""}</li>`,
            )
            .join("");
          await telegram.sendRichMessage(
            watch.chat_id,
            {
              html: `<h3>${escapeHtml(binding.name)}</h3><p>Calendar changes</p><ul>${items}</ul>${events.length > 10 ? "<p>More events changed. Ask the agent for the updated schedule.</p>" : ""}`,
              skip_entity_detection: true,
            },
            watch.thread_id === null
              ? {}
              : { message_thread_id: watch.thread_id },
          );
        }
        await database
          .updateTable("calendar_watches")
          .set({
            sync_token: changes.nextSyncToken,
            last_polled_at: Date.now(),
          })
          .where("chat_id", "=", watch.chat_id)
          .where("calendar_id", "=", watch.calendar_id)
          .where("verification_id", "=", watch.verification_id)
          .where("registration_id", "=", watch.registration_id)
          .where("enabled", "=", 1)
          .where("sync_token", "is", watch.sync_token)
          .execute();
      } catch (error) {
        logError("Calendar watch failed", { chatId: watch.chat_id, error });
      }
    }
  } finally {
    running = false;
  }
}

export function startCalendarWatchDispatcher(
  database: Database,
  telegram: Api,
) {
  if (!APP_ENV.GOOGLE_CALENDAR_CREDENTIALS || timer) return;
  timer = setInterval(() => {
    void pollCalendarWatches(database, telegram).catch((error) =>
      logError("Calendar watcher failed", { error }),
    );
  }, 60_000);
  timer.unref();
}
