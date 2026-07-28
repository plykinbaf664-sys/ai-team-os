import type {
  ActionPlan,
  ActionResult,
  AssistantAction,
  AssistantMode,
  AssistantPlanOutcome,
  CreateTaskAction,
  MetricInput,
  SheetBlueprintTab,
  SheetCellValue,
  TaskPriority,
} from "./types";

const ASSISTANT_MODES: AssistantMode[] = [
  "quick_command",
  "batch_report",
  "create_structure",
  "analytics",
  "daily_summary",
];

const ACTION_TYPES: AssistantAction["type"][] = [
  "add_metrics",
  "update_metrics",
  "update_project_status",
  "create_task",
  "update_task",
  "complete_task",
  "create_calendar_event",
  "update_calendar_event",
  "create_sheet",
  "create_sheet_tab",
  "update_sheet",
  "create_sheet_blueprint",
  "analyze_metrics",
  "generate_daily_summary",
];

export type ActionPlanValidation =
  | { valid: true; plan: ActionPlan }
  | { valid: false; errors: string[] };

export type AssistantPipelineResult = {
  outcome: AssistantPlanOutcome;
  results: ActionResult[];
  text: string;
};

export function runAssistantPipeline(sourceText: string): AssistantPipelineResult {
  const outcome = createMockActionPlan(sourceText);

  if (outcome.kind === "clarification") {
    return {
      outcome,
      results: [],
      text: `Assistant Agent: ${outcome.question}`,
    };
  }

  if (outcome.kind === "confirmation") {
    return {
      outcome,
      results: [],
      text: [
        "Assistant Agent: требуется подтверждение.",
        outcome.operationSummary,
        outcome.reason,
        outcome.prompt,
      ].join("\n"),
    };
  }

  const validation = validateActionPlan(outcome.plan);

  if (!validation.valid) {
    return {
      outcome,
      results: [],
      text: `Assistant Agent: план отклонён проверкой — ${validation.errors.join("; ")}`,
    };
  }

  const results = executeMockActionPlan(validation.plan);

  return {
    outcome,
    results,
    text: formatMockResults(validation.plan, results),
  };
}

export function createMockActionPlan(sourceText: string): AssistantPlanOutcome {
  const text = sourceText.trim();

  if (!text) {
    return clarification("Что именно нужно сделать?", "request");
  }

  if (requiresConfirmation(text)) {
    return {
      kind: "confirmation",
      operationSummary: text,
      reason: "Запрос похож на массовое, структурное или необратимое изменение.",
      prompt: "Подтверди операцию явно перед выполнением.",
    };
  }

  if (/созда(?:й|ть)|добав(?:ь|ить)|постав(?:ь|ить)/i.test(text) && /задач/i.test(text)) {
    const task = parseCreateTask(text);

    if (!task) {
      return clarification("Какую конкретно задачу нужно создать?", "task.title");
    }

    return {
      kind: "ready",
      plan: {
        version: 1,
        mode: detectMode(text),
        sourceText: text,
        actions: [task],
      },
    };
  }

  return clarification("Какое конкретное действие нужно выполнить?", "action");
}

export function validateActionPlan(value: unknown): ActionPlanValidation {
  const errors: string[] = [];

  if (!isObject(value)) {
    return { valid: false, errors: ["plan must be an object"] };
  }

  if (value.version !== 1) {
    errors.push("version must be 1");
  }

  if (!isAssistantMode(value.mode)) {
    errors.push("mode is invalid");
  }

  if (!isNonEmptyString(value.sourceText)) {
    errors.push("sourceText is required");
  }

  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    errors.push("actions must contain at least one action");
  } else {
    value.actions.forEach((action, index) => validateAction(action, index, errors));
  }

  if (errors.length) {
    return { valid: false, errors };
  }

  return { valid: true, plan: value as ActionPlan };
}

export function executeMockActionPlan(plan: ActionPlan): ActionResult[] {
  return plan.actions.map((action) => ({
    actionId: action.id,
    actionType: action.type,
    status: "succeeded",
    message:
      action.type === "create_task"
        ? `Mock-задача подготовлена: ${action.payload.title}`
        : `Mock-действие ${action.type} подготовлено.`,
  }));
}

function parseCreateTask(text: string): CreateTaskAction | null {
  const match = text.match(
    /(?:создай|создать|добавь|добавить|поставь|поставить)(?:\s+мне)?\s+задач[ау]\s+([\s\S]+)/i,
  );

  if (!match?.[1]?.trim()) {
    return null;
  }

  const rawTask = match[1].trim();
  const dueMatch = rawTask.match(/^([\s\S]+?)\s+((?:к|до)\s+[\s\S]+)$/i);
  const title = (dueMatch?.[1] ?? rawTask).trim();

  if (!title) {
    return null;
  }

  return {
    id: "action-1",
    type: "create_task",
    payload: {
      title,
      dueDateText: dueMatch?.[2]?.trim(),
    },
  };
}

function detectMode(text: string): AssistantMode {
  if (/ежедневн|сводк/i.test(text)) {
    return "daily_summary";
  }

  if (/аналит|проанализ/i.test(text)) {
    return "analytics";
  }

  if (/структур|таблиц.*с нуля/i.test(text)) {
    return "create_structure";
  }

  if (/\n\s*[-*]\s+/.test(text)) {
    return "batch_report";
  }

  return "quick_command";
}

function requiresConfirmation(text: string) {
  return /удал|очист|массов|перенес[иь]\s+все|перезапиш|измени\s+структур/i.test(text);
}

function clarification(question: string, missingField: string): AssistantPlanOutcome {
  return {
    kind: "clarification",
    question,
    missingField,
  };
}

function validateAction(value: unknown, index: number, errors: string[]) {
  const path = `actions[${index}]`;

  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  if (!isNonEmptyString(value.id)) {
    errors.push(`${path}.id is required`);
  }

  if (!isActionType(value.type)) {
    errors.push(`${path}.type is invalid`);
    return;
  }

  if (!isObject(value.payload)) {
    errors.push(`${path}.payload must be an object`);
    return;
  }

  validatePayload(value.type, value.payload, path, errors);
}

function validatePayload(
  type: AssistantAction["type"],
  payload: Record<string, unknown>,
  path: string,
  errors: string[],
) {
  switch (type) {
    case "add_metrics":
    case "update_metrics":
      if (!isMetricArray(payload.metrics)) {
        errors.push(`${path}.payload.metrics is invalid`);
      }
      break;
    case "update_project_status":
      requireStrings(payload, ["projectId", "status"], path, errors);
      break;
    case "create_task":
      requireStrings(payload, ["title"], path, errors);
      if (payload.priority !== undefined && !isTaskPriority(payload.priority)) {
        errors.push(`${path}.payload.priority is invalid`);
      }
      break;
    case "update_task":
      requireSelector(payload, "taskId", "taskTitle", path, errors);
      if (!isObject(payload.changes) || !Object.keys(payload.changes).length) {
        errors.push(`${path}.payload.changes is required`);
      }
      break;
    case "complete_task":
      requireSelector(payload, "taskId", "taskTitle", path, errors);
      break;
    case "create_calendar_event":
      requireStrings(payload, ["title", "date", "startTime"], path, errors);
      break;
    case "update_calendar_event":
      requireSelector(payload, "eventId", "eventTitle", path, errors);
      if (!isObject(payload.changes) || !Object.keys(payload.changes).length) {
        errors.push(`${path}.payload.changes is required`);
      }
      break;
    case "create_sheet":
      requireStrings(payload, ["title"], path, errors);
      break;
    case "create_sheet_tab":
      requireStrings(payload, ["spreadsheetId", "title"], path, errors);
      break;
    case "update_sheet":
      requireStrings(payload, ["spreadsheetId", "range"], path, errors);
      if (
        payload.operation !== "append_rows" &&
        payload.operation !== "update_cells" &&
        payload.operation !== "clear_range"
      ) {
        errors.push(`${path}.payload.operation is invalid`);
      }
      if (payload.values !== undefined && !isSheetValues(payload.values)) {
        errors.push(`${path}.payload.values is invalid`);
      }
      break;
    case "create_sheet_blueprint":
      requireStrings(payload, ["purpose"], path, errors);
      if (!isBlueprintTabs(payload.tabs)) {
        errors.push(`${path}.payload.tabs is invalid`);
      }
      break;
    case "analyze_metrics":
      if (
        payload.metricNames !== undefined &&
        !isStringArray(payload.metricNames)
      ) {
        errors.push(`${path}.payload.metricNames is invalid`);
      }
      break;
    case "generate_daily_summary":
      break;
  }
}

function requireStrings(
  value: Record<string, unknown>,
  fields: string[],
  path: string,
  errors: string[],
) {
  for (const field of fields) {
    if (!isNonEmptyString(value[field])) {
      errors.push(`${path}.payload.${field} is required`);
    }
  }
}

function requireSelector(
  value: Record<string, unknown>,
  first: string,
  second: string,
  path: string,
  errors: string[],
) {
  if (!isNonEmptyString(value[first]) && !isNonEmptyString(value[second])) {
    errors.push(`${path}.payload requires ${first} or ${second}`);
  }
}

function isMetricArray(value: unknown): value is MetricInput[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (metric) =>
        isObject(metric) &&
        isNonEmptyString(metric.name) &&
        typeof metric.value === "number" &&
        Number.isFinite(metric.value),
    )
  );
}

function isBlueprintTabs(value: unknown): value is SheetBlueprintTab[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (tab) =>
        isObject(tab) &&
        isNonEmptyString(tab.title) &&
        isStringArray(tab.columns),
    )
  );
}

function isSheetValues(value: unknown): value is SheetCellValue[][] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.every(
          (cell) =>
            cell === null ||
            typeof cell === "string" ||
            typeof cell === "number" ||
            typeof cell === "boolean",
        ),
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isAssistantMode(value: unknown): value is AssistantMode {
  return (
    typeof value === "string" &&
    ASSISTANT_MODES.includes(value as AssistantMode)
  );
}

function isActionType(value: unknown): value is AssistantAction["type"] {
  return (
    typeof value === "string" &&
    ACTION_TYPES.includes(value as AssistantAction["type"])
  );
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return (
    value === "low" ||
    value === "normal" ||
    value === "high" ||
    value === "urgent"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatMockResults(plan: ActionPlan, results: ActionResult[]) {
  const task = plan.actions[0];
  const dueDateText =
    task.type === "create_task" && task.payload.dueDateText
      ? `\nСрок из сообщения: ${task.payload.dueDateText}`
      : "";

  return [
    "Assistant Agent (mock)",
    "",
    results.map((result) => result.message).join("\n"),
    dueDateText,
    "",
    "Реальное внешнее действие не выполнялось.",
  ].join("\n");
}
