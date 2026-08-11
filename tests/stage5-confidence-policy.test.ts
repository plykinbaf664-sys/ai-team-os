import assert from "node:assert/strict";
import test from "node:test";
import {
  createPolicyBlockedResults,
  evaluateActionPlanPolicy,
  filterExecutableActionPlan,
  formatAdaptiveQuestions,
} from "../lib/agents/assistant/confidence-policy";
import type { AssistantProjectContext } from "../lib/agents/assistant/project-context";
import { attachStrategicPlan } from "../lib/agents/assistant/strategic-planner";
import type { ActionPlan } from "../lib/agents/assistant/types";

const resolvedContext: AssistantProjectContext = {
  telegramUserId: 1,
  telegramChatId: 1,
  resolution: "resolved",
  resolutionReason: "active_project_setting",
  confidence: 1,
  candidates: [],
  activeProject: {
    id: "project-1",
    name: "AI Marketplace",
    status: "active",
    kpis: [],
    aliases: [],
    resources: [
      {
        id: "resource-1",
        projectId: "project-1",
        resourceType: "google_sheet",
        externalId: "sheet-1",
        title: "Launch Tracker",
        metadata: {},
      },
    ],
    glossary: [],
    operatingRules: [],
    decisions: [],
    recentActions: [],
  },
};

test("executes a single safe write when project, resource and row agree", () => {
  const plan = sheetPlan("sheet-1", "'OUTREACH'!I11");
  plan.strategicPlan!.targetResources = [
    {
      type: "google_sheet",
      externalId: "sheet-1",
      title: "Launch Tracker",
      sheetName: "OUTREACH",
      entityId: "partner-row",
      rowNumber: 11,
    },
  ];
  const evaluation = evaluateActionPlanPolicy(plan, resolvedContext);

  assert.deepEqual(evaluation.executableActionIds, ["action-1"]);
  assert.deepEqual(evaluation.blockedActionIds, []);
  assert.equal(evaluation.clarificationQuestions.length, 0);
  assert.ok(evaluation.assessments[0].confidence >= 0.8);
});

test("does not trust a hallucinated sheet even with high LLM confidence", () => {
  const plan = sheetPlan("invented-sheet", "'INVENTED'!C2");
  plan.strategicPlan!.actions[0].confidence = 0.99;
  plan.strategicPlan!.targetResources = [];
  const evaluation = evaluateActionPlanPolicy(plan, resolvedContext);

  assert.deepEqual(evaluation.executableActionIds, []);
  assert.deepEqual(evaluation.blockedActionIds, ["action-1"]);
  assert.equal(evaluation.assessments[0].decision, "clarify");
});

test("uses concrete project candidates in an ambiguity question", () => {
  const ambiguousContext: AssistantProjectContext = {
    telegramUserId: 1,
    telegramChatId: 1,
    resolution: "ambiguous",
    resolutionReason: "multiple_project_candidates",
    confidence: 0,
    candidates: [
      { ...resolvedContext.activeProject!, id: "one", name: "Agentic Sprint" },
      { ...resolvedContext.activeProject!, id: "two", name: "Партнёрский аудит" },
    ],
  };
  const plan = sheetPlanByTitle();
  const evaluation = evaluateActionPlanPolicy(plan, ambiguousContext);

  assert.equal(evaluation.assessments[0].decision, "clarify");
  assert.match(evaluation.clarificationQuestions[0], /Agentic Sprint/);
  assert.match(evaluation.clarificationQuestions[0], /Партнёрский аудит/);
});

test("allows an unambiguous action while blocking an independent unsafe one", () => {
  const readPlan: ActionPlan = {
    version: 1,
    mode: "batch_report",
    sourceText: "Покажи задачи и обнови неизвестную таблицу",
    actions: [
      { id: "action-1", type: "list_tasks", payload: {} },
      {
        id: "action-2",
        type: "update_sheet",
        payload: {
          target: { kind: "id", spreadsheetId: "invented-sheet" },
          range: "'UNKNOWN'!A2",
          operation: "update_cells",
          values: [[1]],
        },
      },
    ],
  };
  const plan = attachStrategicPlan(readPlan, resolvedContext);
  const evaluation = evaluateActionPlanPolicy(plan, resolvedContext);
  const executable = filterExecutableActionPlan(plan, evaluation);
  const blocked = createPolicyBlockedResults(plan, evaluation);

  assert.deepEqual(evaluation.executableActionIds, ["action-1"]);
  assert.deepEqual(evaluation.blockedActionIds, ["action-2"]);
  assert.deepEqual(executable?.actions.map((action) => action.id), ["action-1"]);
  assert.equal(blocked[0].status, "needs_clarification");
});

test("critical changes cannot bypass confirmation through confidence", () => {
  const plan = sheetPlan("sheet-1", "'OUTREACH'!A2:I50", "clear_range");
  plan.strategicPlan!.actions[0].confidence = 1;
  const evaluation = evaluateActionPlanPolicy(plan, resolvedContext);

  assert.equal(evaluation.assessments[0].risk, "critical");
  assert.equal(evaluation.assessments[0].decision, "confirm");
});

test("one explicitly selected task can be completed without another question", () => {
  const base: ActionPlan = {
    version: 1,
    mode: "quick_command",
    sourceText: "Заверши задачу task-42",
    actions: [
      {
        id: "action-1",
        type: "complete_task",
        payload: { taskId: "task-42" },
      },
    ],
  };
  const plan = attachStrategicPlan(base, resolvedContext);
  const evaluation = evaluateActionPlanPolicy(plan, resolvedContext);

  assert.equal(evaluation.assessments[0].decision, "execute");
});

test("small grounded task sync is automatic but a mass sync needs confirmation", () => {
  const makePlan = (count: number): ActionPlan => ({
    version: 1,
    mode: "batch_report",
    sourceText: "Синхронизируй конкретные задачи с таблицей",
    actions: Array.from({ length: count }, (_, index) => ({
      id: `task-${index + 1}`,
      type: "update_task" as const,
      payload: {
        taskId: `external-${index + 1}`,
        changes: { priority: "low" as const },
      },
    })),
    strategicPlan: {
      version: 1,
      userGoal: "Синхронизировать задачи",
      projectId: "project-1",
      targetResources: [],
      factsFromMessage: [],
      factsFromContext: [],
      assumptions: [],
      actions: Array.from({ length: count }, (_, index) => ({
        id: `execute-${index + 1}`,
        kind: "execute_action" as const,
        linkedActionId: `task-${index + 1}`,
        actionType: "update_task" as const,
        reason: "Задача однозначно сопоставлена.",
        evidence: [`external-${index + 1}`],
        confidence: 0.95,
        executionPolicy: "auto_execute" as const,
        expectedChange: "Понизить приоритет.",
        verification: "Перечитать задачу.",
      })),
      suggestions: [],
      summaryIntent: "Синхронизировать задачи.",
    },
  });

  const small = evaluateActionPlanPolicy(makePlan(5), resolvedContext);
  const mass = evaluateActionPlanPolicy(makePlan(6), resolvedContext);

  assert.ok(small.assessments.every((item) => item.decision === "execute"));
  assert.ok(mass.assessments.every((item) => item.decision === "confirm"));
});

test("adaptive questions deduplicate and number only when needed", () => {
  assert.equal(formatAdaptiveQuestions(["Какой проект?", "Какой проект?"]), "Какой проект?");
  assert.equal(
    formatAdaptiveQuestions(["Какой проект?", "Какая строка?"]),
    "Нужно уточнить:\n1. Какой проект?\n2. Какая строка?",
  );
});

function sheetPlan(
  spreadsheetId: string,
  range: string,
  operation: "update_cells" | "clear_range" = "update_cells",
) {
  const base: ActionPlan = {
    version: 1,
    mode: "quick_command",
    sourceText: "Добавь 10 отправок",
    actions: [
      {
        id: "action-1",
        type: "update_sheet",
        payload: {
          target: { kind: "id", spreadsheetId },
          range,
          operation,
          values: operation === "update_cells" ? [[13]] : undefined,
        },
      },
    ],
  };
  return attachStrategicPlan(base, resolvedContext);
}

function sheetPlanByTitle() {
  const base: ActionPlan = {
    version: 1,
    mode: "quick_command",
    sourceText: "Обнови партнёрские отправки",
    actions: [
      {
        id: "action-1",
        type: "update_sheet",
        payload: {
          target: { kind: "title", title: "Launch Tracker" },
          range: "'OUTREACH'!I11",
          operation: "update_cells",
          values: [[13]],
        },
      },
    ],
  };
  return attachStrategicPlan(base);
}
