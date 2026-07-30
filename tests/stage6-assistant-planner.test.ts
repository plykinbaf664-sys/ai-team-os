import assert from "node:assert/strict";
import test from "node:test";
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
