import assert from "node:assert/strict";
import test from "node:test";
import { composeStrategicResponse } from "../lib/agents/assistant/strategic-response-composer";
import { formatTelegramMessage } from "../lib/telegram/message-format";
import type {
  ActionPlan,
  ActionResult,
} from "../lib/agents/assistant/types";

test("composes a verified sheet update as a management response", () => {
  const plan = outreachPlan();
  const text = composeStrategicResponse(plan, [
    result(
      "succeeded",
      "Отправлено: 3 → 13. Изменение проверено повторным чтением.",
    ),
  ]);

  assert.match(text, /^Выполнено/m);
  assert.match(text, /строку 11.*«ОФФЕРЫ И РАССЫЛКИ»/u);
  assert.match(text, /Ключевые цифры\n- Отправлено: 3 → 13\./u);
  assert.match(text, /Вывод\n- Запись проверена/u);
  assert.match(text, /Рекомендация\n- Уточнить следующий follow-up\./u);
  assert.doesNotMatch(text, /(?:action|payload|mock|confidence|повторным чтением)/iu);
});

test("keeps a recommendation separate from completed actions", () => {
  const text = composeStrategicResponse(outreachPlan(), [
    result("succeeded", "Отправлено: 3 → 13."),
  ]);
  const completed = text.split("Рекомендация")[0];

  assert.doesNotMatch(completed, /Уточнить следующий follow-up/u);
  assert.match(text, /Рекомендация/u);
});

test("reports partial success without hiding a failure", () => {
  const plan = outreachPlan();
  plan.actions.push({
    id: "action-2",
    type: "create_task",
    payload: { title: "Связаться повторно" },
  });
  const text = composeStrategicResponse(plan, [
    result("succeeded", "Отправлено: 3 → 13."),
    {
      actionId: "action-2",
      actionType: "create_task",
      status: "failed",
      message: "TickTick временно недоступен.",
    },
  ]);

  assert.match(text, /Выполнено/u);
  assert.match(text, /Не выполнено\n- TickTick временно недоступен\./u);
  assert.match(text, /Однозначная часть запроса выполнена/u);
});

test("asks only the blocking clarification and hides policy internals", () => {
  const plan = outreachPlan();
  const text = composeStrategicResponse(
    plan,
    [
      result(
        "needs_clarification",
        "Действие update_sheet пока не выполнено: недостаточно уверенного контекста.",
        "confidence_too_low",
      ),
    ],
    ["Какую существующую строку таблицы нужно обновить?"],
  );

  assert.equal(
    text,
    "Рекомендация\n- Уточнить следующий follow-up. В строке follow-up ещё не зафиксирован.\n\nНужно уточнить\n- Какую существующую строку таблицы нужно обновить?",
  );
  assert.doesNotMatch(text, /update_sheet|confidence/iu);
});

test("uses a human confirmation prompt for protected changes", () => {
  const text = composeStrategicResponse(
    outreachPlan(),
    [
      result(
        "needs_confirmation",
        "Действие update_sheet ожидает подтверждения.",
        "confidence_confirmation_required",
      ),
    ],
    ["Подтверди опасное действие: update_sheet."],
  );

  assert.match(text, /Нужно подтверждение/u);
  assert.match(text, /изменение данных в Google Sheets/iu);
  assert.doesNotMatch(text, /update_sheet|опасное действие/iu);
});

test("preserves a useful formula clarification", () => {
  const text = composeStrategicResponse(outreachPlan(), [
    result(
      "needs_clarification",
      "Ячейка I11 содержит формулу =SUM(I4:I10). Её не перезаписываю: нужно обновить первичный источник данных.",
      "sheet_formula_source_required",
    ),
  ]);

  assert.match(text, /Нужно уточнить/u);
  assert.match(text, /содержит формулу/u);
});

test("keeps an explicit task deadline in the completed response", () => {
  const plan = outreachPlan();
  plan.actions = [
    {
      id: "action-2",
      type: "create_task",
      payload: {
        title: "Подготовить презентацию",
        dueDateText: "к пятнице",
      },
    },
  ];
  plan.strategicPlan!.suggestions = [];
  const text = composeStrategicResponse(plan, [
    {
      actionId: "action-2",
      actionType: "create_task",
      status: "succeeded",
      message: "Задача создана в TickTick: Подготовить презентацию.",
    },
  ]);

  assert.match(text, /Срок: к пятнице\./u);
});

test("produces Telegram-safe formatting without replacement characters", () => {
  const text = composeStrategicResponse(outreachPlan(), [
    result("succeeded", "Отправлено: 3 → 13. Изменение проверено повторным чтением."),
  ]);
  const formatted = formatTelegramMessage(text);

  assert.match(formatted.html, /^<b>Выполнено<\/b>/u);
  assert.doesNotMatch(formatted.html, /(?:\*\*|�)/u);
  assert.doesNotMatch(formatted.plain, /(?:<b>|�)/u);
});

function outreachPlan(): ActionPlan {
  return {
    version: 1,
    mode: "quick_command",
    sourceText: "Сегодня сделал 10 партнёрских рассылок",
    actions: [
      {
        id: "action-1",
        type: "update_sheet",
        payload: {
          target: { kind: "id", spreadsheetId: "launch-sheet" },
          range: "'ОФФЕРЫ И РАССЫЛКИ'!I11",
          operation: "update_cells",
          values: [[13]],
        },
      },
    ],
    strategicPlan: {
      version: 1,
      userGoal: "Обновить факт партнёрских рассылок",
      projectId: "project-1",
      targetResources: [
        {
          type: "google_sheet",
          externalId: "launch-sheet",
          title: "Запуск магазина ИИ-агентов — 90 дней",
          sheetName: "ОФФЕРЫ И РАССЫЛКИ",
          entityId: "partner-row",
          rowNumber: 11,
        },
      ],
      factsFromMessage: [
        {
          key: "actual_sends_increment",
          value: 10,
          source: "message",
          evidence: "10 партнёрских рассылок",
        },
      ],
      factsFromContext: [],
      assumptions: [],
      actions: [
        {
          id: "execute-action-1",
          kind: "execute_action",
          linkedActionId: "action-1",
          actionType: "update_sheet",
          reason: "Обновить факт отправок",
          evidence: ["текущее значение 3", "добавить 10"],
          confidence: 0.98,
          executionPolicy: "auto_execute",
          expectedChange: "actual_sends: 3 → 13",
          verification: "Повторно прочитать I11",
        },
      ],
      suggestions: [
        {
          id: "suggest-follow-up",
          title: "Уточнить следующий follow-up",
          reason: "В строке follow-up ещё не зафиксирован.",
          evidence: ["Follow-up ещё не зафиксирован"],
          confidence: 0.9,
        },
      ],
      summaryIntent: "Обновить существующий партнёрский сегмент",
    },
  };
}

function result(
  status: ActionResult["status"],
  message: string,
  errorCode?: string,
): ActionResult {
  return {
    actionId: "action-1",
    actionType: "update_sheet",
    status,
    message,
    errorCode,
  };
}
