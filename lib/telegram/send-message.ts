import {
  formatTelegramMessages,
  type TelegramFormattedMessage,
} from "./message-format";

type SendTelegramMessageInput = {
  chatId: number;
  text: string;
  replyToMessageId?: number;
};

type TelegramSendMessageResponse = {
  ok: boolean;
  description?: string;
  result?: {
    message_id?: number;
  };
};

export async function sendTelegramMessage({
  chatId,
  text,
  replyToMessageId,
}: SendTelegramMessageInput, fetchImplementation: typeof fetch = fetch) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }

  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const formattedMessages = formatTelegramMessages(text);
  if (!formattedMessages.length) {
    throw new Error("Telegram message is empty.");
  }
  const messageIds: number[] = [];

  for (const [index, formatted] of formattedMessages.entries()) {
    const messageId = await sendFormattedMessage({
      endpoint,
      chatId,
      formatted,
      replyToMessageId: index === 0 ? replyToMessageId : undefined,
      fetchImplementation,
    });
    messageIds.push(messageId);
  }

  return {
    messageId: messageIds.at(-1)!,
    messageIds,
  };
}

async function sendFormattedMessage({
  endpoint,
  chatId,
  formatted,
  replyToMessageId,
  fetchImplementation,
}: {
  endpoint: string;
  chatId: number;
  formatted: TelegramFormattedMessage;
  replyToMessageId?: number;
  fetchImplementation: typeof fetch;
}) {
  const response = await fetchImplementation(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: formatted.html,
      parse_mode: "HTML",
      reply_to_message_id: replyToMessageId,
      disable_web_page_preview: true,
    }),
  });

  const data = (await response.json()) as TelegramSendMessageResponse;

  if (!response.ok || !data.ok) {
    if (isEntityFormattingError(data.description)) {
      const fallbackResponse = await fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatted.plain,
          reply_to_message_id: replyToMessageId,
          disable_web_page_preview: true,
        }),
      });
      const fallbackData =
        (await fallbackResponse.json()) as TelegramSendMessageResponse;

      if (fallbackResponse.ok && fallbackData.ok) {
        return requireTelegramMessageId(fallbackData);
      }

      throw new Error(
        fallbackData.description || "Telegram sendMessage failed.",
      );
    }

    throw new Error(data.description || "Telegram sendMessage failed.");
  }

  return requireTelegramMessageId(data);
}

function requireTelegramMessageId(data: TelegramSendMessageResponse) {
  const messageId = data.result?.message_id;

  if (!Number.isSafeInteger(messageId)) {
    throw new Error("Telegram sendMessage response is missing message_id.");
  }

  return messageId as number;
}

function isEntityFormattingError(description?: string) {
  return /can't parse entities|unsupported start tag|wrong entity/i.test(
    description ?? "",
  );
}
