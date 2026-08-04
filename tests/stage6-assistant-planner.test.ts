import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceAssistantSafety,
  executeActionPlan,
  resolveConfirmedRequest,
} from "../lib/agents/assistant/assistant-core";
import { planAssistantMessage } from "../lib/agents/assistant/assistant-planner";
import { requestStructuredResponse } from "../lib/integrations/openai/structured-response";

const EMPTY_PAYLOAD = {
  projectId: null,
  metrics: null,
  status: null,
  title: null,
  dueDateText: null,
  priority: null,
  project: null,
  taskId: null,
  taskTitle: null,
  limit: null,
  changes: null,
  eventId: null,
  eventTitle: null,
  date: null,
  startTime: null,
  endTime: null,
  timezone: null,
  blueprintId: null,
  spreadsheetId: null,
  target: null,
  range: null,
  operation: null,
  values: null,
  purpose: null,
  period: null,
  tabs: null,
  metricNames: null,
};

function openAIResponse(output: unknown) {
  return Response.json({
    status: "completed",
    output_text: JSON.stringify(output),
  });
}

function readSheetOutcome() {
  return {
    kind: "ready",
    mode: "quick_command",
    actions: [
      {
        id: "action-1",
        type: "read_sheet",
        payload: {
          ...EMPTY_PAYLOAD,
          target: {
            kind: "title",
            spreadsheetId: null,
            title: "Мои материалы",
          },
        },
      },
    ],
    question: null,
    missingField: null,
    prompt: null,
    reason: null,
    operationSummary: null,
    responseText: null,
  };
}

test("sends a strict JSON schema request to the Responses API", async () => {
  let body: Record<string, unknown> | undefined;

  const result = await requestStructuredResponse<{ ok: boolean }>({
    apiKey: "test-key",
    model: "test-model",
    instructions: "test",
    input: "hello",
    schemaName: "test_schema",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
    fetchImplementation: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return openAIResponse({ ok: true });
    }) as typeof fetch,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(body?.model, "test-model");
  assert.equal(body?.store, false);
  assert.deepEqual(
    (body?.text as { format?: { type?: string; strict?: boolean } }).format,
    {
      type: "json_schema",
      name: "test_schema",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    },
  );
});

test("normalizes conversational sheet structure requests into read_sheet", async () => {
  const phrases = [
    "Ассистент, можешь найти таблицу, которая называется «Мои материалы»? Видишь ее структуру?",
    "Ассистент, видишь ли ты структуру таблицы на Google Drive мои материалы? Можешь посмотреть?",
  ];

  for (const phrase of phrases) {
    const outcome = await planAssistantMessage(phrase, {
      apiKey: "test-key",
      fetchImplementation: (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { input?: string };
        assert.equal(body.input, phrase);
        return openAIResponse({ outcome: readSheetOutcome() });
      }) as typeof fetch,
    });

    assert.equal(outcome?.kind, "ready");

    if (outcome?.kind !== "ready") {
      assert.fail("Expected a ready plan.");
    }

    assert.equal(outcome.plan.sourceText, phrase);
    assert.deepEqual(outcome.plan.actions, [
      {
        id: "action-1",
        type: "read_sheet",
        payload: {
          target: {
            kind: "title",
            title: "Мои материалы",
          },
        },
      },
    ]);
  }
});

test("supports direct conversational responses without actions", async () => {
  const outcome = await planAssistantMessage("Привет, что ты умеешь?", {
    apiKey: "test-key",
    fetchImplementation: (async () =>
      openAIResponse({
        outcome: {
          kind: "response",
          responseText:
            "Могу работать с задачами, календарём, метриками и таблицами.",
        },
      })) as typeof fetch,
  });

  assert.deepEqual(outcome, {
    kind: "response",
    text: "Могу работать с задачами, календарём, метриками и таблицами.",
  });
});

test("routes TickTick task viewing to list_tasks instead of a capability response", async () => {
  const phrase = "Можешь ли ты посмотреть мои задачи в TickTick?";
  const outcome = await planAssistantMessage(phrase, {
    apiKey: "test-key",
    fetchImplementation: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        instructions?: string;
      };
      assert.match(body.instructions ?? "", /list_tasks/);

      return openAIResponse({
        outcome: {
          kind: "ready",
          mode: "quick_command",
          actions: [
            {
              id: "action-1",
              type: "list_tasks",
              payload: {
                ...EMPTY_PAYLOAD,
                limit: 20,
              },
            },
          ],
        },
      });
    }) as typeof fetch,
  });

  assert.equal(outcome?.kind, "ready");

  if (outcome?.kind !== "ready") {
    assert.fail("Expected a ready plan.");
  }

  assert.deepEqual(outcome.plan.actions, [
    {
      id: "action-1",
      type: "list_tasks",
      payload: { limit: 20 },
    },
  ]);
});

test("does not accept mock add_metrics as a completed external action", async () => {
  const sourceText =
    "Нужно внести, что 30 июля я сделал 10 рассылок по партнерскому сегменту.";
  let instructions = "";
  const outcome = await planAssistantMessage(sourceText, {
    apiKey: "test-key",
    fetchImplementation: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        instructions?: string;
      };
      instructions = body.instructions ?? "";

      return openAIResponse({
        outcome: {
          kind: "ready",
          mode: "quick_command",
          actions: [
            {
              id: "action-1",
              type: "add_metrics",
              payload: {
                ...EMPTY_PAYLOAD,
                metrics: [
                  {
                    name: "Рассылки — партнерский сегмент",
                    value: 10,
                    period: "2026-07-30",
                  },
                ],
              },
            },
          ],
        },
      });
    }) as typeof fetch,
  });

  assert.match(instructions, /update_sheet/);
  assert.deepEqual(outcome, {
    kind: "clarification",
    question:
      "В какую таблицу и лист записать эти данные? Если структура ещё не обсуждалась, также пришлите названия колонок.",
    missingField: "sheet.target,sheet.range,sheet.columns",
  });
});

test("uses runtime document structure to plan a real metric write", async () => {
  const sourceText =
    "Внеси, что 30 июля я сделал 10 рассылок по партнерскому сегменту.";
  const documentContext = [
    "Документ: Запуск магазина и агентов",
    "spreadsheet_id: launch-sheet",
    "Лист: Рассылки",
    "1: Дата | Сегмент | Количество | Комментарий",
  ].join("\n");
  let plannerInput = "";
  const outcome = await planAssistantMessage(sourceText, {
    apiKey: "test-key",
    googleSheetsContext: documentContext,
    fetchImplementation: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        input?: string;
      };
      plannerInput = body.input ?? "";

      return openAIResponse({
        outcome: {
          kind: "ready",
          mode: "quick_command",
          actions: [
            {
              id: "action-1",
              type: "update_sheet",
              payload: {
                ...EMPTY_PAYLOAD,
                target: {
                  kind: "id",
                  spreadsheetId: "launch-sheet",
                  title: null,
                },
                range: "Рассылки!A:D",
                operation: "append_rows",
                values: [
                  ["30.07.2026", "Партнерский", 10, ""],
                ],
              },
            },
          ],
        },
      });
    }) as typeof fetch,
  });

  assert.match(plannerInput, /Запуск магазина и агентов/);
  assert.equal(outcome?.kind, "ready");

  if (outcome?.kind !== "ready") {
    assert.fail("Expected a ready write plan.");
  }

  assert.deepEqual(outcome.plan.actions[0], {
    id: "action-1",
    type: "update_sheet",
    payload: {
      target: {
        kind: "id",
        spreadsheetId: "launch-sheet",
      },
      range: "'Рассылки'!A:D",
      operation: "append_rows",
      values: [["30.07.2026", "Партнерский", 10, ""]],
    },
  });
});

test("never reports an unsupported metrics action as succeeded", async () => {
  const results = await executeActionPlan({
    version: 1,
    mode: "quick_command",
    sourceText: "Внести 10 рассылок за 30 июля.",
    actions: [
      {
        id: "action-1",
        type: "add_metrics",
        payload: {
          metrics: [
            {
              name: "Рассылки — партнерский сегмент",
              value: 10,
              period: "2026-07-30",
            },
          ],
        },
      },
    ],
  });

  assert.equal(results[0].status, "needs_clarification");
  assert.equal(results[0].errorCode, "metrics_destination_required");
  assert.doesNotMatch(results[0].message, /mock/iu);
});

test("executes one appended row without confirmation", () => {
  const ready = {
    kind: "ready" as const,
    plan: {
      version: 1 as const,
      mode: "quick_command" as const,
      sourceText: "Внеси 10 рассылок за 30 июля.",
      actions: [
        {
          id: "action-1",
          type: "update_sheet" as const,
          payload: {
            target: {
              kind: "id" as const,
              spreadsheetId: "launch",
            },
            range: "'СЕГМЕНТЫ КОНТАКТОВ'!A:J",
            operation: "append_rows" as const,
            values: [
              [
                "2026-07-30",
                "Рассылка",
                "Партнёры / Консалтинг",
                10,
                null,
                "отправлено",
                10,
                null,
                null,
                "",
              ],
            ],
          },
        },
      ],
    },
  };

  assert.equal(
    enforceAssistantSafety(ready.plan.sourceText, ready).kind,
    "ready",
  );
});

test("still requires confirmation for bulk sheet writes", () => {
  const outcome = enforceAssistantSafety("Добавь эти строки", {
    kind: "ready",
    plan: {
      version: 1,
      mode: "batch_report",
      sourceText: "Добавь эти строки",
      actions: [
        {
          id: "action-1",
          type: "update_sheet",
          payload: {
            target: {
              kind: "id",
              spreadsheetId: "launch",
            },
            range: "'Лог'!A:J",
            operation: "append_rows",
            values: Array.from({ length: 6 }, (_, index) => [
              `row-${index + 1}`,
            ]),
          },
        },
      ],
    },
  });

  assert.equal(outcome.kind, "confirmation");
});

test("restores only the immediately confirmed request", () => {
  const conversation = [
    {
      role: "user" as const,
      text: "Очисти старый диапазон.",
    },
    {
      role: "assistant" as const,
      text: "Перед выполнением нужно твоё подтверждение.\nОчистить диапазон.",
    },
    {
      role: "user" as const,
      text: "Подтверждаю",
    },
    {
      role: "assistant" as const,
      text: "Требуется подтверждение\n\nПодтверждаю",
    },
    {
      role: "user" as const,
      text: "Ассистент, я подтверждаю.",
    },
    {
      role: "assistant" as const,
      text: "Требуется подтверждение\n\nя подтверждаю.",
    },
  ];

  assert.equal(
    resolveConfirmedRequest("Ассистент, я подтверждаю.", conversation),
    "Очисти старый диапазон.",
  );
  assert.equal(
    resolveConfirmedRequest("Что именно?", conversation),
    null,
  );
  assert.equal(
    resolveConfirmedRequest("Подтверждаю", [
      ...conversation,
      {
        role: "assistant",
        text: "Вот обычный ответ без подтверждения.",
      },
    ]),
    null,
  );
});

test("tells the planner when the previous operation was confirmed", async () => {
  let plannerInput = "";
  const outcome = await planAssistantMessage("Очисти диапазон", {
    apiKey: "test-key",
    confirmationGranted: true,
    fetchImplementation: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        input?: string;
      };
      plannerInput = body.input ?? "";

      return openAIResponse({
        outcome: {
          kind: "ready",
          mode: "quick_command",
          actions: [
            {
              id: "action-1",
              type: "update_sheet",
              payload: {
                ...EMPTY_PAYLOAD,
                target: {
                  kind: "id",
                  spreadsheetId: "launch",
                  title: null,
                },
                range: "'Архив'!A2:J20",
                operation: "clear_range",
              },
            },
          ],
        },
      });
    }) as typeof fetch,
  });

  assert.match(plannerInput, /явно подтвердил/);
  assert.equal(outcome?.kind, "ready");
});

test("passes recent conversation and exact TickTick projects to the planner", async () => {
  let plannerInput = "";
  const outcome = await planAssistantMessage(
    "Поставь задачу подготовить оффер",
    {
      apiKey: "test-key",
      conversation: [
        {
          role: "user",
          text: "Сейчас работаем над проектом AI Marketplace.",
        },
        {
          role: "assistant",
          text: "Принял, продолжаем работу по AI Marketplace.",
        },
      ],
      tickTickProjectNames: [
        "💼Работа",
        "🚀 AI Marketplace — 90 дней",
      ],
      fetchImplementation: (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { input?: string };
        plannerInput = body.input ?? "";

        return openAIResponse({
          outcome: {
            kind: "ready",
            mode: "quick_command",
            actions: [
              {
                id: "action-1",
                type: "create_task",
                payload: {
                  ...EMPTY_PAYLOAD,
                  title: "Подготовить оффер",
                  project: "🚀 AI Marketplace — 90 дней",
                },
              },
            ],
          },
        });
      }) as typeof fetch,
    },
  );

  assert.match(plannerInput, /Сейчас работаем над проектом AI Marketplace/);
  assert.match(plannerInput, /🚀 AI Marketplace — 90 дней/);
  assert.match(plannerInput, /Текущий запрос пользователя/);
  assert.equal(outcome?.kind, "ready");

  if (outcome?.kind !== "ready") {
    assert.fail("Expected a ready plan.");
  }

  assert.equal(
    outcome.plan.actions[0].type === "create_task"
      ? outcome.plan.actions[0].payload.project
      : undefined,
    "🚀 AI Marketplace — 90 дней",
  );
});

test("preserves all necessary clarification questions", async () => {
  const question =
    "К какому проекту относится задача? Какой срок и приоритет нужны?";
  const outcome = await planAssistantMessage("Добавь это в задачи", {
    apiKey: "test-key",
    fetchImplementation: (async () =>
      openAIResponse({
        outcome: {
          kind: "clarification",
          question,
          missingField: "task.project,dueDate,priority",
        },
      })) as typeof fetch,
  });

  assert.deepEqual(outcome, {
    kind: "clarification",
    question,
    missingField: "task.project,dueDate,priority",
  });
});

test("returns null without an API key so deterministic fallback can run", async () => {
  assert.equal(
    await planAssistantMessage("Найди таблицу", { apiKey: "" }),
    null,
  );
});

test("rejects incomplete and refusal responses", async () => {
  await assert.rejects(
    requestStructuredResponse({
      apiKey: "test-key",
      model: "test-model",
      instructions: "test",
      input: "test",
      schemaName: "test",
      schema: { type: "object" },
      fetchImplementation: (async () =>
        Response.json({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        })) as typeof fetch,
    }),
    /incomplete/,
  );

  await assert.rejects(
    requestStructuredResponse({
      apiKey: "test-key",
      model: "test-model",
      instructions: "test",
      input: "test",
      schemaName: "test",
      schema: { type: "object" },
      fetchImplementation: (async () =>
        Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "No." }],
            },
          ],
        })) as typeof fetch,
    }),
    /refused/,
  );
});

test(
  "live planner understands the reported Google Sheets phrases",
  { skip: process.env.RUN_LIVE_OPENAI_TEST !== "1" },
  async () => {
    const phrases = [
      "Ассистент, ты скажи, пожалуйста, можешь мне найти таблицу, которая называется «Мои материалы»? Видишь ее структуру?",
      "Ассистент, скажи, пожалуйста, видишь ли ты структуру таблицы на Google Drive мои материалы? Можешь посмотреть?",
    ];

    for (const phrase of phrases) {
      const outcome = await planAssistantMessage(phrase);

      assert.equal(outcome?.kind, "ready");

      if (outcome?.kind !== "ready") {
        assert.fail("Expected a ready plan.");
      }

      assert.equal(outcome.plan.actions[0]?.type, "read_sheet");
      const payload = outcome.plan.actions[0]?.payload;
      assert.equal("target" in payload, true);

      if (!("target" in payload) || payload.target.kind !== "title") {
        assert.fail("Expected a title target.");
      }

      assert.equal(
        payload.target.title.localeCompare("Мои материалы", undefined, {
          sensitivity: "base",
        }),
        0,
      );
    }
  },
);
