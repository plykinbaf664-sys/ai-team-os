import assert from "node:assert/strict";
import test from "node:test";
import { createPersistence } from "../lib/database/persistence";
import type { SupabaseRestClient } from "../lib/database/supabase-rest";
import { transcribeAudio } from "../lib/integrations/openai/transcription";
import {
  parseSpokenAssistantRequest,
  parseTelegramUpdate,
} from "../lib/telegram/update-parser";
import { downloadTelegramVoice } from "../lib/telegram/voice-file";

test("parses a spoken Assistant invocation", () => {
  assert.equal(
    parseSpokenAssistantRequest(
      "Ассистент, создай задачу подготовить презентацию",
    ),
    "создай задачу подготовить презентацию",
  );
  assert.equal(
    parseSpokenAssistantRequest("assistant — покажи приоритеты"),
    "покажи приоритеты",
  );
  assert.equal(parseSpokenAssistantRequest("обычное сообщение"), null);
});

test("parses a Telegram voice message", () => {
  const update = parseTelegramUpdate({
    update_id: 10,
    message: {
      message_id: 20,
      chat: { id: 30, type: "private" },
      from: { id: 40, is_bot: false },
      voice: {
        file_id: "voice-file",
        file_unique_id: "unique-file",
        duration: 12,
        mime_type: "audio/ogg",
        file_size: 128,
      },
    },
  });

  assert.equal(update?.message?.voice?.file_id, "voice-file");
  assert.equal(update?.message?.voice?.duration, 12);
});

test("rejects a malformed Telegram voice message", () => {
  const update = parseTelegramUpdate({
    update_id: 10,
    message: {
      message_id: 20,
      chat: { id: 30, type: "private" },
      voice: { file_id: "", duration: -1 },
    },
  });

  assert.equal(update, null);
});

test("downloads a Telegram voice file", async () => {
  const requestedUrls: string[] = [];
  const mockFetch = (async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));

    if (requestedUrls.length === 1) {
      return Response.json({
        ok: true,
        result: { file_path: "voice/file_1.oga" },
      });
    }

    return new Response(new Blob(["voice-data"], { type: "audio/ogg" }));
  }) as typeof fetch;

  const result = await downloadTelegramVoice({
    fileId: "voice-file",
    botToken: "test-token",
    fetchImplementation: mockFetch,
  });

  assert.equal(result.filename, "file_1.ogg");
  assert.equal(await result.blob.text(), "voice-data");
  assert.equal(requestedUrls.length, 2);
});

test("sends audio to the OpenAI transcription endpoint", async () => {
  const mockFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    assert.equal(
      String(input),
      "https://api.openai.com/v1/audio/transcriptions",
    );
    assert.equal(init?.method, "POST");
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("model"), "gpt-4o-mini-transcribe");

    return Response.json({ text: "  Создай задачу  ", language: "ru" });
  }) as typeof fetch;

  const result = await transcribeAudio({
    blob: new Blob(["voice-data"], { type: "audio/ogg" }),
    filename: "voice.ogg",
    apiKey: "test-key",
    fetchImplementation: mockFetch,
  });

  assert.deepEqual(result, {
    text: "Создай задачу",
    language: "ru",
  });
});

test("persists voice transcript fields", async () => {
  const upserts: Array<{ table: string; rows: unknown; onConflict?: string }> = [];
  const client: SupabaseRestClient = {
    async insert() {
      return [];
    },
    async upsert(table, rows, options) {
      upserts.push({ table, rows, onConflict: options.onConflict });
      return [];
    },
    async update() {
      return [];
    },
    async rpc() {
      return null;
    },
  };
  const persistence = createPersistence(client);

  await persistence.saveVoiceTranscript({
    context: {
      updateId: 10,
      chatId: 20,
      messageId: 30,
      userId: 40,
      text: "Создай задачу",
    },
    fileId: "voice-file",
    durationSeconds: 12,
    status: "completed",
    transcript: "Создай задачу",
    language: "ru",
  });

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].table, "voice_transcripts");
  assert.equal(
    upserts[0].onConflict,
    "telegram_file_id,telegram_message_id",
  );
  const rows = upserts[0].rows as Record<string, unknown>;
  const { updated_at: updatedAt, ...stableRows } = rows;

  assert.equal(typeof updatedAt, "string");
  assert.deepEqual(stableRows, {
    telegram_update_id: 10,
    telegram_message_id: 30,
    telegram_file_id: "voice-file",
    transcript: "Создай задачу",
    language: "ru",
    duration_seconds: 12,
    status: "completed",
    error_message: null,
  });
});
