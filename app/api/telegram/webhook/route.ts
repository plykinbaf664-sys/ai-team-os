import { routeAgentMessage } from "@/lib/agents/agent-router";
import { sendTelegramMessage } from "@/lib/telegram/send-message";
import type { TelegramUpdate } from "@/lib/telegram/types";

export async function POST(request: Request) {
  if (!isValidTelegramSecret(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const update = (await request.json()) as TelegramUpdate;
  const message = update.message;

  if (!message?.text) {
    return Response.json({ ok: true, ignored: "non_text_message" });
  }

  const command = parseProjectCommand(message.text);

  if (!command) {
    return Response.json({ ok: true, ignored: "no_project_command" });
  }

  const result = await routeAgentMessage({
    role: "project",
    text: command,
    chatId: message.chat.id,
    userName: message.from?.username ?? message.from?.first_name ?? "user",
  });

  await sendTelegramMessage({
    chatId: message.chat.id,
    text: result.text,
    replyToMessageId: message.message_id,
  });

  return Response.json({ ok: true, agent: result.role });
}

export async function GET() {
  return Response.json({
    ok: true,
    service: "ai-team-os-telegram-webhook",
  });
}

function isValidTelegramSecret(request: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!expectedSecret) {
    return true;
  }

  return request.headers.get("x-telegram-bot-api-secret-token") === expectedSecret;
}

function parseProjectCommand(text: string) {
  const normalized = text.trim();
  const match = normalized.match(/^\/?project(?:@\w+)?(?:\s+([\s\S]+))?$/i);

  if (!match) {
    return null;
  }

  return match[1]?.trim() || "Introduce yourself and explain how you can help this launch team.";
}
