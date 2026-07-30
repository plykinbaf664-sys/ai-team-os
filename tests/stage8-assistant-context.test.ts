import assert from "node:assert/strict";
import test from "node:test";
import { createPersistence } from "../lib/database/persistence";
import type { SupabaseRestClient } from "../lib/database/supabase-rest";
import type { JsonObject } from "../lib/database/types";

test("loads recent Assistant messages in chronological order", async () => {
  const client = fakeClient({
    select: async () => [
      {
        direction: "outbound",
        text: "Продолжаем AI Marketplace.",
        created_at: "2026-07-30T10:01:00.000Z",
      },
      {
        direction: "inbound",
        text: "Работаем над AI Marketplace.",
        created_at: "2026-07-30T10:00:00.000Z",
      },
    ],
  });
  const persistence = createPersistence(client);

  const messages = await persistence.getRecentAssistantMessages(123, 12);

  assert.deepEqual(messages, [
    {
      role: "user",
      text: "Работаем над AI Marketplace.",
      createdAt: "2026-07-30T10:00:00.000Z",
    },
    {
      role: "assistant",
      text: "Продолжаем AI Marketplace.",
      createdAt: "2026-07-30T10:01:00.000Z",
    },
  ]);
});

test("persists both user and Assistant sides of a conversation", async () => {
  const messageRows: JsonObject[] = [];
  const client = fakeClient({
    upsert: async (table, rows) => {
      const row = Array.isArray(rows) ? rows[0] : rows;

      if (table === "users") {
        return [{ id: "user-id" }];
      }

      if (table === "assistant_messages") {
        messageRows.push(row);
        return [{ id: "message-id" }];
      }

      return [];
    },
  });
  const persistence = createPersistence(client);

  await persistence.recordAgentInteraction({
    context: {
      updateId: 10,
      chatId: 20,
      messageId: 30,
      userId: 40,
      text: "Добавь задачу по AI Marketplace",
    },
    role: "assistant",
    responseText: "Assistant Agent: Задача создана.",
    envelope: {
      traceId: "trace-1",
      rootRunId: "run-1",
      runs: [
        {
          id: "run-1",
          traceId: "trace-1",
          role: "assistant",
          status: "completed",
          depth: 0,
          payload: {},
        },
      ],
      actions: [],
      confirmations: [],
      artifacts: [],
    },
  });

  assert.deepEqual(
    messageRows.map((row) => ({
      direction: row.direction,
      text: row.text,
    })),
    [
      {
        direction: "inbound",
        text: "Добавь задачу по AI Marketplace",
      },
      {
        direction: "outbound",
        text: "Assistant Agent: Задача создана.",
      },
    ],
  );
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
