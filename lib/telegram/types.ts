export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type TelegramMessage = {
  message_id: number;
  text?: string;
  voice?: TelegramVoice;
  reply_to_message?: TelegramMessageReference;
  chat: TelegramChat;
  from?: TelegramUser;
};

export type TelegramMessageReference = {
  message_id: number;
  text?: string;
  from?: TelegramUser;
};

export type TelegramVoice = {
  file_id: string;
  file_unique_id?: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
};

export type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
};

export type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
};
