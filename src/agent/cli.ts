import { basename } from "node:path";
import { loadAgentConfig } from "./config.ts";
import { scheduleSupervisorOperation, supervisorStatus } from "./supervisor.ts";

const config = loadAgentConfig();
const [command, ...arguments_] = process.argv.slice(2);

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
    const response = await request(`/v1/archive/search?q=${encodeURIComponent(query)}${chat}`);
    console.log(JSON.stringify(await response.json(), null, 2));
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
  throw new Error("Usage: loylex <status|search|send|media|upload|system>");
}

await run();
