import assert from "node:assert/strict";
import test from "node:test";
import { planAssistantMessage } from "../lib/agents/assistant/assistant-planner";
import {
  createPolicyBlockedResults,
  evaluateActionPlanPolicy,
  filterExecutableActionPlan,
} from "../lib/agents/assistant/confidence-policy";
import { attachProactiveMonitoring } from "../lib/agents/assistant/proactive-monitor";
import type { AssistantProjectContext } from "../lib/agents/assistant/project-context";
import {
  attachStrategicPlan,
  reconcileStrategicPlanWithSheets,
} from "../lib/agents/assistant/strategic-planner";
import { composeStrategicResponse } from "../lib/agents/assistant/strategic-response-composer";
import type { ActionPlan, AssistantPlanOutcome } from "../lib/agents/assistant/types";
import type { GoogleSheetsWorkspaceContext } from "../lib/integrations/google-sheets/document-context";
import { buildSheetRowEntities, matchSheetRows } from "../lib/integrations/google-sheets/row-matcher";
import { buildSheetProfile } from "../lib/integrations/google-sheets/sheet-profile";
import type { SheetScalar } from "../lib/integrations/google-sheets/types";
import { isDuplicateTelegramUpdate } from "../lib/telegram/update-deduplication";

const HEADERS = [
  "Сегмент",
  "Оффер и результат",
  "План отправок",
  "Фактические отправки",
  "Ответы",
  "Интервью",
  "Обсуждения пилота",
  "Дата follow-up",
  "Следующее действие",
  "Дата обновления",
  "Статус",
];

const context: AssistantProjectContext = {
  telegramUserId: 1,
  telegramChatId: 1,
  timezone: "Europe/Moscow",
  resolution: "resolved",
  resolutionReason: "active_project_setting",
  confidence: 1,
  candidates: [],
  activeProject: {
    id: "project-1",
    name: "Запуск магазина ИИ-агентов",
    status: "active",
    goal: "Проверить партнёрские сегменты",
    kpis: ["30 отправок на сегмент"],
    aliases: ["AI Marketplace"],
    resources: [
      {
        id: "resource-1",
        projectId: "project-1",
        resourceType: "google_sheet",
        externalId: "sheet-1",
        title: "Запуск магазина ИИ-агентов — 90 дней",
        metadata: {},
      },
    ],
    glossary: [],
    operatingRules: [],
    decisions: [],
    recentActions: [],
  },
};

test("1. increments sends in the existing segment instead of adding a row", () => {
  const sourceText = "Сегодня сделал 10 партнёрских рассылок по Agentic Sprint";
  const outcome = reconcileStrategicPlanWithSheets(
    readySheetUpdate(sourceText, 10),
    sourceText,
    workspace(baseValues(), sourceText),
  );

  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const action = outcome.plan.actions[0];
  assert.equal(action.type, "update_sheet");
  if (action.type !== "update_sheet") return;
  assert.equal(action.payload.range, "'ОФФЕРЫ И РАССЫЛКИ'!D2");
  assert.deepEqual(action.payload.values, [[20]]);
  assert.equal(outcome.plan.strategicPlan?.targetResources[0].rowNumber, 2);
});

test("2. keeps replies and interviews as separate verified metric updates", () => {
  const plan = runtimeSheetPlan("Получил 3 ответа и один созвон", [
    sheetAction("replies", "E2", 4),
    sheetAction("interviews", "F2", 1),
  ]);
  const policy = evaluateActionPlanPolicy(plan, context);

  assert.deepEqual(policy.executableActionIds, ["replies", "interviews"]);
  assert.deepEqual(plan.actions.map((action) => action.type), ["update_sheet", "update_sheet"]);
});

test("3. preserves an exact calendar time and the user timezone", () => {
  const plan = attachStrategicPlan(
    {
      version: 1,
      mode: "quick_command",
      sourceText: "Марина согласовала эфир 13 августа в 19:00",
      actions: [
        {
          id: "event",
          type: "create_calendar_event",
          payload: {
            title: "Эфир с Мариной",
            date: "2026-08-13",
            startTime: "19:00",
            timezone: "Europe/Moscow",
          },
        },
      ],
    },
    context,
  );
  const policy = evaluateActionPlanPolicy(plan, context);
  const action = plan.actions[0];

  assert.equal(action.type, "create_calendar_event");
  if (action.type !== "create_calendar_event") return;
  assert.equal(action.payload.date, "2026-08-13");
  assert.equal(action.payload.startTime, "19:00");
  assert.equal(action.payload.timezone, context.timezone);
  assert.deepEqual(policy.executableActionIds, ["event"]);
});

test("4. records silence as a fact without inventing a status or agreement", async () => {
  const outcome = await planAssistantMessage("По Дмитрию пока тишина", {
    apiKey: "test-key",
    projectContext: context,
    fetchImplementation: mockPlannerResponse({
      outcome: {
        kind: "response",
        responseText: "По Дмитрию новых данных нет. Статус и договорённости не менял.",
      },
    }),
  });

  assert.equal(outcome?.kind, "response");
  if (outcome?.kind !== "response") return;
  assert.match(outcome.text, /не менял/u);
});

test("5. rejects a repeated Telegram delivery with the same update id", () => {
  const updateId = 2_026_080_401;
  assert.equal(isDuplicateTelegramUpdate(updateId), false);
  assert.equal(isDuplicateTelegramUpdate(updateId), true);
});

test("6. asks which segment when two rows match equally", () => {
  const values = [
    ...baseValues(),
    ["Партнёры / аудит", "Партнёрский аудит", 30, 2, 0, 0, 0, "", "", "01.08.2026", "В работе"],
  ];
  const sourceText = "Сегодня сделал 10 партнёрских рассылок";
  const outcome = reconcileStrategicPlanWithSheets(
    readySheetUpdate(sourceText, 10),
    sourceText,
    workspace(values, sourceText),
  );

  assert.equal(outcome.kind, "clarification");
  if (outcome.kind !== "clarification") return;
  assert.match(outcome.question, /Agentic Sprint/u);
  assert.match(outcome.question, /Партнёры \/ аудит/u);
});

test("7. executes the clear part of an incomplete report and isolates ambiguity", () => {
  const plan = attachStrategicPlan(
    {
      version: 1,
      mode: "batch_report",
      sourceText: "Покажи задачи и обнови неизвестную таблицу",
      actions: [
        { id: "tasks", type: "list_tasks", payload: {} },
        sheetAction("unknown", "A2", 1, "unknown-sheet"),
      ],
    },
    context,
  );
  const policy = evaluateActionPlanPolicy(plan, context);
  const executable = filterExecutableActionPlan(plan, policy);
  const blocked = createPolicyBlockedResults(plan, policy);

  assert.deepEqual(executable?.actions.map((action) => action.id), ["tasks"]);
  assert.equal(blocked[0].status, "needs_clarification");
});

test("8. blocks an explicit total that conflicts with the current sheet value", () => {
  const sourceText = "По партнёрскому сегменту всего 5 отправок, а в таблице сейчас 10";
  const outcome = reconcileStrategicPlanWithSheets(
    readySheetUpdate(sourceText, 5, "D2"),
    sourceText,
    workspace(baseValues(), sourceText),
  );

  assert.equal(outcome.kind, "clarification");
  if (outcome.kind !== "clarification") return;
  assert.match(outcome.question, /5/u);
  assert.match(outcome.question, /10/u);
});

test("9. requires confirmation for a mass operation", () => {
  const plan = attachStrategicPlan(
    {
      version: 1,
      mode: "batch_report",
      sourceText: "Очисти все строки сегментов",
      actions: [
        {
          id: "bulk",
          type: "update_sheet",
          payload: {
            target: { kind: "id", spreadsheetId: "sheet-1" },
            range: "'ОФФЕРЫ И РАССЫЛКИ'!A2:K100",
            operation: "clear_range",
          },
        },
      ],
    },
    context,
  );
  const assessment = evaluateActionPlanPolicy(plan, context).assessments[0];

  assert.equal(assessment.risk, "critical");
  assert.equal(assessment.decision, "confirm");
});

test("10. returns a strategic warning separately from completed actions", () => {
  const monitored = attachProactiveMonitoring(
    runtimeSheetPlan("Что требует внимания?", [
      {
        id: "read",
        type: "read_sheet",
        payload: { target: { kind: "id", spreadsheetId: "sheet-1" } },
      },
    ]),
    {
      workspace: workspace(baseValues(), "партнёрский сегмент"),
      tickTick: { available: true, tasks: [] },
      now: new Date("2026-08-04T10:00:00.000Z"),
    },
  );
  const response = composeStrategicResponse(monitored, []);

  assert.match(response, /Требует внимания/u);
  assert.match(response, /Рекомендация/u);
  assert.doesNotMatch(response, /Выполнено/u);
});

function baseValues(): SheetScalar[][] {
  return [
    HEADERS,
    ["Партнёры / Agentic Sprint", "Аудит процессов", 30, 10, 1, 0, 0, "", "", "01.07.2026", "В работе"],
  ];
}

function workspace(values: SheetScalar[][], sourceText: string): GoogleSheetsWorkspaceContext {
  const spreadsheet = {
    spreadsheetId: "sheet-1",
    spreadsheetUrl: "https://example.com/sheet-1",
    title: "Запуск магазина ИИ-агентов — 90 дней",
    tabs: [
      {
        sheetId: 1,
        title: "ОФФЕРЫ И РАССЫЛКИ",
        rowCount: 100,
        columnCount: HEADERS.length,
        frozenRowCount: 1,
        frozenColumnCount: 0,
      },
    ],
  };
  const profile = buildSheetProfile({ spreadsheet, tab: spreadsheet.tabs[0], values });
  const entities = buildSheetRowEntities(profile, values);

  return {
    availableDocuments: [],
    inspectedDocuments: [
      {
        spreadsheetId: spreadsheet.spreadsheetId,
        spreadsheetUrl: spreadsheet.spreadsheetUrl,
        title: spreadsheet.title,
        tabs: [
          {
            title: spreadsheet.tabs[0].title,
            range: "'ОФФЕРЫ И РАССЫЛКИ'!A1:K12",
            values,
            profile,
            entities,
            rowMatches: matchSheetRows(sourceText, entities),
          },
        ],
      },
    ],
  };
}

function readySheetUpdate(
  sourceText: string,
  value: number,
  cell = "A2",
): Extract<AssistantPlanOutcome, { kind: "ready" }> {
  return {
    kind: "ready",
    plan: {
      version: 1,
      mode: "quick_command",
      sourceText,
      actions: [sheetAction("sheet-update", cell, value)],
    },
  };
}

function sheetAction(id: string, cell: string, value: number, spreadsheetId = "sheet-1") {
  return {
    id,
    type: "update_sheet" as const,
    payload: {
      target: { kind: "id" as const, spreadsheetId },
      range: `'ОФФЕРЫ И РАССЫЛКИ'!${cell}`,
      operation: "update_cells" as const,
      values: [[value]],
    },
  };
}

function runtimeSheetPlan(sourceText: string, actions: ActionPlan["actions"]): ActionPlan {
  const plan = attachStrategicPlan(
    { version: 1, mode: "analytics", sourceText, actions },
    context,
  );
  plan.strategicPlan!.targetResources = [
    {
      type: "google_sheet",
      externalId: "sheet-1",
      title: "Запуск магазина ИИ-агентов — 90 дней",
      sheetName: "ОФФЕРЫ И РАССЫЛКИ",
      entityId: "partner-row",
      entityLabel: "Партнёры / Agentic Sprint",
      rowNumber: 2,
    },
  ];
  return plan;
}

function mockPlannerResponse(value: unknown): typeof fetch {
  return (async () =>
    Response.json({
      status: "completed",
      output_text: JSON.stringify(value),
    })) as typeof fetch;
}
