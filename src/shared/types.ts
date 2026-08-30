export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string;

export type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
};

export type TelegramChat = {
  id: number;
  type: "channel" | "group" | "private" | "supergroup";
  title?: string;
  username?: string;
};

export type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  date: number;
  edit_date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  text?: string;
  caption?: string;
  media_group_id?: string;
  reply_to_message?: TelegramMessage;
  photo?: JsonValue[];
  document?: JsonObject;
  audio?: JsonObject;
  video?: JsonObject;
  voice?: JsonObject;
  animation?: JsonObject;
  [key: string]: unknown;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  [key: string]: unknown;
};

export type AgentContextMode = "full" | "delta";

export type AgentJob = {
  id: number;
  updateId: number;
  chatId: number;
  chatType: TelegramChat["type"];
  messageId: number;
  messageThreadId: number | null;
  userId: number | null;
  prompt: string;
  resumeThreadId: string | null;
  context: string;
  contextMode: AgentContextMode;
  replyContext?: string | null;
  attachments: JsonValue[];
};

export type AgentEvent = {
  kind: "command" | "commentary" | "reasoning" | "status";
  text: string;
  threadId?: string;
};

export type AgentCompletion = {
  answer: string;
  threadId: string;
};

export type WorkerRegistration = {
  generation: number;
  state: "active" | "draining";
};
