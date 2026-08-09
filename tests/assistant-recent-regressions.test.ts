import assert from "node:assert/strict";
import test from "node:test";
import {
  formatFriendlyValidationError,
} from "../lib/agents/assistant/assistant-core";
import {
  reconcileConversationDependentActions,
} from "../lib/agents/assistant/conversation-reconciliation";
import {
  reconcileStrategicPlanWithSheets,
} from "../lib/agents/assistant/strategic-planner";
import type {
  AssistantPlanOutcome,
  UpdateSheetAction,
} from "../lib/agents/assistant/types";
import {
  formatGoogleSheetsWorkspaceContext,
  type GoogleSheetsWorkspaceContext,
  type InspectedSheetTab,
} from "../lib/integrations/google-sheets/document-context";
import { buildSheetProfile } from "../lib/integrations/google-sheets/sheet-profile";
import { buildSheetRowEntities, matchSheetRows } from "../lib/integrations/google-sheets/row-matcher";
import type {
  ExistingSpreadsheetMetadata,
  SheetScalar,
} from "../lib/integrations/google-sheets/types";

const METADATA: ExistingSpreadsheetMetadata = {
  spreadsheetId: "launch",
  spreadsheetUrl: "https://docs.google.com/spreadsheets/d/launch",
  title: "Запуск магазина ИИ-агентов — 90 дней",
  tabs: [
    {
      sheetId: 5,
      title: "ИНТЕРВЬЮ",
      rowCount: 100,
      columnCount: 12,
      frozenRowCount: 3,
      frozenColumnCount: 0,
    },
  ],
};

const CONTACT_VALUES: SheetScalar[][] = [
  ["Карточки интервью"],
  [],
  [
    "Компания",
    "Сегмент",
    "Имя",
    "Должность",
    "Источник контакта",
    "Дата первого сообщения",
    "Дата следующего контакта",
    "Статус",
    "Дата интервью",
    "Текущий процесс",
    "Основная проблема",
    "Частота проблемы",
  ],
];

test("keeps every selected document in a bounded Sheets context", () => {
  const first = workspace("Проанализируй Мои материалы и Запуск магазина");
  const baseTab = first.inspectedDocuments[0].tabs[0];
  const verboseValues: SheetScalar[][] = Array.from({ length: 12 }, (_, index) => [
    `Лид ${index + 1}`,
    "Подробный контекст ".repeat(100),
  ]);
  const context: GoogleSheetsWorkspaceContext = {
    availableDocuments: [],
    inspectedDocuments: [
      {
        ...first.inspectedDocuments[0],
        title: "Мои материалы",
        tabs: [{ ...baseTab, values: verboseValues }],
      },
      {
        ...first.inspectedDocuments[0],
        spreadsheetId: "launch-2",
        title: "Запуск магазина ИИ-агентов — 90 дней",
        tabs: [{ ...baseTab, title: "ДАШБОРД", values: verboseValues }],
      },
    ],
  };
  const formatted = formatGoogleSheetsWorkspaceContext(context);

  assert.match(formatted, /Документ: Мои материалы/u);
  assert.match(formatted, /Документ: Запуск магазина ИИ-агентов/u);
  assert.ok(formatted.length <= 12_000);
});

test("normalizes a contact append to the semantic tab instead of a model range", () => {
  const sourceText =
    "Ассистент, https://tenchat.ru/chernyshevdv добавь этот аккаунт в активные сделки TickTick и занеси нужные данные в таблицу. Созвон завтра в 16:00.";
  const outcome: AssistantPlanOutcome = {
    kind: "ready",
    plan: {
      version: 1,
      mode: "batch_report",
      sourceText,
      actions: [
        {
          id: "action-1",
          type: "update_sheet",
          payload: {
            target: { kind: "title", title: "Запуск магазина" },
            range: "'ПЛАН НА 90 ДНЕЙ'!F4:F12",
            operation: "append_rows",
            values: [[10]],
          },
        },
      ],
    },
  };

  const result = reconcileStrategicPlanWithSheets(
    outcome,
    sourceText,
    workspace(sourceText),
    {
      timezone: "Europe/Moscow",
      now: new Date("2026-08-04T10:00:00Z"),
    },
  );

  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  const action = result.plan.actions[0] as UpdateSheetAction;
  assert.deepEqual(action.payload.target, {
    kind: "id",
    spreadsheetId: "launch",
  });
  assert.equal(action.payload.range, "'ИНТЕРВЬЮ'!A:L");
  assert.equal(action.payload.operation, "append_rows");
  assert.equal(action.payload.values?.[0].length, 12);
  assert.equal(action.payload.values?.[0][4], "https://tenchat.ru/chernyshevdv");
  assert.equal(action.payload.values?.[0][6], "2026-08-05");
  assert.equal(action.payload.values?.[0][7], "Созвон назначен");
  assert.equal(action.payload.values?.[0][8], "2026-08-05 16:00");
  assert.match(String(action.payload.values?.[0][9]), /16:00/);
});

test("updates an existing contact card instead of appending a duplicate", () => {
  const sourceText =
    "Занеси в таблицу: по контакту https://tenchat.ru/chernyshevdv созвон завтра с 16 до 17.";
  const values = [
    ...CONTACT_VALUES,
    [null, null, "Дмитрий", null, "https://tenchat.ru/chernyshevdv", null, null, "Новый", null, "Первичный контакт", null, null],
  ];
  const result = reconcileStrategicPlanWithSheets(
    readySheetOutcome(sourceText),
    sourceText,
    workspace(sourceText, values),
    {
      timezone: "Europe/Moscow",
      now: new Date("2026-08-04T10:00:00Z"),
    },
  );

  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  const sheetActions = result.plan.actions.filter(
    (action): action is UpdateSheetAction => action.type === "update_sheet",
  );
  assert.ok(sheetActions.length >= 3);
  assert.ok(sheetActions.every((action) => action.payload.operation === "update_cells"));
  assert.ok(sheetActions.every((action) => /[G-J]4$/u.test(action.payload.range)));
  assert.ok(sheetActions.every((action) => action.payload.range !== "'ИНТЕРВЬЮ'!A:L"));
});

test("does not confuse different contacts from the same social network", () => {
  const sourceText =
    "Добавь в таблицу контакт https://tenchat.ru/chernyshevdv и созвон завтра с 16 до 17.";
  const values = [
    ...CONTACT_VALUES,
    [null, null, "Оксана", null, "https://tenchat.ru/ksyalf", null, null, "Новый", null, null, null, null],
    [null, null, "Дмитрий", null, "https://tenchat.ru/scherba", null, null, "Новый", null, null, null, null],
  ];
  const result = reconcileStrategicPlanWithSheets(
    readySheetOutcome(sourceText),
    sourceText,
    workspace(sourceText, values),
    {
      timezone: "Europe/Moscow",
      now: new Date("2026-08-04T10:00:00Z"),
    },
  );

  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  const action = result.plan.actions.find(
    (candidate): candidate is UpdateSheetAction => candidate.type === "update_sheet",
  );
  assert.equal(action?.payload.operation, "append_rows");
  assert.equal(action?.payload.range, "'ИНТЕРВЬЮ'!A:L");
});

test("restores a calendar event when the user replies only with the end time", () => {
  const malformed = {
    kind: "ready",
    plan: {
      version: 1,
      mode: "quick_command",
      sourceText: "Событие закончится в пятнадцать ноль ноль.",
      actions: [
        {
          id: "action-1",
          type: "create_calendar_event",
          payload: { title: "Созвон с Мариной", endTime: "15:00" },
        },
      ],
    },
  } as unknown as AssistantPlanOutcome;
  const result = reconcileConversationDependentActions(malformed, {
    sourceText: "Событие закончится в пятнадцать ноль ноль.",
    timezone: "Europe/Moscow",
    now: new Date("2026-08-04T10:00:00Z"),
    conversation: [
      {
        role: "user",
        text: "Созвон с Мариной в следующий понедельник в 14:00, добавь в календарь.",
      },
      { role: "assistant", text: "Во сколько событие закончится?" },
    ],
  });

  assertCalendar(result, "2026-08-10", "14:00", "15:00");
});

test("turns a short date-and-time reply into the pending calendar action", () => {
  const result = reconcileConversationDependentActions(
    {
      kind: "clarification",
      question: "На какую дату назначить встречу?",
      missingField: "calendar.date",
    },
    {
      sourceText: "10 августа с 14 до 15",
      timezone: "Europe/Moscow",
      now: new Date("2026-08-04T10:00:00Z"),
      conversation: [
        { role: "user", text: "Созвон с Дмитрием, добавь в календарь." },
        { role: "assistant", text: "На какую дату назначить встречу?" },
      ],
    },
  );

  assertCalendar(result, "2026-08-10", "14:00", "15:00");
});

test("keeps the executable task when only calendar end time is missing", () => {
  const outcome = {
    kind: "ready",
    plan: {
      version: 1,
      mode: "batch_report",
      sourceText: "Создай задачу и созвон завтра в 16:00",
      actions: [
        {
          id: "action-1",
          type: "create_task",
          payload: { title: "Связаться с Дмитрием" },
        },
        {
          id: "action-2",
          type: "create_calendar_event",
          payload: {
            title: "Созвон с Дмитрием",
            date: "2026-08-05",
            startTime: "16:00",
            timezone: "Europe/Moscow",
          },
        },
      ],
    },
  } as unknown as AssistantPlanOutcome;
  const result = reconcileConversationDependentActions(outcome, {
    sourceText: "Создай задачу и созвон завтра в 16:00",
    timezone: "Europe/Moscow",
    now: new Date("2026-08-04T10:00:00Z"),
    conversation: [],
  });

  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.deepEqual(result.plan.actions.map((action) => action.type), ["create_task"]);
  assert.equal(
    result.plan.strategicPlan?.clarification?.missingField,
    "calendar.end_time",
  );
});

test("does not show internal payload paths in validation errors", () => {
  const message = formatFriendlyValidationError([
    "actions[0].payload.range for append_rows must not contain row numbers",
  ]);

  assert.doesNotMatch(message, /payload|append_rows|actions\[/i);
  assert.match(message, /диапазон.*не нужны/iu);
});

function workspace(
  sourceText: string,
  values: SheetScalar[][] = CONTACT_VALUES,
): GoogleSheetsWorkspaceContext {
  const profile = buildSheetProfile({
    spreadsheet: METADATA,
    tab: METADATA.tabs[0],
    values,
  });
  const entities = buildSheetRowEntities(profile, values);
  const tab: InspectedSheetTab = {
    title: "ИНТЕРВЬЮ",
    range: "'ИНТЕРВЬЮ'!A1:L12",
    values,
    profile,
    entities,
    rowMatches: matchSheetRows(sourceText, entities),
  };

  return {
    availableDocuments: [
      {
        spreadsheetId: METADATA.spreadsheetId,
        spreadsheetUrl: METADATA.spreadsheetUrl,
        title: METADATA.title,
      },
    ],
    inspectedDocuments: [
      {
        spreadsheetId: METADATA.spreadsheetId,
        spreadsheetUrl: METADATA.spreadsheetUrl,
        title: METADATA.title,
        tabs: [tab],
      },
    ],
  };
}

function readySheetOutcome(sourceText: string): AssistantPlanOutcome {
  return {
    kind: "ready",
    plan: {
      version: 1,
      mode: "quick_command",
      sourceText,
      actions: [
        {
          id: "action-1",
          type: "update_sheet",
          payload: {
            target: { kind: "title", title: "Запуск магазина" },
            range: "'ПЛАН НА 90 ДНЕЙ'!F4:F12",
            operation: "append_rows",
            values: [[1]],
          },
        },
      ],
    },
  };
}

function assertCalendar(
  result: AssistantPlanOutcome,
  date: string,
  startTime: string,
  endTime: string,
) {
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  const event = result.plan.actions.find(
    (action) => action.type === "create_calendar_event",
  );
  assert.ok(event && event.type === "create_calendar_event");
  assert.equal(event.payload.date, date);
  assert.equal(event.payload.startTime, startTime);
  assert.equal(event.payload.endTime, endTime);
  assert.equal(event.payload.timezone, "Europe/Moscow");
}
