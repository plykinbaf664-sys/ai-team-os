import assert from "node:assert/strict";
import test from "node:test";
import { attachProactiveMonitoring } from "../lib/agents/assistant/proactive-monitor";
import { composeStrategicResponse } from "../lib/agents/assistant/strategic-response-composer";
import type { ActionPlan } from "../lib/agents/assistant/types";
import type { GoogleSheetsWorkspaceContext } from "../lib/integrations/google-sheets/document-context";
import { buildSheetRowEntities } from "../lib/integrations/google-sheets/row-matcher";
import { buildSheetProfile } from "../lib/integrations/google-sheets/sheet-profile";
import type { SheetScalar } from "../lib/integrations/google-sheets/types";

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

test("finds stale, plan/fact and missing-next-action risks without changing actions", () => {
  const plan = basePlan();
  const monitored = monitor(plan, baseValues(), { available: true, tasks: [] });
  const kinds = monitored.monitoringReport?.findings.map((item) => item.kind);

  assert.ok(kinds?.includes("stale_segment"));
  assert.ok(kinds?.includes("plan_fact_deviation"));
  assert.ok(kinds?.includes("missing_next_action"));
  assert.deepEqual(monitored.actions, plan.actions);
});

test("detects inconsistent funnel values only when both values exist", () => {
  const inconsistent = baseValues();
  inconsistent[1][4] = 11;
  assert.ok(
    monitor(basePlan(), inconsistent).monitoringReport?.findings.some(
      (item) => item.kind === "inconsistent_data",
    ),
  );

  const incomplete = baseValues();
  incomplete[1][3] = null;
  incomplete[1][4] = null;
  assert.equal(
    monitor(basePlan(), incomplete).monitoringReport?.findings.some(
      (item) => item.kind === "inconsistent_data",
    ),
    false,
  );
});

test("detects an overdue follow-up date and a linked overdue TickTick task", () => {
  const bySheetDate = baseValues();
  bySheetDate[1][7] = "01.08.2026";
  assert.ok(
    monitor(basePlan(), bySheetDate).monitoringReport?.findings.some(
      (item) => item.kind === "missed_follow_up",
    ),
  );

  const workspace = createWorkspace(baseValues());
  const entity = workspace.inspectedDocuments[0].tabs[0].entities[0];
  const monitored = attachProactiveMonitoring(basePlan(), {
    workspace,
    tickTick: {
      available: true,
      tasks: [
        {
          id: "task-1",
          projectId: "project-1",
          projectName: "AI Team OS",
          title: "Follow-up по партнёрам",
          dueDate: "2026-08-01T00:00:00.000+0000",
          content: `[ai-team-os:google-sheet-row:sheet-1:${encodeURIComponent(entity.entityId)}:follow_up]`,
        },
      ],
    },
    now: new Date("2026-08-04T10:00:00.000Z"),
  });
  assert.ok(
    monitored.monitoringReport?.findings.some(
      (item) => item.kind === "missed_follow_up",
    ),
  );
  assert.equal(
    monitored.monitoringReport?.findings.some(
      (item) => item.kind === "missing_next_action",
    ),
    false,
  );
});

test("does not claim a missing next action when TickTick is unavailable", () => {
  const monitored = monitor(basePlan(), baseValues(), {
    available: false,
    tasks: [],
  });
  assert.equal(
    monitored.monitoringReport?.findings.some(
      (item) => item.kind === "missing_next_action",
    ),
    false,
  );
});

test("deduplicates a recently reported finding and composes separate attention section", () => {
  const first = monitor(basePlan(), baseValues());
  const title = first.monitoringReport?.findings[0]?.title ?? "";
  const second = attachProactiveMonitoring(basePlan(), {
    workspace: createWorkspace(baseValues()),
    tickTick: { available: true, tasks: [] },
    conversation: [{ role: "assistant", text: `Требует внимания\n- ${title}` }],
    now: new Date("2026-08-04T10:00:00.000Z"),
  });

  assert.equal(
    second.monitoringReport?.findings.some((item) => item.title === title),
    false,
  );
  const response = composeStrategicResponse(first, []);
  assert.match(response, /Требует внимания/u);
  assert.match(response, /Рекомендация/u);
  assert.doesNotMatch(response, /Выполнено/u);
});

function monitor(
  plan: ActionPlan,
  values: SheetScalar[][],
  tickTick = { available: true, tasks: [] },
) {
  return attachProactiveMonitoring(plan, {
    workspace: createWorkspace(values),
    tickTick,
    now: new Date("2026-08-04T10:00:00.000Z"),
  });
}

function basePlan(): ActionPlan {
  return {
    version: 1,
    mode: "analytics",
    sourceText: "Что требует внимания?",
    actions: [
      {
        id: "read-1",
        type: "read_sheet",
        payload: { target: { kind: "id", spreadsheetId: "sheet-1" } },
      },
    ],
  };
}

function baseValues(): SheetScalar[][] {
  return [
    HEADERS,
    [
      "Партнёры / Agentic Sprint",
      "Аудит процессов",
      30,
      10,
      1,
      0,
      0,
      "",
      "",
      "01.07.2026",
      "В работе",
    ],
  ];
}

function createWorkspace(values: SheetScalar[][]): GoogleSheetsWorkspaceContext {
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
  const profile = buildSheetProfile({
    spreadsheet,
    tab: spreadsheet.tabs[0],
    values,
  });

  return {
    availableDocuments: [],
    inspectedDocuments: [
      {
        spreadsheetId: spreadsheet.spreadsheetId,
        title: spreadsheet.title,
        spreadsheetUrl: spreadsheet.spreadsheetUrl,
        tabs: [
          {
            title: spreadsheet.tabs[0].title,
            range: "'ОФФЕРЫ И РАССЫЛКИ'!A1:K12",
            values,
            profile,
            entities: buildSheetRowEntities(profile, values),
            rowMatches: [],
          },
        ],
      },
    ],
  };
}
