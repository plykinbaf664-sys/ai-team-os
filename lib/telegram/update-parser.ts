import type { RootAgentRole } from "@/lib/agents/agent-registry";
import type {
  TelegramChat,
  TelegramMessage,
  TelegramMessageReference,
  TelegramUpdate,
  TelegramUser,
  TelegramVoice,
} from "./types";

export type ParsedTelegramAgentRequest = {
  role: RootAgentRole;
  text: string;
  replyToText?: string;
};

export type TelegramReplyAgentContext = {
  role: RootAgentRole;
  text: string;
};

export function parseSpokenAssistantRequest(transcript: string) {
  const match = transcript
    .trim()
    .match(/^(?:ассистент|assistant)(?:[\s,.;:!?—-]+([\s\S]+))?$/iu);

  if (!match) {
    return null;
  }

  return match[1]?.trim() || "Кратко объясни, чем ты можешь помочь.";
}

export function parseTelegramUpdate(value: unknown): TelegramUpdate | null {
  if (!isObject(value) || !isInteger(value.update_id)) {
    return null;
  }

  if (value.message === undefined) {
    return { update_id: value.update_id };
  }

  const message = parseTelegramMessage(value.message);

  if (!message) {
    return null;
  }

  return {
    update_id: value.update_id,
    message,
  };
}

export function parseTelegramAgentRequest(
  message: TelegramMessage,
  replyContext?: TelegramReplyAgentContext | null,
): ParsedTelegramAgentRequest | null {
  const text = message.text?.trim();

  if (!text) {
    return null;
  }

  const explicitRequest = parseExplicitAgentRequest(text);

  if (explicitRequest) {
    return explicitRequest;
  }

  if (replyContext) {
    return {
      role: replyContext.role,
      text,
      replyToText: replyContext.text,
    };
  }

  if (message.chat.type === "private") {
    return {
      role: "assistant",
      text,
    };
  }

  return null;
}

function parseExplicitAgentRequest(
  text: string,
): ParsedTelegramAgentRequest | null {
  const match = text.match(
    /^\/?(assistant|ассистент|project|проект)(?:@\w+)?(?:[\s,;:—-]+([\s\S]+))?$/iu,
  );

  if (!match) {
    return null;
  }

  const alias = match[1].toLowerCase();
  const role: RootAgentRole =
    alias === "assistant" || alias === "ассистент"
      ? "assistant"
      : "project";

  return {
    role,
    text:
      match[2]?.trim() ||
      `Представься и кратко объясни, чем может помочь ${role}.`,
  };
}

function parseTelegramMessage(value: unknown): TelegramMessage | null {
  if (
    !isObject(value) ||
    !isInteger(value.message_id) ||
    (value.text !== undefined && typeof value.text !== "string") ||
    (value.voice !== undefined && !isObject(value.voice))
  ) {
    return null;
  }

  const chat = parseTelegramChat(value.chat);

  if (!chat) {
    return null;
  }

  let from: TelegramUser | undefined;
  let voice: TelegramVoice | undefined;
  let replyToMessage: TelegramMessageReference | undefined;

  if (value.from !== undefined) {
    const parsedUser = parseTelegramUser(value.from);

    if (!parsedUser) {
      return null;
    }

    from = parsedUser;
  }

  if (value.voice !== undefined) {
    const parsedVoice = parseTelegramVoice(value.voice);

    if (!parsedVoice) {
      return null;
    }

    voice = parsedVoice;
  }

  if (value.reply_to_message !== undefined) {
    const parsedReply = parseTelegramMessageReference(value.reply_to_message);

    if (!parsedReply) {
      return null;
    }

    replyToMessage = parsedReply;
  }

  return {
    message_id: value.message_id,
    text: value.text,
    voice,
    reply_to_message: replyToMessage,
    chat,
    from,
  };
}

function parseTelegramMessageReference(
  value: unknown,
): TelegramMessageReference | null {
  if (
    !isObject(value) ||
    !isInteger(value.message_id) ||
    (value.text !== undefined && typeof value.text !== "string")
  ) {
    return null;
  }

  let from: TelegramUser | undefined;

  if (value.from !== undefined) {
    const parsedUser = parseTelegramUser(value.from);

    if (!parsedUser) {
      return null;
    }

    from = parsedUser;
  }

  return {
    message_id: value.message_id,
    text: value.text,
    from,
  };
}

function parseTelegramVoice(value: Record<string, unknown>): TelegramVoice | null {
  if (
    typeof value.file_id !== "string" ||
    !value.file_id ||
    !isNonNegativeInteger(value.duration) ||
    (value.file_unique_id !== undefined &&
      typeof value.file_unique_id !== "string") ||
    (value.mime_type !== undefined && typeof value.mime_type !== "string") ||
    (value.file_size !== undefined && !isNonNegativeInteger(value.file_size))
  ) {
    return null;
  }

  return {
    file_id: value.file_id,
    file_unique_id: value.file_unique_id,
    duration: value.duration,
    mime_type: value.mime_type,
    file_size: value.file_size,
  };
}

function parseTelegramChat(value: unknown): TelegramChat | null {
  if (
    !isObject(value) ||
    !isInteger(value.id) ||
    !isChatType(value.type) ||
    (value.title !== undefined && typeof value.title !== "string") ||
    (value.username !== undefined && typeof value.username !== "string")
  ) {
    return null;
  }

  return {
    id: value.id,
    type: value.type,
    title: value.title,
    username: value.username,
  };
}

function parseTelegramUser(value: unknown): TelegramUser | null {
  if (
    !isObject(value) ||
    !isInteger(value.id) ||
    typeof value.is_bot !== "boolean" ||
    (value.first_name !== undefined && typeof value.first_name !== "string") ||
    (value.username !== undefined && typeof value.username !== "string")
  ) {
    return null;
  }

  return {
    id: value.id,
    is_bot: value.is_bot,
    first_name: value.first_name,
    username: value.username,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isChatType(value: unknown): value is TelegramChat["type"] {
  return (
    value === "private" ||
    value === "group" ||
    value === "supergroup" ||
    value === "channel"
  );
}
