type SendTelegramMessageInput = {
  chatId: number;
  text: string;
  replyToMessageId?: number;
};

type TelegramSendMessageResponse = {
  ok: boolean;
  description?: string;
};

export async function sendTelegramMessage({
  chatId,
  text,
  replyToMessageId,
}: SendTelegramMessageInput) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId,
      disable_web_page_preview: true,
    }),
  });

  const data = (await response.json()) as TelegramSendMessageResponse;

  if (!response.ok || !data.ok) {
    throw new Error(data.description || "Telegram sendMessage failed.");
  }

  return data;
}
