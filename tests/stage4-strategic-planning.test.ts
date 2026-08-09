import assert from "node:assert/strict";
import test from "node:test";
import { planAssistantMessage } from "../lib/agents/assistant/assistant-planner";
import {
  enforceAssistantSafety,
  groundReadActionsToWorkspace,
  shouldInspectGoogleSheets,
} from "../lib/agents/assistant/assistant-core";
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
  assert.match(requestBody, /готовое управленческое решение/u);
  assert.match(requestBody, /Адаптируй длину и форму/u);
  assert.match(requestBody, /Не показывай без прямого запроса номера строк/u);
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

test("analytics reads always continue into an evidence-based planning pass", async () => {
  const outcome = await planAssistantMessage(
    "Проанализируй таблицу и покажи узкие места",
    {
      apiKey: "test-key",
      fetchImplementation: (async () =>
        Response.json({
          status: "completed",
          output_text: JSON.stringify({
            outcome: {
              kind: "ready",
              mode: "analytics",
              actions: [
                {
                  id: "read-1",
                  type: "read_sheet",
                  payload: {
                    target: { kind: "title", title: "Мои материалы" },
                    range: "'01 СКРЫТЫЕ ДЕНЬГИ'!A1:L40",
                  },
                },
              ],
              continueAfterReads: false,
              strategicPlan: null,
            },
          }),
        })) as typeof fetch,
    },
  );

  assert.equal(outcome?.kind, "ready");
  if (!outcome || outcome.kind !== "ready") return;
  assert.equal(outcome.plan.continueAfterReads, true);
});

test("six safe analytical reads never require mass-operation confirmation", () => {
  const sourceText =
    "Проанализируй мои таблицы и разложи стратегию получения первой оплаты.";
  const outcome = enforceAssistantSafety(sourceText, {
    kind: "ready",
    plan: {
      version: 1,
      mode: "analytics",
      sourceText,
      continueAfterReads: true,
      actions: Array.from({ length: 6 }, (_, index) => ({
        id: `read-${index + 1}`,
        type: "read_sheet" as const,
        payload: {
          target: {
            kind: "id" as const,
            spreadsheetId: `sheet-${index + 1}`,
          },
          range: `'Лист ${index + 1}'!A1:L50`,
        },
      })),
    },
  });

  assert.equal(outcome.kind, "ready");
});

test("grounds strategic ranges to real tabs and the 500-cell read limit", () => {
  const sourceText = "Проанализируй таблицы и найди путь к первой оплате";
  const outcome = groundReadActionsToWorkspace(
    {
      kind: "ready",
      plan: {
        version: 1,
        mode: "analytics",
        sourceText,
        continueAfterReads: true,
        actions: [
          {
            id: "read-plan",
            type: "read_sheet",
            payload: {
              target: { kind: "id", spreadsheetId: "launch" },
              range: "'План'!A1:L50",
            },
          },
          {
            id: "read-leads",
            type: "read_sheet",
            payload: {
              target: { kind: "id", spreadsheetId: "materials" },
              range: "'Лиды'!A1:L50",
            },
          },
        ],
      },
    },
    {
      availableDocuments: [],
      inspectedDocuments: [
        {
          spreadsheetId: "launch",
          title: "Запуск магазина ИИ-агентов — 90 дней",
          spreadsheetUrl: "https://example.com/launch",
          tabs: [{ title: "ПЛАН НА 90 ДНЕЙ" }],
        },
        {
          spreadsheetId: "materials",
          title: "Мои материалы",
          spreadsheetUrl: "https://example.com/materials",
          tabs: [{ title: "Лиды" }],
        },
      ],
    } as unknown as GoogleSheetsWorkspaceContext,
  );

  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  assert.deepEqual(
    outcome.plan.actions.map((action) =>
      action.type === "read_sheet" ? action.payload.range : null,
    ),
    ["'ПЛАН НА 90 ДНЕЙ'!A1:L41", "'Лиды'!A1:L41"],
  );
});

test("uses a lightweight discovery schema for a cross-document strategy request", async () => {
  let requestBody = "";
  const outcome = await planAssistantMessage(
    "Проанализируй таблицы Мои материалы и Запуск магазина. Найди быстрые деньги и дай план действий.",
    {
      apiKey: "test-key",
      googleSheetsContext: [
        "Документ: Мои материалы",
        "spreadsheet_id: materials",
        "Лист: 01 СКРЫТЫЕ ДЕНЬГИ",
        "Документ: Запуск магазина ИИ-агентов — 90 дней",
        "spreadsheet_id: launch",
        "Лист: ДАШБОРД",
      ].join("\n"),
      fetchImplementation: (async (_input, init) => {
        requestBody = String(init?.body ?? "");
        return Response.json({
          status: "completed",
          output_text: JSON.stringify({
            reads: [
              {
                spreadsheetId: "materials",
                range: "'01 СКРЫТЫЕ ДЕНЬГИ'!A1:L200",
              },
              {
                spreadsheetId: "launch",
                range: "'ДАШБОРД'!A1:L200",
              },
            ],
          }),
        });
      }) as typeof fetch,
    },
  );

  assert.equal(outcome?.kind, "ready");
  if (!outcome || outcome.kind !== "ready") return;
  assert.equal(outcome.plan.mode, "analytics");
  assert.equal(outcome.plan.continueAfterReads, true);
  assert.deepEqual(
    outcome.plan.actions.map((action) =>
      action.type === "read_sheet" ? action.payload.target : null,
    ),
    [
      { kind: "id", spreadsheetId: "materials" },
      { kind: "id", spreadsheetId: "launch" },
    ],
  );
  assert.match(requestBody, /assistant_strategic_discovery/u);
  assert.doesNotMatch(requestBody, /assistant_plan_outcome/u);
});

test("final analytical pass can return only a strategic response", async () => {
  let requestBody = "";
  const outcome = await planAssistantMessage(
    "Покажи, где сейчас самые быстрые деньги",
    {
      apiKey: "test-key",
      analysisOnly: true,
      toolContext: JSON.stringify([
        {
          action: { type: "read_sheet" },
          result: { status: "succeeded", message: "Дмитрий: договор готовится" },
        },
      ]),
      fetchImplementation: (async (_input, init) => {
        requestBody = String(init?.body ?? "");
        return Response.json({
          status: "completed",
          output_text: JSON.stringify({
            conclusion:
              "Ближайший путь к деньгам — довести договор Дмитрия до следующего подтверждённого шага.",
            strategicView:
              "Спрос уже подтверждён движением договора; слабое место — отсутствие зафиксированного следующего шага.",
            actions: [
              {
                priority: "Сегодня",
                subject: "Дмитрий",
                action: "уточнить последний блокер и согласовать дату следующего решения",
                evidence: "договор находится в подготовке",
                why: "эта сделка ближе остальных к оплате",
                expectedResult: "зафиксирован следующий шаг по договору",
              },
            ],
            doNotDo: ["Не распыляться на холодный поиск до ответа Дмитрия."],
            rationale: ["Договор уже движется и требует закрытия следующего шага."],
            uncertainties: ["В данных нет подтверждённой даты оплаты."],
          }),
        });
      }) as typeof fetch,
    },
  );

  assert.equal(outcome?.kind, "response");
  if (!outcome || outcome.kind !== "response") return;
  assert.match(outcome.text, /Ближайший путь к деньгам/u);
  assert.match(outcome.text, /Мой стратегический взгляд/u);
  assert.match(outcome.text, /Дмитрий/u);
  assert.match(outcome.text, /Основание: договор находится в подготовке/u);
  assert.match(outcome.text, /Что важно проверить/u);
  assert.match(requestBody, /assistant_strategic_response/u);
  assert.match(requestBody, /готовое управленческое решение/u);
  assert.match(requestBody, /Текущая дата runtime: \d{4}-\d{2}-\d{2}/u);
  assert.match(requestBody, /Прошедшую дату можно упомянуть только как evidence просрочки/u);
});

test("retries a truncated strategic response once with compact context", async () => {
  let calls = 0;
  const outcome = await planAssistantMessage("Где сейчас быстрые деньги?", {
    apiKey: "test-key",
    analysisOnly: true,
    toolContext: "Дмитрий — договор готов; Марина — ждёт следующий шаг",
    fetchImplementation: (async () => {
      calls += 1;
      return calls === 1
        ? Response.json({
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          })
        : Response.json({
            status: "completed",
            output_text: JSON.stringify({
              conclusion: "Фокус — договор Дмитрия.",
              strategicView: "Это ближайшая подтверждённая возможность.",
              actions: [
                {
                  priority: "Сегодня",
                  subject: "Дмитрий",
                  action: "согласовать следующий шаг по договору",
                  evidence: "договор готов",
                  why: "сделка ближе других к результату",
                  expectedResult: "следующий шаг зафиксирован",
                },
              ],
              doNotDo: [],
              rationale: ["Есть готовый договор."],
              uncertainties: [],
            }),
          });
    }) as typeof fetch,
  });

  assert.equal(calls, 2);
  assert.equal(outcome?.kind, "response");
  if (!outcome || outcome.kind !== "response") return;
  assert.match(outcome.text, /Дмитрий/u);
  assert.match(outcome.text, /Основание: договор готов/u);
});

test("keeps an explicitly named document separate from its tab", () => {
  const plan: ActionPlan = {
    version: 1,
    mode: "analytics",
    sourceText: "Проанализируй таблицу «Мои материалы»",
    actions: [
      {
        id: "read-1",
        type: "read_sheet",
        payload: {
          target: { kind: "title", title: "01 СКРЫТЫЕ ДЕНЬГИ" },
          range: "'01 СКРЫТЫЕ ДЕНЬГИ'!A1:L40",
        },
      },
    ],
  };
  const workspace = {
    availableDocuments: [],
    inspectedDocuments: [
      {
        spreadsheetId: "materials-sheet",
        title: "Мои материалы",
        spreadsheetUrl: "https://example.com/materials-sheet",
        tabs: [{ title: "01 СКРЫТЫЕ ДЕНЬГИ" }],
      },
    ],
  } as unknown as GoogleSheetsWorkspaceContext;

  const reconciled = reconcileStrategicPlanWithSheets(
    { kind: "ready", plan },
    plan.sourceText,
    workspace,
  );

  assert.equal(reconciled.kind, "ready");
  if (reconciled.kind !== "ready") return;
  const action = reconciled.plan.actions[0];
  assert.equal(action.type, "read_sheet");
  if (action.type !== "read_sheet") return;
  assert.deepEqual(action.payload.target, {
    kind: "id",
    spreadsheetId: "materials-sheet",
  });
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
