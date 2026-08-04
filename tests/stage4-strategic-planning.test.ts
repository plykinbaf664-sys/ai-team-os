import assert from "node:assert/strict";
import test from "node:test";
import { planAssistantMessage } from "../lib/agents/assistant/assistant-planner";
import { shouldInspectGoogleSheets } from "../lib/agents/assistant/assistant-core";
import type { AssistantProjectContext } from "../lib/agents/assistant/project-context";
import {
  attachStrategicPlan,
  normalizeStrategicActionPlan,
  reconcileStrategicPlanWithSheets,
  validateStrategicActionPlan,
} from "../lib/agents/assistant/strategic-planner";
import type { ActionPlan } from "../lib/agents/assistant/types";
import type { GoogleSheetsWorkspaceContext } from "../lib/integrations/google-sheets/document-context";

const projectContext: AssistantProjectContext = {
  telegramUserId: 10,
  telegramChatId: 20,
  timezone: "Europe/Moscow",
  resolution: "resolved",
  resolutionReason: "active_project_setting",
  confidence: 1,
  candidates: [],
  activeProject: {
    id: "launch",
    name: "Запуск магазина ИИ-агентов — 90 дней",
    status: "active",
    goal: "3 оплаченных пилота, 5–10 клиентов, MRR 250 000 ₽",
    kpis: ["3 оплаченных пилота", "5–10 клиентов", "MRR 250 000 ₽"],
    aliases: ["магазин ИИ-агентов"],
    resources: [
      {
        id: "resource-1",
        projectId: "launch",
        resourceType: "google_sheet",
        externalId: "sheet-1",
        title: "Запуск магазина ИИ-агентов — 90 дней",
        metadata: {},
      },
    ],
    glossary: [],
    operatingRules: [
      { key: "follow_up", text: "Follow-up через 2–3 дня", priority: 100 },
    ],
    decisions: [],
    recentActions: [],
  },
};

test("loads sheet context for a conversational activity report", () => {
  assert.equal(
    shouldInspectGoogleSheets(
      "Сегодня сделал 10 партнёрских рассылок",
      [],
    ),
    true,
  );
});

test("forms a strategic plan for the outreach update", async () => {
  let requestBody = "";
  const outcome = await planAssistantMessage(
    "Сегодня сделал 10 партнёрских рассылок",
    {
      apiKey: "test-key",
      projectContext,
      googleSheetsContext:
        "Лист ОФФЕРЫ И РАССЫЛКИ; row 11; entity_id=partner_outreach; actual_sends=10; replies=1",
      fetchImplementation: (async (_input, init) => {
        requestBody = String(init?.body ?? "");
        return Response.json({
          status: "completed",
          output_text: JSON.stringify({
            outcome: {
              kind: "ready",
              mode: "quick_command",
              actions: [
                {
                  id: "action-1",
                  type: "update_sheet",
                  payload: {
                    target: { kind: "id", spreadsheetId: "sheet-1" },
                    range: "ОФФЕРЫ И РАССЫЛКИ!F11",
                    operation: "update_cells",
                    values: [[20]],
                  },
                },
              ],
              strategicPlan: {
                userGoal: "Зафиксировать результат партнёрского аутрича",
                projectId: "launch",
                targetResources: [
                  {
                    type: "google_sheet",
                    externalId: "sheet-1",
                    title: "Запуск магазина ИИ-агентов — 90 дней",
                    sheetName: "ОФФЕРЫ И РАССЫЛКИ",
                    entityId: "partner_outreach",
                    rowNumber: 11,
                  },
                ],
                factsFromMessage: [
                  {
                    key: "actual_sends_increment",
                    value: 10,
                    source: "message",
                    evidence: "сделал 10 партнёрских рассылок",
                  },
                ],
                factsFromContext: [
                  {
                    key: "current_actual_sends",
                    value: 10,
                    source: "resource_context",
                    evidence: "row 11; actual_sends=10",
                  },
                ],
                assumptions: [],
                actions: [
                  {
                    id: "update-outreach",
                    kind: "execute_action",
                    linkedActionId: "action-1",
                    actionType: "update_sheet",
                    reason: "Обновить факт в существующей строке сегмента.",
                    evidence: ["row 11", "10 новых отправок"],
                    confidence: 0.96,
                    executionPolicy: "auto_execute",
                    expectedChange: "actual_sends: 10 → 20",
                    verification: "Повторно прочитать F11.",
                  },
                  {
                    id: "recalculate-conversion",
                    kind: "recalculate_metrics",
                    linkedActionId: null,
                    actionType: null,
                    reason: "Факт отправок влияет на конверсию.",
                    evidence: ["actual_sends: 10 → 20", "replies=1"],
                    confidence: 0.95,
                    executionPolicy: "auto_execute",
                    expectedChange: "Пересчитать reply_conversion обычным кодом.",
                    verification: "Сверить расчёт 1 / 20.",
                  },
                  {
                    id: "audit-update",
                    kind: "audit_log",
                    linkedActionId: null,
                    actionType: null,
                    reason: "Изменение должно быть трассируемым.",
                    evidence: ["action-1"],
                    confidence: 1,
                    executionPolicy: "auto_execute",
                    expectedChange: "Записать action и результат в audit log.",
                    verification: "Проверить audit entry по trace_id.",
                  },
                ],
                suggestions: [
                  {
                    id: "suggest-follow-up",
                    title: "Запланировать follow-up",
                    reason: "В проекте действует правило follow-up через 2–3 дня.",
                    evidence: ["project rule follow_up"],
                    confidence: 0.9,
                  },
                ],
                clarification: null,
                summaryIntent:
                  "Обновить существующий партнёрский сегмент и показать влияние на конверсию.",
              },
            },
          }),
        });
      }) as typeof fetch,
    },
  );

  assert.equal(outcome?.kind, "ready");
  if (!outcome || outcome.kind !== "ready") return;
  assert.match(requestBody, /strategicPlan/);
  assert.equal(outcome.plan.strategicPlan?.projectId, "launch");
  assert.equal(outcome.plan.strategicPlan?.targetResources[0].rowNumber, 11);
  assert.equal(outcome.plan.strategicPlan?.actions[0].linkedActionId, "action-1");
  assert.equal(outcome.plan.strategicPlan?.actions[1].kind, "recalculate_metrics");
  assert.equal(outcome.plan.strategicPlan?.actions[2].kind, "audit_log");
  assert.equal(outcome.plan.strategicPlan?.suggestions[0].id, "suggest-follow-up");
  assert.match(outcome.plan.strategicPlan?.summaryIntent ?? "", /конверсию/);
});

test("fallback strategic plan uses the resolved project and linked resource", () => {
  const plan: ActionPlan = {
    version: 1,
    mode: "quick_command",
    sourceText: "Покажи задачи",
    actions: [{ id: "action-1", type: "list_tasks", payload: {} }],
  };
  const enriched = attachStrategicPlan(plan, projectContext);

  assert.equal(enriched.strategicPlan?.projectId, "launch");
  assert.equal(enriched.strategicPlan?.targetResources[0].externalId, "sheet-1");
  assert.equal(enriched.strategicPlan?.actions[0].kind, "execute_action");
  assert.equal(enriched.strategicPlan?.actions[0].executionPolicy, "auto_execute");
});

test("deterministic reconciliation replaces an invented tab with the matched row", () => {
  const basePlan: ActionPlan = {
    version: 1,
    mode: "quick_command",
    sourceText: "Сегодня сделал 10 партнёрских рассылок",
    actions: [
      {
        id: "action-1",
        type: "update_sheet",
        payload: {
          target: { kind: "title", title: "Запуск магазина ИИ-агентов — 90 дней" },
          range: "'ПАРТНЁРСКИЕ РАССЫЛКИ'!C2",
          operation: "update_cells",
          values: [[10]],
        },
      },
    ],
  };
  const workspace: GoogleSheetsWorkspaceContext = {
    availableDocuments: [],
    inspectedDocuments: [
      {
        spreadsheetId: "sheet-1",
        title: "Запуск магазина ИИ-агентов — 90 дней",
        spreadsheetUrl: "https://example.com/sheet-1",
        tabs: [
          {
            title: "ОФФЕРЫ И РАССЫЛКИ",
            range: "'ОФФЕРЫ И РАССЫЛКИ'!A1:L12",
            values: [],
            profile: {
              version: 1,
              spreadsheetId: "sheet-1",
              sheetId: 1,
              sheetName: "ОФФЕРЫ И РАССЫЛКИ",
              purpose: "Управление сегментами, рассылками и конверсией",
              entityType: "outreach_segment",
              headerRowNumber: 3,
              columns: [
                {
                  index: 5,
                  columnLetter: "F",
                  header: "Повторное сообщение",
                  semanticKey: "follow_up_message",
                  role: "text",
                  dataType: "string",
                  updatePolicy: "protected",
                  isFormula: false,
                  isProtected: true,
                },
                {
                  index: 8,
                  columnLetter: "I",
                  header: "Отправлено",
                  semanticKey: "actual_sends",
                  role: "metric",
                  dataType: "number",
                  updatePolicy: "increment",
                  isFormula: false,
                  isProtected: false,
                },
              ],
              keyColumns: ["segment", "offer_result"],
              metricColumns: ["actual_sends"],
              statusColumns: [],
              textColumns: ["follow_up_message"],
              formulaColumns: [],
              protectedColumns: ["follow_up_message"],
              rowMatchingRules: {
                keyColumns: ["segment", "offer_result"],
                minimumConfidence: 0.8,
                ambiguityDelta: 0.05,
              },
              fingerprint: "profile-1",
            },
            entities: [],
            rowMatches: [
              {
                confidence: 0.82,
                evidence: ["совпал партнёрский сегмент"],
                entity: {
                  entityId: "partner-outreach",
                  rowNumber: 11,
                  rowKey: "Маркетологи / партнёры | Партнёрский вход",
                  normalizedKey: "маркетологи партнеры партнерский вход",
                  aliases: ["маркетологи партнеры"],
                  values: [
                    "2026-07-22",
                    "Маркетологи / партнёры",
                    "",
                    "Партнёрский вход",
                    "",
                    "Follow-up ещё не зафиксирован",
                    "",
                    3,
                    3,
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };

  const reconciled = reconcileStrategicPlanWithSheets(
    { kind: "ready", plan: basePlan },
    basePlan.sourceText,
    workspace,
  );

  assert.equal(reconciled.kind, "ready");
  if (reconciled.kind !== "ready") return;
  const action = reconciled.plan.actions[0];
  assert.equal(action.type, "update_sheet");
  if (action.type !== "update_sheet") return;
  assert.equal(action.payload.range, "'ОФФЕРЫ И РАССЫЛКИ'!I11");
  assert.deepEqual(action.payload.values, [[13]]);
  assert.equal(reconciled.plan.strategicPlan?.targetResources[0].rowNumber, 11);
  assert.deepEqual(
    reconciled.plan.strategicPlan?.actions.map((item) => item.kind),
    ["execute_action", "recalculate_metrics", "audit_log", "verify_result"],
  );
  assert.equal(
    reconciled.plan.strategicPlan?.suggestions[0].id,
    "suggest-follow-up",
  );
});

test("policy normalization cannot downgrade a destructive sheet action", () => {
  const actionPlan = normalizeStrategicActionPlan(
    {
      userGoal: "Очистить данные",
      projectId: "invented-project",
      targetResources: [],
      factsFromMessage: [],
      factsFromContext: [],
      assumptions: [],
      actions: [
        {
          id: "clear-data",
          kind: "execute_action",
          linkedActionId: "action-1",
          actionType: "update_sheet",
          reason: "Запрошена очистка.",
          evidence: ["Очисти диапазон"],
          confidence: 1,
          executionPolicy: "auto_execute",
          expectedChange: "Очистить диапазон.",
          verification: "Перечитать диапазон.",
        },
      ],
      suggestions: [],
      clarification: null,
      summaryIntent: "Очистить диапазон",
    },
    {
      sourceText: "Очисти диапазон",
      projectContext,
      actions: [
        {
          id: "action-1",
          type: "update_sheet",
          payload: {
            target: { kind: "id", spreadsheetId: "sheet-1" },
            range: "'ДАННЫЕ'!A2:C20",
            operation: "clear_range",
          },
        },
      ],
    },
  );

  assert.equal(actionPlan.projectId, "launch");
  assert.equal(actionPlan.actions[0].executionPolicy, "confirm_first");
  assert.deepEqual(validateStrategicActionPlan(actionPlan), []);
});
