import assert from "node:assert/strict";
import test from "node:test";
import { runAssistantPipeline } from "../lib/agents/assistant/assistant-core";
import type { AssistantProjectContext } from "../lib/agents/assistant/project-context";
import type {
  ActionPlan,
  ActionResult,
  AssistantPlanOutcome,
} from "../lib/agents/assistant/types";
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
              mode: "analytics",
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
