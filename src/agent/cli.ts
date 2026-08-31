import { basename } from "node:path";
import { type TelegramExport, telegramExportMessages } from "../shared/telegram-export.ts";
import { loadAgentConfig } from "./config.ts";
import { scheduleSupervisorOperation, supervisorStatus } from "./supervisor.ts";

const config = loadAgentConfig();
const [command, ...arguments_] = process.argv.slice(2);
const importBatchSize = 250;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(config.bridgeUrl + path, {
    ...init,
    headers: {
      authorization: `Bearer ${config.bridgeToken}`,
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Gateway ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function run(): Promise<void> {
  if (command === "system") {
    const [operation, scope = "all", delay = "15"] = arguments_;
    if (operation === "status") {
      console.log(JSON.stringify(await supervisorStatus(), null, 2));
      return;
    }
    if (operation !== "restart" && operation !== "deploy") {
      throw new Error(
        "Usage: loylex system <status|restart|deploy> [agent|gateway|all] [DELAY_SECONDS]",
      );
    }
    if (scope !== "agent" && scope !== "gateway" && scope !== "all") {
      throw new Error("System scope must be agent, gateway, or all");
    }
    const delaySeconds = Number.parseInt(delay, 10);
    if (!Number.isInteger(delaySeconds)) {
      throw new Error("DELAY_SECONDS must be an integer");
    }
    console.log(
      JSON.stringify(await scheduleSupervisorOperation(operation, scope, delaySeconds), null, 2),
    );
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(await (await request("/v1/status")).json(), null, 2));
    return;
  }
  if (command === "search") {
    const query = arguments_[0];
    if (!query) {
      throw new Error("Usage: loylex search QUERY [CHAT_ID]");
    }
    const chat = arguments_[1] ? `&chat=${encodeURIComponent(arguments_[1])}` : "";
    const limit = arguments_[2] ? `&limit=${encodeURIComponent(arguments_[2])}` : "";
    const response = await request(
      `/v1/archive/search?q=${encodeURIComponent(query)}${chat}${limit}`,
    );
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (command === "recent") {
    const [chatId, rawLimit = "500"] = arguments_;
    const parsedChatId = Number(chatId);
    const parsedLimit = Number.parseInt(rawLimit, 10);
    if (!chatId || !Number.isSafeInteger(parsedChatId) || !Number.isInteger(parsedLimit)) {
      throw new Error("Usage: loylex recent CHAT_ID [LIMIT]");
    }
    const response = await request(
      `/v1/archive/recent?chat=${encodeURIComponent(chatId)}&limit=${encodeURIComponent(String(parsedLimit))}`,
    );
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (command === "media-list") {
    const [chatId, rawLimit = "100"] = arguments_;
    const parsedChatId = Number(chatId);
    const parsedLimit = Number.parseInt(rawLimit, 10);
    if (!chatId || !Number.isSafeInteger(parsedChatId) || !Number.isInteger(parsedLimit)) {
      throw new Error("Usage: loylex media-list CHAT_ID [LIMIT]");
    }
    const response = await request(
      `/v1/archive/media?chat=${encodeURIComponent(chatId)}&limit=${encodeURIComponent(String(parsedLimit))}`,
    );
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (command === "message") {
    const [chatId, messageId] = arguments_;
    const parsedChatId = Number(chatId);
    const parsedMessageId = Number(messageId);
    if (
      !chatId ||
      !messageId ||
      !Number.isSafeInteger(parsedChatId) ||
      !Number.isSafeInteger(parsedMessageId)
    ) {
      throw new Error("Usage: loylex message CHAT_ID MESSAGE_ID");
    }
    const response = await request(
      `/v1/archive/message?chat=${encodeURIComponent(chatId)}&message=${encodeURIComponent(messageId)}`,
    );
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (command === "messages") {
    const [chatId, rawAfter = "", rawBefore = "", rawLimit = "100"] = arguments_;
    const parsedChatId = Number(chatId);
    const parsedAfter = rawAfter === "" ? null : Number(rawAfter);
    const parsedBefore = rawBefore === "" ? null : Number(rawBefore);
    const parsedLimit = Number.parseInt(rawLimit, 10);
    if (
      !chatId ||
      !Number.isSafeInteger(parsedChatId) ||
      (parsedAfter !== null && !Number.isSafeInteger(parsedAfter)) ||
      (parsedBefore !== null && !Number.isSafeInteger(parsedBefore)) ||
      !Number.isInteger(parsedLimit)
    ) {
      throw new Error(
        "Usage: loylex messages CHAT_ID [AFTER_MESSAGE_ID] [BEFORE_MESSAGE_ID] [LIMIT]",
      );
    }
    const after = parsedAfter === null ? "" : `&after=${encodeURIComponent(String(parsedAfter))}`;
    const before =
      parsedBefore === null ? "" : `&before=${encodeURIComponent(String(parsedBefore))}`;
    const response = await request(
      `/v1/archive/messages?chat=${encodeURIComponent(chatId)}${after}${before}&limit=${encodeURIComponent(String(parsedLimit))}`,
    );
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (command === "import") {
    const [path, rawChatId] = arguments_;
    if (!path) {
      throw new Error("Usage: loylex import RESULT_JSON [CHAT_ID]");
    }
    const exported = (await Bun.file(path).json()) as TelegramExport;
    const parsedChatId = rawChatId === undefined ? exported.id : Number(rawChatId);
    if (parsedChatId === undefined || !Number.isSafeInteger(parsedChatId)) {
      throw new Error("Telegram chat ID is missing; pass CHAT_ID");
    }
    if (!Array.isArray(exported.messages)) {
      throw new Error("Telegram export messages must be an array");
    }
    const messages = telegramExportMessages(exported, parsedChatId);
    let imported = 0;
    for (let index = 0; index < messages.length; index += importBatchSize) {
      const batch = messages.slice(index, index + importBatchSize);
      const response = await request("/v1/archive/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: batch }),
      });
      const result = (await response.json()) as { imported?: number };
      imported += result.imported ?? batch.length;
    }
    console.log(
      JSON.stringify({
        imported,
        chatId: parsedChatId,
        batches: Math.ceil(imported / importBatchSize),
      }),
    );
    return;
  }
  if (command === "send") {
    const [chatId, ...markdown] = arguments_;
    if (!chatId || markdown.length === 0) {
      throw new Error("Usage: loylex send CHAT_ID MARKDOWN");
    }
    const response = await request("/v1/telegram/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId: Number(chatId),
        markdown: markdown.join(" ").replaceAll("\\n", "\n"),
      }),
    });
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (command === "media") {
    const [fileId, output] = arguments_;
    if (!fileId || !output) {
      throw new Error("Usage: loylex media FILE_ID OUTPUT_PATH");
    }
    const response = await request(`/v1/media?file_id=${encodeURIComponent(fileId)}`);
    await Bun.write(output, response);
    console.log(output);
    return;
  }
  if (command === "upload") {
    const [chatId, path, ...caption] = arguments_;
    if (!chatId || !path) {
      throw new Error("Usage: loylex upload CHAT_ID FILE [CAPTION]");
    }
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("file", Bun.file(path), basename(path));
    if (caption.length > 0) {
      form.set("caption", caption.join(" "));
    }
    const response = await request("/v1/telegram/upload", { method: "POST", body: form });
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  throw new Error(
    "Usage: loylex <status|search|recent|media-list|message|messages|import|send|media|upload|system>",
  );
}

await run();
