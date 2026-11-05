import { afterAll, test } from "bun:test";
import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { I18n } from "@grammyjs/i18n";
import { Bot } from "grammy";
import type { Context } from "../bot.ts";
import type { CalendarToolName } from "./calendar-mcp.ts";
import type { CalendarChallengeTable } from "./calendar-settings.ts";
import type { CalendarEvent } from "./google-calendar.ts";

const directory = mkdtempSync(join(tmpdir(), "context-calendar-test-"));
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const email = "calendar-agent@project.iam.gserviceaccount.com";
const credentialPath = join(directory, "service-account.json");
writeFileSync(
  credentialPath,
  JSON.stringify({
    type: "service_account",
    client_email: email,
    private_key: privateKey,
  }),
);
Bun.env.GOOGLE_CALENDAR_CREDENTIALS = credentialPath;
Bun.env.LLM_STREAMING = "false";
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const { initDatabase } = await import("./database.ts");
const {
  beginCalendarSetup,
  getCalendarChallenge,
  getChatCalendar,
  verifyCalendarSetup,
  migrateCalendars,
} = await import("./calendar-settings.ts");
const {
  calendarDate,
  CALENDAR_SCOPES,
  GoogleCalendarApi,
  getGoogleCalendarApi,
} = await import("./google-calendar.ts");
const {
  getCalendarMcpEnabled,
  setCalendarMcpEnabled,
  setFinanceMcpEnabled,
  getFinanceMcpEnabled,
  migrateUserSettings,
} = await import("./user-settings.ts");
const { connectCalendarMcp } = await import("./calendar-mcp.ts");
const { calendarComposer } = await import("./calendar.ts");
const { configureComposer } = await import("./configure.ts");

const calendarId = "owner@example.com";
const timeZone = "Pacific/Kiritimati";

function fixture() {
  const originalFetch = globalThis.fetch;
  const calls: {
    calendarId: string;
    resource: string;
    method: string;
    body?: Record<string, unknown>;
    headers: Headers;
    query: URLSearchParams;
  }[] = [];
  const tokenClaims: Record<string, unknown>[] = [];
  const state = {
    events: [] as CalendarEvent[],
    pages: false,
    writable: true,
    apiStatus: 200,
    tokenStatus: 200,
    current: {
      id: "event123",
      summary: "Original",
      description: "Keep me",
      location: "Keep location",
      etag: '"v1"',
      start: { dateTime: "2026-11-05T10:00:00+14:00" },
      end: { dateTime: "2026-11-05T11:00:00+14:00" },
    } as CalendarEvent,
    llm: undefined as
      | ((body: Record<string, unknown>) => Response | Promise<Response>)
      | undefined,
  };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      const params = new URLSearchParams(String(init?.body));
      const assertion = params.get("assertion");
      ok(assertion);
      tokenClaims.push(
        JSON.parse(
          Buffer.from(assertion.split(".")[1], "base64url").toString(),
        ),
      );
      return state.tokenStatus === 200
        ? Response.json({
            access_token: "test-calendar-access-token",
            expires_in: 3600,
            token_type: "Bearer",
          })
        : Response.json(
            {
              error: "invalid_grant",
              error_description: "PRIVATE_AUTH_DETAILS",
            },
            { status: state.tokenStatus },
          );
    }
    if (url.hostname === "llm.test" && state.llm)
      return state.llm(JSON.parse(String(init?.body)));
    strictEqual(
      url.hostname,
      "www.googleapis.com",
      `Unexpected network request: ${url.origin}`,
    );
    const path = url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)(.*)$/);
    ok(path);
    const headers = new Headers(init?.headers);
    strictEqual(
      headers.get("Authorization"),
      "Bearer test-calendar-access-token",
    );
    const call = {
      calendarId: decodeURIComponent(path[1]),
      resource: path[2],
      method: init?.method ?? "GET",
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined,
      headers,
      query: url.searchParams,
    };
    calls.push(call);
    if (state.apiStatus !== 200)
      return Response.json(
        { error: "PRIVATE_API_DETAILS" },
        { status: state.apiStatus },
      );
    if (!call.resource)
      return Response.json({
        id: call.calendarId,
        summary: "Team <Calendar>",
        timeZone,
      });
    if (call.resource === "/acl")
      return Response.json({
        items: [
          {
            scope: { type: "user", value: email },
            role: state.writable ? "writer" : "reader",
          },
        ],
      });
    if (call.resource === "/events" && call.method === "GET") {
      if (state.pages && !url.searchParams.has("pageToken"))
        return Response.json({ items: [], nextPageToken: "second" });
      return Response.json({ items: state.events });
    }
    if (call.resource === "/events" && call.method === "POST")
      return Response.json({
        ...call.body,
        htmlLink: "https://calendar.google.com/event",
      });
    if (call.resource.startsWith("/events/") && call.method === "GET")
      return Response.json(state.current);
    if (call.resource.startsWith("/events/") && call.method === "PATCH")
      return Response.json({ ...state.current, ...call.body, etag: '"v2"' });
    throw new Error("Unexpected Calendar operation");
  }) as typeof fetch;
  return {
    state,
    calls,
    tokenClaims,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function verificationEvent(challenge: CalendarChallengeTable): CalendarEvent {
  const nextDay = new Date(`${challenge.day}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return {
    id: "verify123",
    summary: challenge.title,
    status: "confirmed",
    created: new Date().toISOString(),
    organizer: { self: true },
    creator: { email: "owner@example.com" },
    start: { date: challenge.day },
    end: { date: nextDay.toISOString().slice(0, 10) },
  };
}

test("Calendar service-account auth uses narrow scopes, refreshes tokens, encodes IDs and sanitizes failures", async () => {
  const mock = fixture();
  try {
    const api = new GoogleCalendarApi(email, privateKey);
    await api.metadata("calendar+name@group.calendar.google.com");
    await api.metadata(calendarId);
    strictEqual(mock.tokenClaims.length, 1);
    strictEqual(mock.tokenClaims[0].iss, email);
    strictEqual(mock.tokenClaims[0].sub, undefined);
    deepStrictEqual(
      String(mock.tokenClaims[0].scope).split(" "),
      CALENDAR_SCOPES,
    );
    strictEqual(
      mock.calls[0].calendarId,
      "calendar+name@group.calendar.google.com",
    );
    await api.assertWritable(calendarId);
    mock.state.writable = false;
    await rejects(api.assertWritable(calendarId), /Make changes to events/);
    mock.state.apiStatus = 403;
    await rejects(api.metadata(calendarId), /Calendar unavailable/);
    mock.state.apiStatus = 412;
    await rejects(api.metadata(calendarId), /event changed/);
    mock.state.tokenStatus = 400;
    await rejects(
      new GoogleCalendarApi(email, privateKey).metadata(calendarId),
      (error: Error) => {
        match(error.message, /authentication failed/);
        ok(!error.message.includes("PRIVATE_AUTH_DETAILS"));
        return true;
      },
    );
    const controller = new AbortController();
    controller.abort();
    const count = mock.calls.length;
    await rejects(api.metadata(calendarId, controller.signal), {
      name: "AbortError",
    });
    strictEqual(mock.calls.length, count);
  } finally {
    mock.restore();
  }
});

test("Calendar verification rejects invitation spoofing, stale/replayed events, wrong users, expiry and replaced challenges", async () => {
  const mock = fixture();
  const database = await initDatabase()();
  try {
    const api = await getGoogleCalendarApi();
    await rejects(
      beginCalendarSetup(database, -100, 2, "https://calendar.google.com", api),
      /Calendar ID/,
    );
    const challenge = await beginCalendarSetup(
      database,
      -100,
      2,
      calendarId,
      api,
    );
    strictEqual(challenge.day, calendarDate(new Date(), timeZone));
    ok(challenge.title.startsWith("Telegram Integration #"));
    strictEqual(challenge.token.length, 32);
    await rejects(
      verifyCalendarSetup(database, -100, 3, challenge.token, api),
      /another setup/,
    );
    await rejects(
      verifyCalendarSetup(database, -200, 2, challenge.token, api),
      /another setup/,
    );
    const valid = verificationEvent(challenge);
    const invalid: Partial<CalendarEvent>[] = [
      { organizer: { self: false } },
      { organizer: undefined },
      { summary: `${challenge.title}x` },
      { status: "cancelled" },
      { created: new Date(challenge.created_at - 1000).toISOString() },
      { created: new Date(Date.now() + 60_000).toISOString() },
      { creator: { email } },
      { creator: undefined },
      { attendees: [{ email: "guest@example.com" }] },
      { recurrence: ["RRULE:FREQ=DAILY"] },
      { recurringEventId: "series" },
      { start: { date: "2000-01-01" } },
    ];
    for (const patch of invalid) {
      mock.state.events = [{ ...valid, ...patch }];
      await rejects(
        verifyCalendarSetup(database, -100, 2, challenge.token, api),
        /not found/,
      );
      strictEqual(await getChatCalendar(database, -100), undefined);
    }
    mock.state.events = [valid];
    await rejects(
      verifyCalendarSetup(
        database,
        -100,
        2,
        challenge.token,
        api,
        challenge.expires_at,
      ),
      /expired/,
    );
    mock.state.pages = true;
    const verified = await verifyCalendarSetup(
      database,
      -100,
      2,
      challenge.token,
      api,
    );
    strictEqual(verified.calendar_id, calendarId);
    strictEqual(verified.linked_by, 2);
    strictEqual(verified.verification_id, challenge.token);
    strictEqual(
      (await verifyCalendarSetup(database, -100, 2, challenge.token, api))
        .verified_at,
      verified.verified_at,
    );
    strictEqual(
      mock.calls.filter((call) => call.method !== "GET").length,
      0,
      "verification must never create or delete events",
    );
    await migrateCalendars(database);
    strictEqual(
      (await getChatCalendar(database, -100))?.calendar_id,
      calendarId,
    );
    const replacement = await beginCalendarSetup(
      database,
      -100,
      2,
      "replacement@example.com",
      api,
    );
    await rejects(
      verifyCalendarSetup(database, -100, 2, challenge.token, api),
      /another setup/,
    );
    strictEqual(
      (await getChatCalendar(database, -100))?.calendar_id,
      calendarId,
    );
    mock.state.events = [verificationEvent(replacement)];
    const results = await Promise.all([
      verifyCalendarSetup(database, -100, 2, replacement.token, api),
      verifyCalendarSetup(database, -100, 2, replacement.token, api),
    ]);
    strictEqual(results[0].verified_at, results[1].verified_at);
    strictEqual(
      (await getChatCalendar(database, -100))?.calendar_id,
      "replacement@example.com",
    );
  } finally {
    mock.restore();
    await database.destroy();
  }
});

test("Calendar MCP binds tools to the verified chat and opted-in user, preserves edits and invalidates stale sessions", async () => {
  const mock = fixture();
  const database = await initDatabase()();
  let mcp: Awaited<ReturnType<typeof connectCalendarMcp>>;
  try {
    const api = await getGoogleCalendarApi();
    const context = { chatId: -100, userId: 2, messageId: 1 };
    strictEqual(await connectCalendarMcp(database, context), undefined);
    await setCalendarMcpEnabled(database, 2, true);
    strictEqual(await connectCalendarMcp(database, context), undefined);
    const challenge = await beginCalendarSetup(
      database,
      -100,
      2,
      calendarId,
      api,
    );
    mock.state.events = [verificationEvent(challenge)];
    await verifyCalendarSetup(database, -100, 2, challenge.token, api);
    strictEqual(
      await connectCalendarMcp(database, { ...context, userId: 3 }),
      undefined,
    );
    strictEqual(
      await connectCalendarMcp(database, { ...context, chatId: -200 }),
      undefined,
    );
    strictEqual(
      await connectCalendarMcp(database, { ...context, userId: undefined }),
      undefined,
    );
    mcp = await connectCalendarMcp(database, context);
    ok(mcp);
    deepStrictEqual(
      mcp.definitions.map((tool) => tool.name),
      [
        "calendar_get_calendar",
        "calendar_list_events",
        "calendar_get_event",
        "calendar_create_event",
        "calendar_update_event",
      ],
    );
    for (const definition of mcp.definitions)
      ok(!JSON.stringify(definition.parameters).includes("calendarId"));
    const run = async (
      name: CalendarToolName,
      args: Record<string, unknown>,
    ) => {
      const runner = mcp?.runners.get(name);
      ok(runner);
      return runner(args, context);
    };
    const count = mock.calls.length;
    await rejects(
      run("calendar_get_calendar", { calendarId: "victim@example.com" }),
      /Invalid Calendar MCP arguments/,
    );
    strictEqual(mock.calls.length, count);
    await run("calendar_get_calendar", {});
    await run("calendar_list_events", {
      timeMin: "2026-11-05T00:00:00Z",
      timeMax: "2026-11-06T00:00:00Z",
    });
    await rejects(
      run("calendar_list_events", {
        timeMin: "tomorrow",
        timeMax: "next week",
      }),
      /RFC3339/,
    );
    await run("calendar_create_event", {
      summary: "Lunch",
      start: { date: "2026-11-05" },
      end: { date: "2026-11-06" },
    });
    const creation = mock.calls.at(-1);
    strictEqual(creation?.method, "POST");
    match(String(creation?.body?.id), /^[a-f0-9]{32}$/);
    await rejects(
      run("calendar_create_event", {
        summary: "Telegram Integration #fake",
        start: { date: "2026-11-05" },
        end: { date: "2026-11-06" },
      }),
      /manually/,
    );
    await rejects(
      run("calendar_create_event", {
        summary: "Bad date",
        start: { date: "2026-02-30" },
        end: { date: "2026-03-05" },
      }),
      /Invalid all-day date/,
    );
    await rejects(
      run("calendar_create_event", {
        summary: "Bad time",
        start: { date: "2026-11-05" },
        end: { date: "2026-11-04" },
      }),
      /end after/,
    );
    await run("calendar_update_event", {
      eventId: "event123",
      summary: "Changed",
    });
    const edit = mock.calls.at(-1);
    strictEqual(edit?.method, "PATCH");
    strictEqual(edit?.headers.get("If-Match"), '"v1"');
    deepStrictEqual(edit?.body, { summary: "Changed" });
    ok(mock.calls.every((call) => call.calendarId === calendarId));
    await setCalendarMcpEnabled(database, 2, false);
    await rejects(
      run("calendar_get_event", { eventId: "event123" }),
      /disabled/,
    );
    await setCalendarMcpEnabled(database, 2, true);
    await database
      .updateTable("chat_calendars")
      .set({ verification_id: "different" })
      .where("chat_id", "=", -100)
      .execute();
    await rejects(
      run("calendar_get_event", { eventId: "event123" }),
      /calendar changed/,
    );
  } finally {
    await mcp?.close();
    mock.restore();
    await database.destroy();
  }
});

test("Calendar /settings and setup commands enforce actor/admin/message binding and replace Verify with success", async () => {
  const mock = fixture();
  const database = await initDatabase()();
  try {
    const bot = new Bot<Context>("123:test", {
      botInfo: {
        id: 123,
        is_bot: true,
        first_name: "test",
        username: "test_bot",
        can_join_groups: true,
        can_read_all_group_messages: true,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        can_manage_bots: false,
        supports_join_request_queries: false,
      },
    });
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const chat = { id: -100, type: "supergroup" as const, title: "test" };
    const from = (id: number) => ({ id, is_bot: false, first_name: "user" });
    let isAdmin = true;
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return Promise.resolve({
        ok: true,
        result:
          method === "getChatMember"
            ? {
                status:
                  (payload as { user_id: number }).user_id === 2 && isAdmin
                    ? "administrator"
                    : "member",
              }
            : method === "sendRichMessage"
              ? { message_id: 0, ephemeral_message_id: 42, chat, date: 1 }
              : true,
      }) as ReturnType<typeof _prev>;
    });
    bot.use((ctx, next) => {
      ctx.database = database;
      return next();
    });
    bot.use(new I18n<Context>({ directory: "locales", defaultLocale: "en" }));
    bot.use(calendarComposer);
    bot.use(configureComposer);
    let updateId = 0;
    const command = async (text: string, user = 2) => {
      calls.length = 0;
      await bot.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: 1,
          chat,
          from: from(user),
          text,
          entities: [
            {
              type: "bot_command",
              offset: 0,
              length: text.split(" ")[0].length,
            },
          ],
        },
      });
    };
    const click = async (data: string, user = 2, messageId = 42) => {
      calls.length = 0;
      await bot.handleUpdate({
        update_id: ++updateId,
        callback_query: {
          id: String(updateId),
          from: from(user),
          chat_instance: "test",
          data,
          message: {
            message_id: 0,
            ephemeral_message_id: messageId,
            receiver_user: from(user),
            date: 1,
            chat,
            text: "setup",
          },
        },
      });
    };
    const html = () =>
      (
        (
          calls.find(
            (call) =>
              call.method === "sendRichMessage" ||
              call.method === "editEphemeralMessageText",
          )?.payload.rich_message as { html?: string }
        )?.html ?? ""
      ).replace(/[\u2068\u2069]/g, "");
    await command("/settings", 3);
    match(html(), /Calendar MCP.*cfg:calendar:3:on/);
    await click("cfg:calendar:2:on", 3);
    strictEqual(await getCalendarMcpEnabled(database, 2), false);
    await click("cfg:calendar:3:on", 3);
    strictEqual(await getCalendarMcpEnabled(database, 3), true);
    await command(`/calendar ${calendarId}`, 3);
    strictEqual(await getCalendarChallenge(database, chat.id), undefined);
    await command("/calendar");
    match(html(), /Integrate calendar/);
    await command(`/calendar ${calendarId}`);
    const challenge = await getCalendarChallenge(database, chat.id);
    ok(challenge);
    match(html(), /Telegram Integration #/);
    match(html(), /calverify:/);
    strictEqual(challenge.message_id, 42);
    deepStrictEqual(
      calls.find((call) => call.method === "sendRichMessage")?.payload
        .ephemeral_message_parameters,
      { receiver_user_id: 2 },
    );
    await click(`calverify:${challenge.token}`, 3);
    ok(
      calls.some(
        (call) =>
          call.method === "answerCallbackQuery" && call.payload.show_alert,
      ),
    );
    await click(`calverify:${challenge.token}`, 2, 99);
    strictEqual(await getChatCalendar(database, chat.id), undefined);
    isAdmin = false;
    await click(`calverify:${challenge.token}`);
    strictEqual(await getChatCalendar(database, chat.id), undefined);
    isAdmin = true;
    await click(`calverify:${challenge.token}`);
    match(html(), /not found/);
    mock.state.events = [verificationEvent(challenge)];
    await click(`calverify:${challenge.token}`);
    match(html(), /Calendar 'Team &lt;Calendar&gt;' was set up for this chat/);
    ok(!html().includes("tg-button"));
    ok(calls.some((call) => call.method === "editEphemeralMessageText"));
    strictEqual(
      (await getChatCalendar(database, chat.id))?.calendar_id,
      calendarId,
    );
    strictEqual(
      await getCalendarMcpEnabled(database, 2),
      false,
      "verification must not silently opt the user in",
    );
    await click("cfg:calendar:2:on");
    strictEqual(await getCalendarMcpEnabled(database, 2), true);
  } finally {
    mock.restore();
    await database.destroy();
  }
});

test("Calendar settings migration preserves legacy finance preferences and toggles remain independent", async () => {
  const database = await initDatabase()();
  try {
    await database.schema.dropTable("user_settings").execute();
    await database.schema
      .createTable("user_settings")
      .addColumn("user_id", "integer", (c) => c.primaryKey())
      .addColumn("finance_mcp_enabled", "integer", (c) =>
        c.notNull().defaultTo(0),
      )
      .execute();
    await database
      .insertInto("user_settings")
      .values({ user_id: 2, finance_mcp_enabled: 1 })
      .execute();
    await migrateUserSettings(database);
    await migrateUserSettings(database);
    strictEqual(await getFinanceMcpEnabled(database, 2), true);
    strictEqual(await getCalendarMcpEnabled(database, 2), false);
    await setCalendarMcpEnabled(database, 2, true);
    await setFinanceMcpEnabled(database, 2, false);
    strictEqual(await getCalendarMcpEnabled(database, 2), true);
    await setFinanceMcpEnabled(database, 2, true);
    await setCalendarMcpEnabled(database, 2, false);
    strictEqual(await getFinanceMcpEnabled(database, 2), true);
  } finally {
    await database.destroy();
  }
});

test("Calendar tools survive model follow-ups, obey the shared tool budget and cannot replay after opt-out", async () => {
  const mock = fixture();
  const database = await initDatabase()();
  const { requestLlm } = await import("./llm.ts");
  const { setLlmDeploymentName } = await import("./llm-deployments.ts");
  const { LlmToolBudget } = await import("./llm-budget.ts");
  try {
    const api = await getGoogleCalendarApi();
    const challenge = await beginCalendarSetup(
      database,
      -100,
      2,
      calendarId,
      api,
    );
    mock.state.events = [verificationEvent(challenge)];
    await verifyCalendarSetup(database, -100, 2, challenge.token, api);
    await setCalendarMcpEnabled(database, 2, true);
    setLlmDeploymentName("small", "test");
    const requests: Record<string, unknown>[] = [];
    let callCalendar = true;
    let disableDuringCall = false;
    mock.state.llm = async (body) => {
      requests.push(body);
      const output = callCalendar
        ? [
            {
              type: "function_call",
              id: "fc",
              call_id: `call_${requests.length}`,
              name: "calendar_get_calendar",
              arguments: "{}",
              status: "completed",
            },
          ]
        : [
            {
              type: "message",
              id: "msg",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Done.", annotations: [] },
              ],
            },
          ];
      callCalendar = false;
      if (disableDuringCall) {
        await setCalendarMcpEnabled(database, 2, false);
        disableDuringCall = false;
      }
      return Response.json({
        id: `resp_${requests.length}`,
        object: "response",
        created_at: 1,
        status: "completed",
        output,
        model: "test",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    };
    const options = {
      database,
      context: { chatId: -100, userId: 2, messageId: 1 },
    };
    const result = await requestLlm(
      "Read this chat's calendar",
      [],
      undefined,
      options,
    );
    deepStrictEqual(result.tools, ["calendar_get_calendar"]);
    strictEqual(result.tool_call_count, 1);
    strictEqual(requests.length, 2);
    deepStrictEqual(requests[0].tools, requests[1].tools);
    ok(JSON.stringify(requests[1].input).includes("Team <Calendar>"));
    ok(JSON.stringify(requests[0]).includes("<calendar_mcp>"));
    const before = mock.calls.length;
    callCalendar = true;
    disableDuringCall = true;
    const revoked = await requestLlm("Read calendar", [], undefined, options);
    strictEqual(mock.calls.length, before);
    ok(revoked.errors.some((error) => error.details.includes("disabled")));
    callCalendar = true;
    const disabled = await requestLlm("Read calendar", [], undefined, options);
    strictEqual(mock.calls.length, before);
    ok(disabled.errors.some((error) => error.details.includes("unavailable")));
    strictEqual(requests.at(-1)?.tools, undefined);
    await setCalendarMcpEnabled(database, 2, true);
    callCalendar = true;
    await requestLlm("Read calendar", [], undefined, {
      ...options,
      toolBudget: new LlmToolBudget(1),
    });
    strictEqual(
      requests.at(-1)?.tools,
      undefined,
      "exhausted wrap-up must omit all Calendar tools",
    );
    const withoutUser = {
      ...options,
      context: { ...options.context, userId: undefined },
    };
    await requestLlm("Read calendar", [], undefined, withoutUser);
    strictEqual(requests.at(-1)?.tools, undefined);
  } finally {
    mock.restore();
    await database.destroy();
  }
});
