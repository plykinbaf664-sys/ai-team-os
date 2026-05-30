import { routeAgentMessage } from "@/lib/agents/agent-router";
import type { AgentRole } from "@/lib/agents/agent-registry";
import { sendTelegramDocument } from "@/lib/telegram/send-document";
import { sendTelegramMessage } from "@/lib/telegram/send-message";
import type { TelegramUpdate } from "@/lib/telegram/types";

type ParsedAgentCommand = {
  role: AgentRole;
  text: string;
};

type PendingResearchTask = {
  text: string;
  createdAt: number;
};

const pendingResearchTasks = new Map<number, PendingResearchTask>();
const PENDING_RESEARCH_TTL_MS = 30 * 60 * 1000;

export async function POST(request: Request) {
  if (!isValidTelegramSecret(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const update = (await request.json()) as TelegramUpdate;
  const message = update.message;

  if (!message?.text) {
    return Response.json({ ok: true, ignored: "non_text_message" });
  }

  if (message.from?.is_bot) {
    return Response.json({ ok: true, ignored: "bot_message" });
  }

  const command = parseAgentCommand(message.text);
  const pendingResearchTask = getPendingResearchTask(message.chat.id);

  if (!command && pendingResearchTask) {
    const mergedCommand = {
      role: "research" as const,
      text: mergeResearchTask(pendingResearchTask.text, message.text),
    };

    if (!shouldAskCompetitorClarification(mergedCommand.text)) {
      pendingResearchTasks.delete(message.chat.id);
    }

    return handleAgentCommand({
      command: mergedCommand,
      chatId: message.chat.id,
      userName: message.from?.username ?? message.from?.first_name ?? "user",
      replyToMessageId: message.message_id,
    });
  }

  if (!command) {
    return Response.json({ ok: true, ignored: "no_agent_command" });
  }

  if (command.role === "research" && shouldAskCompetitorClarification(command.text)) {
    pendingResearchTasks.set(message.chat.id, {
      text: command.text,
      createdAt: Date.now(),
    });
  }

  if (command.role === "research" && pendingResearchTask) {
    command.text = mergeResearchTask(pendingResearchTask.text, command.text);
  }

  if (command.role === "research" && !shouldAskCompetitorClarification(command.text)) {
    pendingResearchTasks.delete(message.chat.id);
  }

  return handleAgentCommand({
    command,
    chatId: message.chat.id,
    userName: message.from?.username ?? message.from?.first_name ?? "user",
    replyToMessageId: message.message_id,
  });
}

async function handleAgentCommand({
  command,
  chatId,
  userName,
  replyToMessageId,
}: {
  command: ParsedAgentCommand;
  chatId: number;
  userName: string;
  replyToMessageId: number;
}) {
  try {
    if (shouldSendResearchAcceptedMessage(command)) {
      await sendTelegramMessage({
        chatId,
        text: "Research Agent принял задачу. Собираю данные и готовлю отчет.",
        replyToMessageId,
      });
    }

    const result = await routeAgentMessage({
      role: command.role,
      text: command.text,
      chatId,
      userName,
    });

    await sendTelegramMessage({
      chatId,
      text: result.text,
      replyToMessageId,
    });

    if (result.document) {
      await sendTelegramDocument({
        chatId,
        filename: result.document.filename,
        content: result.document.content,
        caption: result.document.caption,
        replyToMessageId,
      });
    }

    return Response.json({ ok: true, agent: result.role });
  } catch (error) {
    console.error("Telegram webhook failed", error);

    try {
      await sendTelegramMessage({
        chatId,
        text: "Project Assistant получил задачу, но сейчас не смог подготовить ответ. Проверьте логи сервера и переменные окружения.",
        replyToMessageId,
      });
    } catch (sendError) {
      console.error("Telegram fallback message failed", sendError);
    }

    return Response.json({ ok: false, error: "agent_failed" }, { status: 200 });
  }
}

function shouldSendResearchAcceptedMessage(command: ParsedAgentCommand) {
  if (command.role !== "research") {
    return false;
  }

  return !shouldAskCompetitorClarification(command.text);
}

function getPendingResearchTask(chatId: number) {
  const task = pendingResearchTasks.get(chatId);

  if (!task) {
    return null;
  }

  if (Date.now() - task.createdAt > PENDING_RESEARCH_TTL_MS) {
    pendingResearchTasks.delete(chatId);
    return null;
  }

  return task;
}

function mergeResearchTask(originalText: string, followUpText: string) {
  return [
    "Исходная research-задача:",
    originalText,
    "",
    "Дополнительные критерии/уточнения пользователя:",
    followUpText,
    "",
    "Важно: отчет должен анализировать именно исходную нишу, а критерии использовать только как рамку анализа.",
  ].join("\n");
}

function shouldAskCompetitorClarification(text: string) {
  const asksForCompetitors = /\bcompetitors?\b|конкур/i.test(text);

  if (!asksForCompetitors) {
    return false;
  }

  const hasCount = /\d+|одн|дв|тр|четыр|пят|шест|сем|восем|девят|десят/i.test(text);
  const hasCriteria =
    /\bcriteria\b|критери|позиционирован|продуктов|линейк|обещан|воронк|цена|ценообразован|целевая аудитория|ЦА|канал|сильн|слаб/i.test(
      text,
    );

  return !hasCount || !hasCriteria;
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

function parseAgentCommand(text: string): ParsedAgentCommand | null {
  const normalized = text.trim();
  const match = normalized.match(
    /^\/?(project|проджект|research|ресерч)(?:@\w+)?(?:[\s,;:—-]+([\s\S]+))?$/i,
  );

  if (!match) {
    return null;
  }

  const role = getCommandRole(match[1]);

  return {
    role,
    text:
      match[2]?.trim() ||
      `Introduce yourself and explain how you can help this launch team as ${role}.`,
  };
}

function getCommandRole(command: string): AgentRole {
  if (/^(research|ресерч)$/i.test(command)) {
    return "research";
  }

  return "project";
}
