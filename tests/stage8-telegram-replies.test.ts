import assert from "node:assert/strict";
import test from "node:test";
import { createPersistence } from "../lib/database/persistence";
import type { SupabaseRestClient } from "../lib/database/supabase-rest";
import {
  parseTelegramAgentRequest,
  parseTelegramUpdate,
} from "../lib/telegram/update-parser";

test("routes Russian text invocation to Assistant", () => {
  const update = parseTelegramUpdate({
    update_id: 1,
    message: {
      message_id: 2,
      text: "ассистент покажи задачи",
      chat: { id: -100, type: "supergroup" },
      from: { id: 3, is_bot: false },
    },
  });

  assert.deepEqual(
    parseTelegramAgentRequest(update!.message!),
    {
      role: "assistant",
      text: "покажи задачи",
    },
  );
});

test("parses reply metadata and continues the stored agent", () => {
  const update = parseTelegramUpdate({
    update_id: 10,
    message: {
      message_id: 20,
      text: "а какие самые срочные?",
      chat: { id: -100, type: "supergroup" },
      from: { id: 30, is_bot: false },
      reply_to_message: {
        message_id: 19,
        text: "Вот ваши задачи.",
        from: { id: 40, is_bot: true },
      },
    },
  });

  assert.equal(update?.message?.reply_to_message?.message_id, 19);
  assert.deepEqual(
    parseTelegramAgentRequest(update!.message!, {
      role: "assistant",
      text: "Вот ваши задачи.",
    }),
    {
      role: "assistant",
      text: "а какие самые срочные?",
      replyToText: "Вот ваши задачи.",
    },
  );
});

test("ignores a group reply that is not mapped to an agent", () => {
  const update = parseTelegramUpdate({
    update_id: 10,
    message: {
      message_id: 20,
      text: "обычный ответ",
      chat: { id: -100, type: "supergroup" },
      from: { id: 30, is_bot: false },
      reply_to_message: {
        message_id: 19,
        text: "Сообщение другого участника.",
        from: { id: 31, is_bot: false },
      },
    },
  });

  assert.equal(parseTelegramAgentRequest(update!.message!), null);
});

test("loads reply role and records the sent Telegram message id", async () => {
  const updates: Array<{
    table: string;
    values: Record<string, unknown>;
    filters: Record<string, string>;
  }> = [];
  const client = fakeClient({
    select: async () => [
      {
        agent_role: "project",
        text: "Исходный ответ Project Agent.",
      },
    ],
    update: async (table, values, filters) => {
      updates.push({ table, values, filters });
      return [{ id: "outbound-row" }];
    },
  });
  const persistence = createPersistence(client);

  assert.deepEqual(
    await persistence.getTelegramReplyContext(-100, 77),
    {
      role: "project",
      text: "Исходный ответ Project Agent.",
    },
  );

  await persistence.recordOutgoingTelegramMessage(88, 99);

  assert.deepEqual(updates, [
    {
      table: "assistant_messages",
      values: { telegram_message_id: 99 },
      filters: {
        telegram_update_id: "88",
        direction: "outbound",
      },
    },
  ]);
});

function fakeClient(
  overrides: Partial<SupabaseRestClient> = {},
): SupabaseRestClient {
  return {
    select: async () => [],
    insert: async () => [],
    upsert: async () => [],
    update: async () => [],
    rpc: async () => null,
    ...overrides,
  };
}
