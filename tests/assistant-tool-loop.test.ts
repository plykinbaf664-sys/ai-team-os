import assert from "node:assert/strict";
import test from "node:test";
import {
  groundReadActionsToWorkspace,
  runAssistantPipeline,
} from "../lib/agents/assistant/assistant-core";
import type { AssistantProjectContext } from "../lib/agents/assistant/project-context";
import type {
  ActionPlan,
  ActionResult,
  AssistantPlanOutcome,
} from "../lib/agents/assistant/types";
import {
  createDiscoveryPlan,
  ensureTaskMutationDiscovery,
  formatAssistantToolContext,
} from "../lib/agents/assistant/tool-loop";
import {
  reconcileOperationalActions,
  resolveOperationalContinuation,
} from "../lib/agents/assistant/operational-reconciliation";
import { requestsStrategicOutput } from "../lib/agents/assistant/assistant-planner";
import type { GoogleSheetsWorkspaceContext } from "../lib/integrations/google-sheets/document-context";
import {
  executeTickTickAction,
  resolveTaskDueDate,
} from "../lib/executors/ticktick-executor";
import type { TickTickAdapter } from "../lib/integrations/ticktick/types";

const LAST_REQUEST =
  "Сегодня созвон был на 14:00. Найди карточку в TickTick, добавь пометку получить подтверждение и перенеси дату. Если информация есть в таблице интервью, тоже обнови её.";

test("bounded tool loop reads, replans once and executes grounded updates", async () => {
  const planningCalls: Array<{ toolContext?: string }> = [];
  const executionPlans: ActionPlan[] = [];
  const firstPlan = discoveryOutcome();
  const secondPlan = finalOutcome();
  const result = await runAssistantPipeline(LAST_REQUEST, {
    projectContext: resolvedProjectContext(),
    planImplementation: async (_text, options) => {
      planningCalls.push({ toolContext: options.toolContext });
      return planningCalls.length === 1 ? firstPlan : secondPlan;
    },
    executeImplementation: async (plan) => {
      executionPlans.push(plan);

      if (executionPlans.length === 1) {
        const readSheet = plan.actions.find(
          (action) => action.type === "read_sheet",
        );
        assert.equal(readSheet?.type, "read_sheet");
        if (readSheet?.type === "read_sheet") {
          assert.deepEqual(readSheet.payload.target, {
            kind: "id",
            spreadsheetId: "sheet-1",
          });
        }

        return plan.actions.map((action): ActionResult =>
          action.type === "list_tasks"
            ? {
                actionId: action.id,
                actionType: action.type,
                status: "succeeded",
                message: "Найдена задача Созвон с партнёром на 14:00.",
                data: {
                  kind: "ticktick_tasks",
                  tasks: [
                    {
                      id: "task-14",
                      projectId: "tick-project",
                      projectName: "Активные сделки",
                      title: "Созвон с партнёром",
                      dueDate: "2026-08-05T14:00:00+0300",
                      priority: 3,
                    },
                  ],
                },
              }
            : {
                actionId: action.id,
                actionType: action.type,
                status: "succeeded",
                message: "В строке 8 найден созвон на 14:00.",
                data: {
                  kind: "sheet_range",
                  spreadsheetId: "sheet-1",
                  spreadsheetTitle: "Запуск магазина ИИ-агентов — 90 дней",
                  range: "'ИНТЕРВЬЮ'!A1:L100",
                  values: [
                    ["Имя", "Время", "Статус"],
                    ["Партнёр", "05.08.2026 14:00", "Не подтверждён"],
                  ],
                },
              },
        );
      }

      return plan.actions.map((action) => ({
        actionId: action.id,
        actionType: action.type,
        status: "succeeded" as const,
        message:
          action.type === "update_task"
            ? "Задача обновлена. Заметка добавлена."
            : "Карточка интервью обновлена.",
      }));
    },
  });

  assert.equal(planningCalls.length, 2);
  assert.match(planningCalls[1].toolContext ?? "", /task-14/u);
  assert.match(planningCalls[1].toolContext ?? "", /sheet-1/u);
  assert.equal(executionPlans.length, 2);
  assert.deepEqual(
    executionPlans[1].actions.map((action) => action.type),
    ["update_task", "update_sheet"],
  );
  assert.equal(result.outcome.kind, "ready");
  assert.equal(result.results.length, 4);
  assert.match(result.text, /На какую новую дату и время перенести созвон/iu);
});

test("analytical reads return a grounded strategic answer after replanning", async () => {
  let planningCalls = 0;
  const result = await runAssistantPipeline(
    "Проанализируй таблицу «Мои материалы» и дай короткий план",
    {
      planImplementation: async (_text, options) => {
        planningCalls += 1;
        if (!options.toolContext) {
          return {
            kind: "ready",
            plan: {
              version: 1,
              mode: "quick_command",
              sourceText: "Проанализируй таблицу",
              continueAfterReads: true,
              actions: [
                {
                  id: "read-money",
                  type: "read_sheet",
                  payload: {
                    target: { kind: "id", spreadsheetId: "materials-sheet" },
                    range: "'01 СКРЫТЫЕ ДЕНЬГИ'!A1:L40",
                  },
                },
              ],
            },
          };
        }

        assert.equal(options.analysisOnly, true);
        assert.match(options.toolContext, /Тёплый лид/u);
        return {
          kind: "response",
          text: "Фокус: сначала дожать тёплые лиды. 1. Связаться с тремя контактами.",
        };
      },
      executeImplementation: async (plan) =>
        plan.actions.map((action) => ({
          actionId: action.id,
          actionType: action.type,
          status: "succeeded" as const,
          message: "Данные прочитаны.",
          data: {
            kind: "sheet_range" as const,
            spreadsheetId: "materials-sheet",
            spreadsheetTitle: "Мои материалы",
            range: "'01 СКРЫТЫЕ ДЕНЬГИ'!A1:L40",
            values: [["Приоритет", "Состояние"], ["Тёплый лид", "Готов к контакту"]],
          },
        })),
    },
  );

  assert.equal(planningCalls, 2);
  assert.match(result.text, /дожать тёплые лиды/u);
  assert.equal(result.results[0].status, "succeeded");
});

test("title-only TickTick mutations are converted to hidden searches", () => {
  const plan: ActionPlan = {
    version: 1,
    mode: "batch_report",
    sourceText: "Обнови карточки Анастасии и Дмитрия",
    actions: [
      {
        id: "anastasia",
        type: "update_task",
        payload: {
          taskTitle: "Анастасия Речанская",
          changes: { contentNote: "Согласование оплаты может занять несколько месяцев." },
        },
      },
      {
        id: "dmitry",
        type: "update_task",
        payload: {
          taskTitle: "Дмитрий",
          changes: { contentNote: "Старт работы в сентябре после найма команды продаж." },
        },
      },
    ],
  };

  const prepared = ensureTaskMutationDiscovery(plan);
  const discovery = createDiscoveryPlan(prepared);

  assert.equal(prepared.continueAfterReads, true);
  assert.deepEqual(
    discovery?.actions.map((action) => action.payload),
    [
      { query: "Анастасия Речанская", limit: 50 },
      { query: "Дмитрий", limit: 50 },
    ],
  );
});

test("grounds short TickTick selectors by card context and prevents inferred moves", () => {
  const sourceText =
    "Обнови карточку Анастасии: согласование оплаты может занять несколько месяцев. В карточке Дмитрия отметь, что работа начнётся в сентябре после найма команды продаж.";
  const outcome: AssistantPlanOutcome = {
    kind: "ready",
    plan: {
      version: 1,
      mode: "batch_report",
      sourceText,
      actions: [
        {
          id: "anastasia",
          type: "update_task",
          payload: {
            taskTitle: "Анастасия Речанская",
            changes: {
              contentNote: "Оплата может задержаться на несколько месяцев из-за согласований.",
              project: "AI Marketplace — 90 дней",
            },
          },
        },
        {
          id: "dmitry",
          type: "update_task",
          payload: {
            taskTitle: "Дмитрий",
            changes: {
              contentNote: "Работа начнётся в сентябре после найма команды продаж.",
              project: "AI Marketplace — 90 дней",
            },
          },
        },
      ],
    },
  };
  const reconciled = reconcileOperationalActions(outcome, {
    sourceText,
    conversation: [],
    discoveryResults: [
      tickTickTasksResult([
        {
          id: "anastasia-id",
          projectId: "money",
          projectName: "Скрытые деньги",
          title: "Анастасия Речанская — получить срок решения по 100 000 ₽",
          content: "Оффер на внутреннем согласовании; оплата может занять несколько месяцев.",
          priority: 3,
        },
        {
          id: "dmitry-cashu",
          projectId: "money",
          projectName: "Скрытые деньги",
          title: "Дмитрий CashU — вернуться после настройки отдела продаж",
          content: "В сентябре нанимает и обучает команду продаж; работу начать после этого.",
          priority: 1,
        },
        {
          id: "dmitry-offer",
          projectId: "money",
          projectName: "Скрытые деньги",
          title: "Дмитрий Щерба — одно повторное касание по КП",
          content: "Отправлено коммерческое предложение.",
          priority: 1,
        },
        {
          id: "dmitry-structure",
          projectId: "money",
          projectName: "Скрытые деньги",
          title: "Дмитрий Чернышев — отправить структуру",
          content: "Следующий шаг — отправить материалы.",
          priority: 1,
        },
      ]),
    ],
  });

  assert.equal(reconciled.kind, "ready");
  if (reconciled.kind !== "ready") return;
  const taskActions = reconciled.plan.actions.filter(
    (action): action is Extract<ActionPlan["actions"][number], { type: "update_task" }> =>
      action.type === "update_task",
  );
  assert.deepEqual(
    taskActions.map((action) => action.payload.taskId),
    ["anastasia-id", "dmitry-cashu"],
  );
  assert.equal(taskActions[0].payload.changes.project, undefined);
  assert.equal(taskActions[1].payload.changes.project, undefined);
});

test("combined strategy and cleanup request executes grounded changes", async () => {
  const sourceText =
    "Проанализируй стратегию: Ольга больше не в приоритете. Сверь таблицу и TickTick и приведи всё в порядок.";
  const planningOptions: Array<{ analysisOnly?: boolean; toolContext?: string }> = [];
  const executionPlans: ActionPlan[] = [];
  const result = await runAssistantPipeline(sourceText, {
    planImplementation: async (_text, options) => {
      planningOptions.push(options);
      if (!options.toolContext) {
        return {
          kind: "ready",
          plan: {
            version: 1,
            mode: "analytics",
            sourceText,
            continueAfterReads: true,
            actions: [
              { id: "tasks-1", type: "list_tasks", payload: { limit: 50 } },
              { id: "tasks-2", type: "list_tasks", payload: { limit: 50 } },
              {
                id: "sheet-1",
                type: "read_sheet",
                payload: {
                  target: { kind: "id", spreadsheetId: "money-sheet" },
                  range: "'Лиды'!A1:H40",
                },
              },
            ],
          },
        };
      }

      return {
        kind: "ready",
        plan: {
          version: 1,
          mode: "batch_report",
          sourceText,
          actions: [
            {
              id: "pause-olga",
              type: "update_task",
              payload: {
                taskId: "task-olga",
                changes: {
                  priority: "low",
                  contentNote: "Ольга в декрете; работа поставлена на паузу.",
                },
              },
            },
          ],
          strategicPlan: {
            version: 1,
            userGoal: sourceText,
            projectId: null,
            targetResources: [],
            factsFromMessage: [],
            factsFromContext: [],
            assumptions: [],
            actions: [
              {
                id: "execute-pause-olga",
                kind: "execute_action",
                linkedActionId: "pause-olga",
                actionType: "update_task",
                reason: "Ольга больше не находится в активном приоритете.",
                evidence: ["Пользователь сообщил, что Ольга в декрете."],
                confidence: 0.7,
                executionPolicy: "auto_execute",
                expectedChange: "Понизить приоритет и сохранить причину паузы.",
                verification: "Повторно проверить задачу.",
              },
            ],
            suggestions: [],
            summaryIntent: "Синхронизировать рабочие системы.",
          },
        },
      };
    },
    executeImplementation: async (plan) => {
      executionPlans.push(plan);
      if (executionPlans.length === 1) {
        return plan.actions.map((action): ActionResult =>
          action.type === "list_tasks"
            ? {
                actionId: action.id,
                actionType: action.type,
                status: "succeeded",
                message: "Прочитано 50 задач.",
                data: {
                  kind: "ticktick_tasks",
                  tasks: [
                    {
                      id: "task-other",
                      projectId: "work",
                      projectName: "Работа",
                      title: "10 касаний с тёплыми",
                      priority: 0,
                    },
                    {
                      id: "task-olga",
                      projectId: "money",
                      projectName: "Скрытые деньги",
                      title: "Ольга Журавлёва — созвон",
                      priority: 3,
                    },
                  ],
                },
              }
            : {
                actionId: action.id,
                actionType: action.type,
                status: "succeeded",
                message: "Таблица прочитана.",
                data: {
                  kind: "sheet_range",
                  spreadsheetId: "money-sheet",
                  spreadsheetTitle: "Скрытые деньги",
                  range: "'Лиды'!A1:H40",
                  values: [["Имя", "Статус"], ["Ольга Журавлёва", "Пауза — декрет"]],
                },
              },
        );
      }

      return plan.actions.map((action) => ({
        actionId: action.id,
        actionType: action.type,
        status: "succeeded" as const,
        message: "Задача Ольги обновлена: приоритет понижен, причина паузы сохранена.",
      }));
    },
  });

  assert.equal(planningOptions[1].analysisOnly, false);
  assert.deepEqual(
    executionPlans[0].actions.map((action) => action.type),
    ["list_tasks", "read_sheet"],
  );
  assert.equal(executionPlans[1].actions[0].type, "update_task");
  assert.doesNotMatch(result.text, /Прочитано 50 задач/u);
  assert.match(result.text, /приоритет понижен/u);
});

test("rejects an arbitrary TickTick task and a fake deletion note", () => {
  const outcome: AssistantPlanOutcome = {
    kind: "ready",
    plan: {
      version: 1,
      mode: "batch_report",
      sourceText: "Подчисти TickTick согласно стратегии в таблице",
      actions: [
        {
          id: "wrong-task",
          type: "update_task",
          payload: {
            taskId: "first-task",
            changes: { contentNote: "Задача устарела и удалена" },
          },
        },
      ],
    },
  };
  const reconciled = reconcileOperationalActions(outcome, {
    sourceText: outcome.plan.sourceText,
    conversation: [],
    discoveryResults: [
      {
        actionId: "read-tasks",
        actionType: "list_tasks",
        status: "succeeded",
        message: "Задачи прочитаны",
        data: {
          kind: "ticktick_tasks",
          tasks: [
            {
              id: "first-task",
              projectId: "work",
              projectName: "Работа",
              title: "10 касаний с тёплыми",
              priority: 0,
            },
          ],
        },
      },
      {
        actionId: "read-sheet",
        actionType: "read_sheet",
        status: "succeeded",
        message: "Таблица прочитана",
        data: {
          kind: "sheet_range",
          spreadsheetId: "money",
          spreadsheetTitle: "Скрытые деньги",
          range: "'Лиды'!A1:C10",
          values: [["Дмитрий", "Оплата"]],
        },
      },
    ],
  });

  assert.equal(reconciled.kind, "clarification");
});

test("restores the previous operational request for a short continuation", () => {
  const restored = resolveOperationalContinuation("Ты сам это можешь сделать?", [
    {
      role: "user",
      text: "Сверь стратегию с TickTick и таблицами и приведи всё в порядок.",
    },
    { role: "assistant", text: "Вот что стоит изменить." },
  ]);

  assert.match(restored, /Сверь стратегию/u);
  assert.match(restored, /выполни это самостоятельно/u);
});

test("strategy output is enabled only when the user asks for analysis", () => {
  assert.equal(
    requestsStrategicOutput("Синхронизируй TickTick с таблицами"),
    false,
  );
  assert.equal(
    requestsStrategicOutput(
      "Синхронизируй данные, найди узкие горлышки и дай пошаговую стратегию",
    ),
    true,
  );
});

test("grounds a tab name to its containing spreadsheet", () => {
  const outcome = groundReadActionsToWorkspace(
    {
      kind: "ready",
      plan: {
        version: 1,
        mode: "analytics",
        sourceText: "Проанализируй дашборд",
        actions: [
          {
            id: "read-dashboard",
            type: "read_sheet",
            payload: {
              target: { kind: "title", title: "ДАШБОРД" },
              range: "'ДАШБОРД'!A1:L40",
            },
          },
        ],
      },
    },
    {
      availableDocuments: [],
      inspectedDocuments: [
        {
          spreadsheetId: "money-sheet",
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/money-sheet",
          title: "Скрытые деньги",
          tabs: [
            {
              title: "ДАШБОРД",
              range: "'ДАШБОРД'!A1:L40",
              values: [],
            },
          ],
        },
      ],
    } as unknown as GoogleSheetsWorkspaceContext,
  );

  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const read = outcome.plan.actions[0];
  assert.equal(read.type, "read_sheet");
  if (read.type !== "read_sheet") return;
  assert.deepEqual(read.payload.target, {
    kind: "id",
    spreadsheetId: "money-sheet",
  });
});

test("never exposes repeated internal reads and still returns execution plus strategy", async () => {
  const sourceText =
    "Проверь таблицы и TickTick, синхронизируй всё, найди узкие горлышки и выдай пошаговую стратегию на неделю.";
  const planningOptions: Array<{ analysisOnly?: boolean; toolContext?: string }> = [];
  let executionPass = 0;
  const result = await runAssistantPipeline(sourceText, {
    planImplementation: async (_text, options) => {
      planningOptions.push(options);
      if (planningOptions.length === 1) {
        return {
          kind: "ready",
          plan: {
            version: 1,
            mode: "analytics",
            sourceText,
            continueAfterReads: true,
            actions: [
              { id: "tasks", type: "list_tasks", payload: { limit: 50 } },
              {
                id: "sheet",
                type: "read_sheet",
                payload: {
                  target: { kind: "id", spreadsheetId: "money-sheet" },
                  range: "'Лиды'!A1:H40",
                },
              },
            ],
          },
        };
      }
      if (planningOptions.length === 2) {
        return {
          kind: "ready",
          plan: {
            version: 1,
            mode: "analytics",
            sourceText,
            actions: [
              { id: "repeat-tasks", type: "list_tasks", payload: { limit: 50 } },
              {
                id: "fake-sheet",
                type: "read_sheet",
                payload: {
                  target: { kind: "title", title: "Лист1" },
                  range: "'Лист1'!A1:L40",
                },
              },
            ],
          },
        };
      }
      if (planningOptions.length === 3) {
        return {
          kind: "ready",
          plan: {
            version: 1,
            mode: "batch_report",
            sourceText,
            actions: [
              {
                id: "pause-olga",
                type: "update_task",
                payload: {
                  taskId: "task-olga",
                  changes: { priority: "low" },
                },
              },
            ],
            strategicPlan: {
              version: 1,
              userGoal: sourceText,
              projectId: null,
              targetResources: [],
              factsFromMessage: [],
              factsFromContext: [],
              assumptions: [],
              actions: [
                {
                  id: "execute-olga",
                  kind: "execute_action",
                  linkedActionId: "pause-olga",
                  actionType: "update_task",
                  reason: "Статус подтверждён таблицей.",
                  evidence: ["Ольга находится на паузе."],
                  confidence: 0.9,
                  executionPolicy: "auto_execute",
                  expectedChange: "Понизить приоритет.",
                  verification: "Перечитать задачу.",
                },
              ],
              suggestions: [],
              summaryIntent: "Синхронизировать системы.",
            },
          },
        };
      }
      assert.equal(options.analysisOnly, true);
      return {
        kind: "response",
        text: "Фокус недели — Дмитрий и Анастасия. Узкое место — просроченные следующие шаги.",
      };
    },
    executeImplementation: async (plan) => {
      executionPass += 1;
      if (executionPass === 1) {
        return plan.actions.map((action): ActionResult =>
          action.type === "list_tasks"
            ? {
                actionId: action.id,
                actionType: action.type,
                status: "succeeded",
                message: "Открытые задачи TickTick\n" + "• задача\n".repeat(50),
                data: {
                  kind: "ticktick_tasks",
                  tasks: [
                    {
                      id: "task-olga",
                      projectId: "money",
                      projectName: "Скрытые деньги",
                      title: "Ольга Журавлёва — созвон",
                      priority: 3,
                    },
                  ],
                },
              }
            : {
                actionId: action.id,
                actionType: action.type,
                status: "succeeded",
                message: "Таблица прочитана",
                data: {
                  kind: "sheet_range",
                  spreadsheetId: "money-sheet",
                  spreadsheetTitle: "Скрытые деньги",
                  range: "'Лиды'!A1:H40",
                  values: [["Ольга Журавлёва", "Пауза"]],
                },
              },
        );
      }
      return plan.actions.map((action) => ({
        actionId: action.id,
        actionType: action.type,
        status: "succeeded" as const,
        message: "Задача Ольги обновлена.",
      }));
    },
  });

  assert.equal(planningOptions.length, 4);
  assert.equal(planningOptions[1].analysisOnly, false);
  assert.equal(planningOptions[2].analysisOnly, false);
  assert.equal(planningOptions[3].analysisOnly, true);
  assert.doesNotMatch(result.text, /Открытые задачи TickTick/u);
  assert.match(result.text, /Задача Ольги обновлена/u);
  assert.match(result.text, /Фокус недели/u);
});

test("keeps evidence from every document when tool context is compacted", () => {
  const actions: ActionPlan["actions"] = Array.from({ length: 6 }, (_, index) => ({
    id: `read-${index + 1}`,
    type: "read_sheet" as const,
    payload: {
      target: { kind: "id" as const, spreadsheetId: `sheet-${index + 1}` },
      range: `'Лист ${index + 1}'!A1:L40`,
    },
  }));
  const plan: ActionPlan = {
    version: 1,
    mode: "analytics",
    sourceText: "Проанализируй все документы",
    actions,
  };
  const results: ActionResult[] = actions.map((action, index) => ({
    actionId: action.id,
    actionType: action.type,
    status: "succeeded",
    message: "Данные прочитаны",
    data: {
      kind: "sheet_range",
      spreadsheetId: `sheet-${index + 1}`,
      spreadsheetTitle: `Документ ${index + 1}`,
      range: `'Лист ${index + 1}'!A1:L40`,
      values: [
        ["Лид", "Статус", "Следующий шаг"],
        [`Контакт ${index + 1}`, "Активен", "x".repeat(12_000)],
      ],
    },
  }));
  const context = formatAssistantToolContext(plan, results);

  for (let index = 1; index <= 6; index += 1) {
    assert.match(context, new RegExp(`Документ ${index}`, "u"));
  }
  assert.ok(context.length <= 20_100);
});

test("one malformed read action no longer blocks an independent valid action", async () => {
  let executedTypes: string[] = [];
  const malformedPlan = {
    kind: "ready" as const,
    plan: {
      version: 1 as const,
      mode: "quick_command" as const,
      sourceText: "Покажи задачи и таблицу",
      actions: [
        { id: "action-1", type: "list_tasks" as const, payload: {} },
        {
          id: "action-2",
          type: "read_sheet" as const,
          payload: { range: "'ИНТЕРВЬЮ'!A1:L20" },
        },
      ],
      continueAfterReads: false,
    },
  } as unknown as AssistantPlanOutcome;

  const result = await runAssistantPipeline("Покажи задачи и таблицу", {
    planImplementation: async () => malformedPlan,
    executeImplementation: async (plan) => {
      executedTypes = plan.actions.map((action) => action.type);
      return plan.actions.map((action) => ({
        actionId: action.id,
        actionType: action.type,
        status: "succeeded" as const,
        message: "Задачи прочитаны.",
      }));
    },
  });

  assert.deepEqual(executedTypes, ["list_tasks"]);
  assert.equal(result.results[0].status, "succeeded");
  assert.equal(result.results[1].status, "needs_clarification");
  assert.match(result.text, /Задачи прочитаны/u);
});

test("TickTick note is appended without overwriting existing content", async () => {
  let updateInput:
    | Parameters<TickTickAdapter["updateTask"]>[0]
    | undefined;
  const adapter: TickTickAdapter = {
    listProjects: async () => [
      { id: "project-1", name: "Активные сделки", permission: "write" },
    ],
    getProjectData: async () => ({
      project: {
        id: "project-1",
        name: "Активные сделки",
        permission: "write",
      },
      tasks: [
        {
          id: "task-14",
          projectId: "project-1",
          title: "Созвон с партнёром",
          content: "Исходная заметка",
          priority: 3,
          status: 0,
        },
      ],
    }),
    createTask: async () => {
      throw new Error("not used");
    },
    updateTask: async (input) => {
      updateInput = input;
      return {
        id: input.id,
        projectId: input.projectId,
        title: input.title,
        content: input.content,
        priority: input.priority ?? 0,
        status: 0,
      };
    },
    completeTask: async () => undefined,
    moveTask: async () => undefined,
  };
  const result = await executeTickTickAction(
    {
      id: "action-1",
      type: "update_task",
      payload: {
        taskId: "task-14",
        changes: { contentNote: "Получить подтверждение нового времени" },
      },
    },
    adapter,
  );

  assert.equal(result?.status, "succeeded");
  assert.equal(
    updateInput?.content,
    "Исходная заметка\n\nПолучить подтверждение нового времени",
  );
});

test("TickTick reschedule preserves a concrete local time", () => {
  assert.deepEqual(
    resolveTaskDueDate(
      "7 августа 2026 в 16:00",
      "Europe/Moscow",
      new Date("2026-08-05T11:00:00Z"),
    ),
    {
      kind: "resolved",
      dueDate: "2026-08-07T13:00:00+0000",
      timeZone: "Europe/Moscow",
      isAllDay: false,
    },
  );
});

function discoveryOutcome(): AssistantPlanOutcome {
  return {
    kind: "ready",
    plan: {
      version: 1,
      mode: "quick_command",
      sourceText: LAST_REQUEST,
      continueAfterReads: true,
      actions: [
        { id: "action-1", type: "list_tasks", payload: { limit: 50 } },
        {
          id: "action-2",
          type: "read_sheet",
          payload: { range: "'ИНТЕРВЬЮ'!A1:L100" },
        } as ActionPlan["actions"][number],
      ],
    },
  };
}

function finalOutcome(): AssistantPlanOutcome {
  const plan: ActionPlan = {
    version: 1,
    mode: "batch_report",
    sourceText: LAST_REQUEST,
    continueAfterReads: false,
    actions: [
      {
        id: "update-task",
        type: "update_task",
        payload: {
          taskId: "task-14",
          changes: { contentNote: "Получить подтверждение нового времени" },
        },
      },
      {
        id: "update-sheet",
        type: "update_sheet",
        payload: {
          target: { kind: "id", spreadsheetId: "sheet-1" },
          range: "'ИНТЕРВЬЮ'!K8",
          operation: "update_cells",
          values: [["Созвон не подтверждён; получить подтверждение"]],
        },
      },
    ],
    strategicPlan: {
      version: 1,
      userGoal: LAST_REQUEST,
      projectId: "project-1",
      targetResources: [
        {
          type: "ticktick_project",
          externalId: "tick-project",
          title: "Активные сделки",
        },
        {
          type: "google_sheet",
          externalId: "sheet-1",
          title: "Запуск магазина ИИ-агентов — 90 дней",
          sheetName: "ИНТЕРВЬЮ",
          entityId: "interview-8",
          entityLabel: "Созвон 14:00",
          rowNumber: 8,
        },
      ],
      factsFromMessage: [],
      factsFromContext: [],
      assumptions: [],
      actions: [
        strategicAction("execute-task", "update-task", "update_task"),
        strategicAction("execute-sheet", "update-sheet", "update_sheet"),
      ],
      suggestions: [],
      clarification: {
        question: "На какую новую дату и время перенести созвон?",
        missingField: "new_schedule",
      },
      summaryIntent: "Обновить известные статусы и уточнить новое время.",
    },
  };

  return { kind: "ready", plan };
}

function strategicAction(
  id: string,
  linkedActionId: string,
  actionType: "update_task" | "update_sheet",
) {
  return {
    id,
    kind: "execute_action" as const,
    linkedActionId,
    actionType,
    reason: "Объект однозначно найден инструментами.",
    evidence: ["Точный ID и строка получены через read actions."],
    confidence: 0.98,
    executionPolicy: "auto_execute" as const,
    expectedChange: "Обновить подтверждённый объект.",
    verification: "Повторно прочитать объект через API.",
  };
}

function tickTickTasksResult(
  tasks: Extract<
    NonNullable<ActionResult["data"]>,
    { kind: "ticktick_tasks" }
  >["tasks"],
): ActionResult {
  return {
    actionId: "read-tasks",
    actionType: "list_tasks",
    status: "succeeded",
    message: "Карточки прочитаны.",
    data: { kind: "ticktick_tasks", tasks },
  };
}

function resolvedProjectContext(): AssistantProjectContext {
  const project = {
    id: "project-1",
    name: "AI Marketplace",
    status: "active",
    kpis: [],
    aliases: [],
    resources: [
      {
        id: "resource-1",
        projectId: "project-1",
        resourceType: "google_sheet" as const,
        externalId: "sheet-1",
        title: "Запуск магазина ИИ-агентов — 90 дней",
        metadata: {},
      },
    ],
    glossary: [],
    operatingRules: [],
    decisions: [],
    recentActions: [],
  };

  return {
    telegramUserId: 1,
    telegramChatId: 2,
    timezone: "Europe/Moscow",
    resolution: "resolved",
    resolutionReason: "active_project_setting",
    confidence: 1,
    activeProject: project,
    candidates: [project],
  };
}
