type SendTelegramDocumentInput = {
  chatId: number;
  filename: string;
  content: string;
  caption?: string;
  replyToMessageId?: number;
};

type TelegramSendDocumentResponse = {
  ok: boolean;
  description?: string;
};

export async function sendTelegramDocument({
  chatId,
  filename,
  content,
  caption,
  replyToMessageId,
}: SendTelegramDocumentInput) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }

  const formData = new FormData();
  const document = new Blob([`\uFEFF${content}`], {
    type: "text/markdown;charset=utf-8",
  });

  formData.append("chat_id", String(chatId));
  formData.append("document", document, filename);

  if (caption) {
    formData.append("caption", caption);
  }

  if (replyToMessageId) {
    formData.append("reply_to_message_id", String(replyToMessageId));
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: formData,
  });

  const data = (await response.json()) as TelegramSendDocumentResponse;

  if (!response.ok || !data.ok) {
    throw new Error(data.description || "Telegram sendDocument failed.");
  }

  return data;
}
