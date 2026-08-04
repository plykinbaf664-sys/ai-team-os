import assert from "node:assert/strict";
import test from "node:test";
import {
  createPolicyBlockedResults,
  evaluateActionPlanPolicy,
} from "../lib/agents/assistant/confidence-policy";
import type { AssistantProjectContext } from "../lib/agents/assistant/project-context";
import { composeStrategicResponse } from "../lib/agents/assistant/strategic-response-composer";
import { coordinateTickTickPlan } from "../lib/agents/assistant/ticktick-coordination";
import type { ActionPlan } from "../lib/agents/assistant/types";

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
    kpis: [],
    aliases: [],
    resources: [
      {
        id: "sheet-resource",
        projectId: "project-1",
        resourceType: "google_sheet",
        externalId: "sheet-1",
        title: "Запуск магазина ИИ-агентов — 90 дней",
        metadata: {},
      },
      {
        id: "task-resource",
        projectId: "project-1",
        resourceType: "ticktick_project",
        externalId: "ticktick-project-1",
        title: "AI Team OS",
        metadata: {},
      },
    ],
    glossary: [],
    operatingRules: [
      { key: "follow_up", text: "Follow-up через 3 дня", priority: 100 },
    ],
    decisions: [],
    recentActions: [],
  },
};

test("turns an unrequested TickTick task into one linked suggestion", () => {
  const coordinated = coordinateTickTickPlan(reportWithProactiveTask(), {
    sourceText: "Сегодня сделал 10 партнёрских рассылок",
    projectContext: context,
  });
  const task = coordinated.actions.find((action) => action.type === "create_task");
  const policy = evaluateActionPlanPolicy(coordinated, context);

  assert.equal(task?.payload.project, "ticktick-project-1");
  assert.equal(task?.payload.sourceEntity?.entityId, "partner-row");
  assert.equal(
    coordinated.strategicPlan?.actions.find(
      (action) => action.linkedActionId === "task-action",
    )?.executionPolicy,
    "suggest_first",
  );
  assert.equal(
    coordinated.strategicPlan?.suggestions.filter(
      (suggestion) => suggestion.proposedTask,
    ).length,
    1,
  );
  assert.deepEqual(policy.executableActionIds, ["sheet-action"]);
  assert.deepEqual(policy.blockedActionIds, ["task-action"]);
  assert.deepEqual(policy.clarificationQuestions, []);
});

test("executes an explicitly requested task with project and entity context", () => {
  const plan = reportWithProactiveTask();
  plan.actions = plan.actions.filter((action) => action.type === "create_task");
  plan.strategicPlan!.actions = plan.strategicPlan!.actions.filter(
    (action) => action.linkedActionId === "task-action",
  );
  const coordinated = coordinateTickTickPlan(plan, {
    sourceText: "Создай задачу сделать follow-up через 3 дня",
    projectContext: context,
  });
  const policy = evaluateActionPlanPolicy(coordinated, context);
  const task = coordinated.actions[0];

  assert.equal(task.type, "create_task");
  if (task.type !== "create_task") return;
  assert.equal(task.payload.project, "ticktick-project-1");
  assert.equal(task.payload.sourceEntity?.rowNumber, 11);
  assert.deepEqual(policy.executableActionIds, ["task-action"]);
  assert.equal(
    coordinated.strategicPlan?.suggestions.some(
      (suggestion) => suggestion.id === "suggest-task-action",
    ),
    false,
  );
});

test("accepts a task suggestion only in the relevant conversation", () => {
  const plan = reportWithProactiveTask();
  plan.actions = plan.actions.filter((action) => action.type === "create_task");
  plan.strategicPlan!.actions = plan.strategicPlan!.actions.filter(
    (action) => action.linkedActionId === "task-action",
  );
  const coordinated = coordinateTickTickPlan(plan, {
    sourceText: "да",
    conversation: [
      {
        role: "assistant",
        text: "Создать одну задачу в TickTick: сделать follow-up?",
      },
    ],
    projectContext: context,
  });

  assert.deepEqual(
    evaluateActionPlanPolicy(coordinated, context).executableActionIds,
    ["task-action"],
  );
});

test("selects one TickTick project by active project name and aliases", () => {
  const contextWithoutTaskLink: AssistantProjectContext = {
    ...context,
    activeProject: {
      ...context.activeProject!,
      resources: context.activeProject!.resources.filter(
        (resource) => resource.resourceType !== "ticktick_project",
      ),
    },
  };
  const plan = reportWithProactiveTask();
  plan.actions = plan.actions.filter((action) => action.type === "create_task");
  plan.strategicPlan!.actions = plan.strategicPlan!.actions.filter(
    (action) => action.linkedActionId === "task-action",
  );
  const coordinated = coordinateTickTickPlan(plan, {
    sourceText: "Создай задачу сделать follow-up",
    projectContext: contextWithoutTaskLink,
    tickTickProjectNames: [
      "💼Работа",
      "🚀 AI Marketplace — 90 дней",
      "🏠Личный",
    ],
  });
  const task = coordinated.actions[0];

  assert.equal(task.type, "create_task");
  if (task.type !== "create_task") return;
  assert.equal(task.payload.project, "🚀 AI Marketplace — 90 дней");

  const ambiguousPlan = reportWithProactiveTask();
  ambiguousPlan.actions = ambiguousPlan.actions.filter(
    (action) => action.type === "create_task",
  );
  const ambiguous = coordinateTickTickPlan(ambiguousPlan, {
    sourceText: "Создай задачу сделать follow-up",
    projectContext: contextWithoutTaskLink,
    tickTickProjectNames: ["AI Marketplace — 90 дней", "AI Marketplace — 30 дней"],
  });
  const ambiguousTask = ambiguous.actions[0];
  assert.equal(ambiguousTask.type, "create_task");
  if (ambiguousTask.type !== "create_task") return;
  assert.equal(ambiguousTask.payload.project, undefined);
});

test("builds a concrete follow-up proposal only from an exact rule", () => {
  const plan = reportWithProactiveTask();
  plan.actions = plan.actions.filter((action) => action.type === "update_sheet");
  plan.strategicPlan!.actions = plan.strategicPlan!.actions.filter(
    (action) => action.linkedActionId === "sheet-action",
  );
  const coordinated = coordinateTickTickPlan(plan, {
    sourceText: plan.sourceText,
    projectContext: context,
  });
  const proposal = coordinated.strategicPlan?.suggestions[0].proposedTask;

  assert.equal(proposal?.title, "Сделать follow-up по «Маркетологи / партнёры»");
  assert.equal(proposal?.dueDateText, "через 3 дня");
  assert.equal(proposal?.project, "ticktick-project-1");
  assert.equal(proposal?.sourceEntity?.entityId, "partner-row");
});

test("does not invent a date from a follow-up range", () => {
  const ambiguousContext: AssistantProjectContext = {
    ...context,
    activeProject: {
      ...context.activeProject!,
      operatingRules: [
        { key: "follow_up", text: "Follow-up через 2–3 дня", priority: 100 },
      ],
    },
  };
  const plan = reportWithProactiveTask();
  plan.actions = plan.actions.filter((action) => action.type === "update_sheet");
  plan.strategicPlan!.actions = plan.strategicPlan!.actions.filter(
    (action) => action.linkedActionId === "sheet-action",
  );
  plan.strategicPlan!.suggestions[0].reason = "Follow-up через 2–3 дня";
  const coordinated = coordinateTickTickPlan(plan, {
    sourceText: plan.sourceText,
    projectContext: ambiguousContext,
  });

  assert.equal(coordinated.strategicPlan?.suggestions[0].proposedTask, undefined);
});

test("response reports the sheet update but only recommends the task", () => {
  const coordinated = coordinateTickTickPlan(reportWithProactiveTask(), {
    sourceText: "Сегодня сделал 10 партнёрских рассылок",
    projectContext: context,
  });
  const policy = evaluateActionPlanPolicy(coordinated, context);
  const results = [
    {
      actionId: "sheet-action",
      actionType: "update_sheet" as const,
      status: "succeeded" as const,
      message: "Отправлено: 3 → 13. Изменение проверено повторным чтением.",
    },
    ...createPolicyBlockedResults(coordinated, policy),
  ];
  const response = composeStrategicResponse(coordinated, results);

  assert.match(response, /Выполнено/u);
  assert.match(response, /Рекомендация/u);
  assert.match(response, /Создать одну задачу в TickTick/u);
  assert.doesNotMatch(response, /Задача создана/u);
  assert.doesNotMatch(response, /Нужно уточнить/u);
});

function reportWithProactiveTask(): ActionPlan {
  return {
    version: 1,
    mode: "batch_report",
    sourceText: "Сегодня сделал 10 партнёрских рассылок",
    actions: [
      {
        id: "sheet-action",
        type: "update_sheet",
        payload: {
          target: { kind: "id", spreadsheetId: "sheet-1" },
          range: "'ОФФЕРЫ И РАССЫЛКИ'!I11",
          operation: "update_cells",
          values: [[13]],
        },
      },
      {
        id: "task-action",
        type: "create_task",
        payload: {
          title: "Сделать follow-up по партнёрскому сегменту",
          dueDateText: "через 3 дня",
        },
      },
    ],
    strategicPlan: {
      version: 1,
      userGoal: "Зафиксировать отправки",
      projectId: "project-1",
      targetResources: [
        {
          type: "google_sheet",
          externalId: "sheet-1",
          title: "Запуск магазина ИИ-агентов — 90 дней",
          sheetName: "ОФФЕРЫ И РАССЫЛКИ",
          entityId: "partner-row",
          entityLabel: "Маркетологи / партнёры",
          rowNumber: 11,
        },
      ],
      factsFromMessage: [],
      factsFromContext: [],
      assumptions: [],
      actions: [
        {
          id: "execute-sheet",
          kind: "execute_action",
          linkedActionId: "sheet-action",
          actionType: "update_sheet",
          reason: "Обновить факт отправок",
          evidence: ["строка 11", "3 + 10"],
          confidence: 0.98,
          executionPolicy: "auto_execute",
          expectedChange: "actual_sends: 3 → 13",
          verification: "Прочитать I11",
        },
        {
          id: "execute-task",
          kind: "execute_action",
          linkedActionId: "task-action",
          actionType: "create_task",
          reason: "Следующее действие",
          evidence: ["follow-up через 3 дня"],
          confidence: 0.9,
          executionPolicy: "auto_execute",
          expectedChange: "Создать задачу",
          verification: "Проверить TickTick",
        },
      ],
      suggestions: [
        {
          id: "suggest-follow-up",
          title: "Запланировать follow-up",
          reason: "В проекте действует правило follow-up через 3 дня.",
          evidence: ["project rule follow_up"],
          confidence: 0.9,
        },
      ],
      summaryIntent: "Обновить партнёрский сегмент",
    },
  };
}
