import { strictEqual } from "node:assert";
import type { Context } from "../bot.ts";

const TEST_ENV = {
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  KEENABLE_API_KEY: "test",
  LLM_TEMPERATURE: "0.2",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test-embedding",
  QDRANT_URL: "https://qdrant.test",
} as const;

for (const [name, value] of Object.entries(TEST_ENV)) {
  Deno.env.set(name, value);
}

const [{ canConfigureChat }, { formatConfigureMenu }] = await Promise.all([
  import("./authorization.ts"),
  import("./state.ts"),
]);

type ChatType = "group" | "private" | "supergroup";
type MemberStatus = "administrator" | "creator" | "member";

function createContext(
  userId: number,
  chatType: ChatType,
  memberStatus: MemberStatus,
) {
  let getChatMemberCalls = 0;
  const ctx = {
    from: { id: userId },
    chat: { id: chatType === "private" ? userId : -100, type: chatType },
    api: {
      getChatMember: () => {
        getChatMemberCalls++;
        return Promise.resolve({ status: memberStatus });
      },
    },
  } as unknown as Context;

  return { ctx, getChatMemberCalls: () => getChatMemberCalls };
}

Deno.test("bot admin can configure without a Telegram membership lookup", async () => {
  const mock = createContext(1, "private", "member");

  strictEqual(await canConfigureChat(mock.ctx), true);
  strictEqual(mock.getChatMemberCalls(), 0);
});

Deno.test("Telegram group administrators and owners can configure", async () => {
  for (const status of ["administrator", "creator"] as const) {
    const mock = createContext(2, "supergroup", status);

    strictEqual(await canConfigureChat(mock.ctx), true);
    strictEqual(mock.getChatMemberCalls(), 1);
  }
});

Deno.test("ordinary members and non-admin private users cannot configure", async () => {
  const member = createContext(2, "group", "member");
  const privateUser = createContext(2, "private", "administrator");

  strictEqual(await canConfigureChat(member.ctx), false);
  strictEqual(member.getChatMemberCalls(), 1);
  strictEqual(await canConfigureChat(privateUser.ctx), false);
  strictEqual(privateUser.getChatMemberCalls(), 0);
});

Deno.test("configure menu only shows owner-only commands to the bot admin", () => {
  const translate = ((key: string) =>
    key === "settings-configure-menu-admin"
      ? "Models /model\nDebug /debug"
      : "") as Context["t"];

  strictEqual(
    formatConfigureMenu(translate, "configure", true).includes("/model"),
    true,
  );
  strictEqual(
    formatConfigureMenu(translate, "configure", true).includes("/debug"),
    true,
  );
  strictEqual(
    formatConfigureMenu(translate, "configure", false).includes("/model"),
    false,
  );
  strictEqual(
    formatConfigureMenu(translate, "configure", false).includes("/debug"),
    false,
  );
});
