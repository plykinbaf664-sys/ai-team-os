import { routeRootAgentMessage } from "@/lib/agents/agent-router";
import { createPersistenceFromEnv } from "@/lib/database/persistence";
import type { TelegramPersistenceContext } from "@/lib/database/types";
import { transcribeAudio } from "@/lib/integrations/openai/transcription";
import { checkTelegramAccess } from "@/lib/telegram/access-control";
import { sendTelegramMessage } from "@/lib/telegram/send-message";
import { isDuplicateTelegramUpdate } from "@/lib/telegram/update-deduplication";
import {
  parseSpokenAssistantRequest,
  parseTelegramAgentRequest,
  parseTelegramUpdate,
} from "@/lib/telegram/update-parser";
import { downloadTelegramVoice } from "@/lib/telegram/voice-file";

export async function POST(request: Request) {
  if (!isValidTelegramSecret(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const update = await readTelegramUpdate(request);

  if (!update) {
    return Response.json({ ok: false, error: "invalid_update" }, { status: 400 });
  }

  const message = update.message;

  if (!message) {
    return Response.json({ ok: true, ignored: "unsupported_update" });
  }

  if (!message.text && !message.voice) {
    return Response.json({ ok: true, ignored: "non_text_message" });
  }

  if (message.from?.is_bot) {
    return Response.json({ ok: true, ignored: "bot_message" });
  }

  const access = checkTelegramAccess({
    userId: message.from?.id,
    chatId: message.chat.id,
  });

  if (!access.allowed) {
    return Response.json({ ok: true, ignored: access.reason });
  }

  if (!message.from) {
    return Response.json({ ok: true, ignored: "missing_user" });
  }

  const persistence = createPersistenceFromEnv();
  const persistenceContext: TelegramPersistenceContext = {
    updateId: update.update_id,
    chatId: message.chat.id,
    messageId: message.message_id,
    userId: message.from.id,
    username: message.from.username,
    firstName: message.from.first_name,
    text: message.text ?? "[voice]",
  };

  if (persistence) {
    try {
      const claim = await persistence.claimTelegramUpdate(persistenceContext);

      if (claim === "duplicate") {
        return Response.json({ ok: true, ignored: "duplicate_update" });
      }
    } catch (error) {
      console.error("Telegram update claim failed", error);
      return Response.json(
        { ok: false, error: "persistence_unavailable" },
        { status: 503 },
      );
    }
  } else if (isDuplicateTelegramUpdate(update.update_id)) {
    return Response.json({ ok: true, ignored: "duplicate_update" });
  }

  if (message.voice) {
    return handleAssistantVoice({
      updateId: update.update_id,
      chatId: message.chat.id,
      messageId: message.message_id,
      fileId: message.voice.file_id,
      durationSeconds: message.voice.duration,
      persistence,
      persistenceContext,
      requireSpokenInvocation: message.chat.type !== "private",
    });
  }

  const agentRequest = parseTelegramAgentRequest(message);

  if (!agentRequest) {
    if (persistence) {
      try {
        await persistence.recordIgnoredUpdate(
          persistenceContext,
          "no_agent_command",
        );
      } catch (error) {
        console.error("Ignored Telegram update persistence failed", error);
        await safelyFailUpdate(persistence, update.update_id, error);
        return Response.json(
          { ok: false, error: "persistence_unavailable" },
          { status: 503 },
        );
      }
    }

    return Response.json({ ok: true, ignored: "no_agent_command" });
  }

  try {
    const result = await routeRootAgentMessage(agentRequest);

    if (!result.persistence) {
      throw new Error("Root agent result is missing persistence data.");
    }

    if (persistence) {
      await persistence.recordAgentInteraction({
        context: persistenceContext,
        role: result.role === "assistant" ? "assistant" : "project",
        responseText: result.text,
        envelope: result.persistence,
      });
    }

    await sendTelegramMessage({
      chatId: message.chat.id,
      text: result.text,
      replyToMessageId: message.message_id,
    });

    if (persistence) {
      await persistence.completeTelegramUpdate(
        update.update_id,
        result.persistence.traceId,
      );
    }

    return Response.json({ ok: true, agent: result.role });
  } catch (error) {
    console.error("Telegram webhook failed", error);

    if (persistence) {
      await safelyFailUpdate(persistence, update.update_id, error);
    }

    try {
      await sendTelegramMessage({
        chatId: message.chat.id,
        text: "AI Team OS получил запрос, но не смог отправить ответ. Проверьте логи сервера.",
        replyToMessageId: message.message_id,
      });
    } catch (sendError) {
      console.error("Telegram fallback message failed", sendError);
    }

    return Response.json(
      { ok: false, error: "agent_failed" },
      { status: persistence ? 503 : 200 },
    );
  }
}

export async function GET() {
  return Response.json({
    ok: true,
    service: "ai-team-os-telegram-webhook",
  });
}

async function readTelegramUpdate(request: Request) {
  try {
    return parseTelegramUpdate(await request.json());
  } catch {
    return null;
  }
}

function isValidTelegramSecret(request: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!expectedSecret) {
    return true;
  }

  return request.headers.get("x-telegram-bot-api-secret-token") === expectedSecret;
}

async function safelyFailUpdate(
  persistence: NonNullable<ReturnType<typeof createPersistenceFromEnv>>,
  updateId: number,
  error: unknown,
) {
  try {
    await persistence.failTelegramUpdate(updateId, error);
  } catch (persistenceError) {
    console.error("Telegram update failure persistence failed", persistenceError);
  }
}

async function handleAssistantVoice({
  updateId,
  chatId,
  messageId,
  fileId,
  durationSeconds,
  persistence,
  persistenceContext,
  requireSpokenInvocation,
}: {
  updateId: number;
  chatId: number;
  messageId: number;
  fileId: string;
  durationSeconds: number;
  persistence: ReturnType<typeof createPersistenceFromEnv>;
  persistenceContext: TelegramPersistenceContext;
  requireSpokenInvocation: boolean;
}) {
  let transcript: string | undefined;
  let language: string | undefined;
  let transcriptionCompleted = false;

  try {
    if (persistence) {
      await persistence.saveVoiceTranscript({
        context: persistenceContext,
        fileId,
        durationSeconds,
        status: "processing",
      });
    }

    const voiceFile = await downloadTelegramVoice({ fileId });
    const transcription = await transcribeAudio(voiceFile);
    transcript = transcription.text;
    language = transcription.language;

    const transcriptContext = {
      ...persistenceContext,
      text: transcript,
    };

    if (persistence) {
      await persistence.saveVoiceTranscript({
        context: transcriptContext,
        fileId,
        durationSeconds,
        status: "completed",
        transcript,
        language,
      });
    }

    transcriptionCompleted = true;

    const assistantText = requireSpokenInvocation
      ? parseSpokenAssistantRequest(transcript)
      : transcript;

    if (!assistantText) {
      if (persistence) {
        await persistence.recordIgnoredUpdate(
          transcriptContext,
          "no_agent_command",
        );
      }

      return Response.json({ ok: true, ignored: "no_agent_command" });
    }

    const result = await routeRootAgentMessage({
      role: "assistant",
      text: assistantText,
    });

    if (!result.persistence) {
      throw new Error("Assistant result is missing persistence data.");
    }

    if (persistence) {
      await persistence.recordAgentInteraction({
        context: transcriptContext,
        role: "assistant",
        responseText: result.text,
        envelope: result.persistence,
      });
    }

    await sendTelegramMessage({
      chatId,
      text: result.text,
      replyToMessageId: messageId,
    });

    if (persistence) {
      await persistence.completeTelegramUpdate(
        updateId,
        result.persistence.traceId,
      );
    }

    return Response.json({ ok: true, agent: "assistant", source: "voice" });
  } catch (error) {
    console.error("Telegram voice processing failed", error);
    const errorMessage = getErrorMessage(error);

    if (persistence) {
      if (!transcriptionCompleted) {
        try {
          await persistence.saveVoiceTranscript({
            context: persistenceContext,
            fileId,
            durationSeconds,
            status: "failed",
            transcript,
            language,
            errorMessage,
          });
        } catch (persistenceError) {
          console.error(
            "Voice transcript failure persistence failed",
            persistenceError,
          );
        }
      }

      await safelyFailUpdate(persistence, updateId, error);
    }

    try {
      await sendTelegramMessage({
        chatId,
        text: "Не удалось обработать голосовое сообщение. Отправьте его ещё раз.",
        replyToMessageId: messageId,
      });
    } catch (sendError) {
      console.error("Telegram voice error report failed", sendError);
    }

    return Response.json({
      ok: true,
      error: "voice_processing_failed",
    });
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error";
}
