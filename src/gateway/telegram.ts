import type {
  JsonObject,
  JsonValue,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "../shared/types.ts";

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "TelegramApiError";
  }
}

export class TelegramClient {
  readonly #baseUrl: string;
  readonly #fileBaseUrl: string;

  constructor(token: string) {
    this.#baseUrl = `https://api.telegram.org/bot${token}`;
    this.#fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  async call<T>(method: string, body: JsonObject = {}): Promise<T> {
    const response = await fetch(`${this.#baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new TelegramApiError(
        method,
        payload.error_code ?? response.status,
        payload.description ?? response.statusText,
      );
    }
    return payload.result;
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe");
  }

  getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: [
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "business_connection",
        "business_message",
        "edited_business_message",
        "deleted_business_messages",
        "guest_message",
        "message_reaction",
        "message_reaction_count",
        "inline_query",
        "chosen_inline_result",
        "callback_query",
        "shipping_query",
        "pre_checkout_query",
        "purchased_paid_media",
        "poll",
        "poll_answer",
        "my_chat_member",
        "chat_member",
        "chat_join_request",
        "chat_boost",
        "removed_chat_boost",
        "managed_bot",
        "subscription",
        "stopped_message_generation",
      ],
    });
  }

  async sendRich(
    chatId: number,
    markdown: string,
    options: { replyTo?: number; threadId?: number | null } = {},
  ): Promise<TelegramMessage> {
    const body: JsonObject = {
      chat_id: chatId,
      rich_message: { markdown: markdown.slice(0, 32_768) },
    };
    if (options.replyTo !== undefined) {
      body.reply_parameters = { message_id: options.replyTo, allow_sending_without_reply: true };
    }
    if (options.threadId !== undefined && options.threadId !== null) {
      body.message_thread_id = options.threadId;
    }
    try {
      return await this.call<TelegramMessage>("sendRichMessage", body);
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.errorCode >= 500) {
        throw error;
      }
      const fallback: JsonObject = {
        chat_id: chatId,
        text: markdown.slice(0, 4_096),
      };
      if (options.replyTo !== undefined) {
        fallback.reply_parameters = {
          message_id: options.replyTo,
          allow_sending_without_reply: true,
        };
      }
      if (options.threadId !== undefined && options.threadId !== null) {
        fallback.message_thread_id = options.threadId;
      }
      return await this.call<TelegramMessage>("sendMessage", fallback);
    }
  }

  sendRichDraft(
    chatId: number,
    draftId: number,
    markdown: string,
    threadId: number | null,
  ): Promise<boolean> {
    return this.call<boolean>("sendRichMessageDraft", {
      chat_id: chatId,
      draft_id: draftId,
      rich_message: { markdown: markdown.slice(0, 32_768) },
      ...(threadId === null ? {} : { message_thread_id: threadId }),
    });
  }

  sendThinking(
    chatId: number,
    html: string,
    options: { replyTo: number; threadId: number | null },
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: html.slice(0, 4_096),
      parse_mode: "HTML",
      reply_parameters: {
        message_id: options.replyTo,
        allow_sending_without_reply: true,
      },
      ...(options.threadId === null ? {} : { message_thread_id: options.threadId }),
    });
  }

  async editThinking(chatId: number, messageId: number, html: string): Promise<void> {
    try {
      await this.call<TelegramMessage>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: html.slice(0, 4_096),
        parse_mode: "HTML",
      });
    } catch (error) {
      if (error instanceof TelegramApiError && error.message.includes("message is not modified")) {
        return;
      }
      throw error;
    }
  }

  async editRich(chatId: number, messageId: number, markdown: string): Promise<TelegramMessage> {
    try {
      return await this.call<TelegramMessage>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        rich_message: { markdown: markdown.slice(0, 32_768) },
      });
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.errorCode >= 500) {
        throw error;
      }
      return await this.call<TelegramMessage>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: markdown.slice(0, 4_096),
      });
    }
  }

  setCommands(): Promise<boolean> {
    return this.call<boolean>("setMyCommands", {
      commands: [
        { command: "start", description: "Как обратиться к Loylex" },
        { command: "help", description: "Возможности и синтаксис" },
      ] as JsonValue[],
    });
  }

  async download(fileId: string): Promise<Response> {
    const file = await this.call<{ file_path: string }>("getFile", { file_id: fileId });
    const response = await fetch(`${this.#fileBaseUrl}/${file.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Telegram file download failed with ${response.status}`);
    }
    return response;
  }

  async sendDocument(
    chatId: number,
    file: Blob,
    filename: string,
    caption: string | null,
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", file, filename);
    if (caption) {
      form.set("caption", caption.slice(0, 1_024));
    }
    const response = await fetch(`${this.#baseUrl}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const payload = (await response.json()) as TelegramResponse<TelegramMessage>;
    if (!response.ok || !payload.ok || !payload.result) {
      throw new TelegramApiError(
        "sendDocument",
        payload.error_code ?? response.status,
        payload.description ?? response.statusText,
      );
    }
    return payload.result;
  }
}
