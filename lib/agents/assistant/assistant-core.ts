import type {
  ActionPlan,
  ActionResult,
  AssistantAction,
  AssistantConversationMessage,
  AssistantMode,
  AssistantPlanOutcome,
  CreateTaskAction,
  ExistingSheetTarget,
  MetricInput,
  SheetBlueprintTab,
  SheetCellValue,
  TaskPriority,
} from "./types";
import { executeGoogleSheetsAction } from "@/lib/executors/google-sheets-executor";
import { executeTickTickAction } from "@/lib/executors/ticktick-executor";
import { createTickTickAdapterFromEnv } from "@/lib/integrations/ticktick/ticktick-adapter";
import { planAssistantMessage } from "./assistant-planner";

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
  "list_tasks",
  "create_calendar_event",
  "update_calendar_event",
  "create_sheet",
  "create_sheet_tab",
  "find_sheet",
  "read_sheet",
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

export async function runAssistantPipeline(
  sourceText: string,
  {
    conversation = [],
  }: {
    conversation?: AssistantConversationMessage[];
  } = {},
): Promise<AssistantPipelineResult> {
  const outcome = enforceAssistantSafety(
    sourceText,
    await createAssistantPlan(sourceText, { conversation }),
  );

  if (outcome.kind === "response") {
    return {
      outcome,
      results: [],
      text: outcome.text,
    };
  }

  if (outcome.kind === "clarification") {
    return {
      outcome,
      results: [],
      text: ["Уточнение", "", outcome.question].join("\n"),
    };
  }

  if (outcome.kind === "confirmation") {
    return {
      outcome,
      results: [],
      text: [
        "Требуется подтверждение",
        "",
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
      text: [
        "Не удалось выполнить запрос",
        "",
        validation.errors.join("; "),
      ].join("\n"),
    };
  }

  const results = await executeActionPlan(validation.plan);

  return {
    outcome,
    results,
    text: formatResults(validation.plan, results),
  };
}

export async function createAssistantPlan(
  sourceText: string,
  {
    conversation = [],
  }: {
    conversation?: AssistantConversationMessage[];
  } = {},
): Promise<AssistantPlanOutcome> {
  try {
    const tickTickProjectNames = await getTickTickProjectNames();

    return (
      (await planAssistantMessage(sourceText, {
        conversation,
        tickTickProjectNames,
      })) ??
      createMockActionPlan(sourceText)
    );
  } catch (error) {
    console.error(
      "Assistant planner failed; using deterministic fallback:",
      error instanceof Error ? error.message : "unknown error",
    );
    return createMockActionPlan(sourceText);
  }
}

let tickTickProjectCache:
  | {
      expiresAt: number;
      names: string[];
    }
  | undefined;

async function getTickTickProjectNames() {
  const now = Date.now();

  if (tickTickProjectCache && tickTickProjectCache.expiresAt > now) {
    return tickTickProjectCache.names;
  }

  const adapter = createTickTickAdapterFromEnv();

  if (!adapter) {
    return [];
  }

  try {
    const names = (await adapter.listProjects())
      .filter(
        (project) =>
          !project.closed &&
          project.permission !== "read" &&
          project.permission !== "comment",
      )
      .map((project) => project.name.trim())
      .filter(Boolean);

    tickTickProjectCache = {
      names,
      expiresAt: now + 5 * 60 * 1_000,
    };

    return names;
  } catch (error) {
    console.error(
      "TickTick project context load failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return [];
  }
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

  if (isOwnProjectTrackerRequest(text)) {
    return {
      kind: "ready",
      plan: {
        version: 1,
        mode: "create_structure",
        sourceText: text,
        actions: [
          {
            id: "action-1",
            type: "create_sheet",
            payload: {
              title: "Операционный трекер собственного проекта",
              blueprintId: "own-project-operations-v2",
            },
          },
        ],
      },
    };
  }

  const existingSheetRequest = parseExistingSheetRequest(text);

  if (existingSheetRequest) {
    return existingSheetRequest;
  }

  if (isTickTickTaskListRequest(text)) {
    return {
      kind: "ready",
      plan: {
        version: 1,
        mode: "quick_command",
        sourceText: text,
        actions: [
          {
            id: "action-1",
            type: "list_tasks",
            payload: {},
          },
        ],
      },
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

export async function executeActionPlan(plan: ActionPlan) {
  const results: ActionResult[] = [];

  for (const action of plan.actions) {
    const googleSheetsResult = await executeGoogleSheetsAction(action);
    const tickTickResult =
      googleSheetsResult === null
        ? await executeTickTickAction(action)
        : null;

    results.push(
      googleSheetsResult ??
        tickTickResult ??
        executeMockActionPlan({
          ...plan,
          actions: [action],
        })[0],
    );
  }

  return results;
}

function isOwnProjectTrackerRequest(text: string) {
  return (
    /(?:создай|создать|сделай|сделать)/iu.test(text) &&
    /(?:операционн\w*\s+трекер|трекер\w*\s+(?:собственного\s+)?проекта|таблиц\w*\s+(?:для\s+)?(?:собственного\s+)?проекта)/iu.test(
      text,
    )
  );
}

function parseExistingSheetRequest(
  text: string,
): AssistantPlanOutcome | null {
  const mentionsSheet =
    /таблиц|google\s*sheets?|spreadsheet|диапазон|ячейк|лист[аеы]?/iu.test(
      text,
    );

  if (!mentionsSheet) {
    return null;
  }

  const target = extractExistingSheetTarget(text);
  const range = extractExplicitSheetRange(text);

  if (/(?:обнови|измени|запиши)/iu.test(text) && /ячейк/iu.test(text)) {
    if (!target) {
      return clarification(
        "Пришлите ссылку на таблицу или укажите её точное название в кавычках.",
        "sheet.target",
      );
    }

    if (!range || range.includes(":")) {
      return clarification(
        "Укажите одну ячейку вместе с листом, например Метрики!D2.",
        "sheet.range",
      );
    }

    const valueMatch = text.match(/значени(?:е|ем)\s*:?\s*([\s\S]+)$/iu);

    if (!valueMatch?.[1]?.trim()) {
      return clarification(
        "Какое значение нужно записать в ячейку?",
        "sheet.value",
      );
    }

    return readySheetAction(text, {
      id: "action-1",
      type: "update_sheet",
      payload: {
        target,
        range,
        operation: "update_cells",
        values: [[parseSheetCellValue(valueMatch[1].trim())]],
      },
    });
  }

  if (/(?:найди|отыщи)/iu.test(text) && /таблиц/iu.test(text)) {
    if (target?.kind === "id") {
      return readySheetAction(text, {
        id: "action-1",
        type: "read_sheet",
        payload: { target },
      });
    }

    const title =
      target?.kind === "title"
        ? target.title
        : extractFindSheetTitle(text);

    if (!title) {
      return clarification("Как точно называется таблица?", "sheet.title");
    }

    return readySheetAction(text, {
      id: "action-1",
      type: "find_sheet",
      payload: { title },
    });
  }

  if (
    /(?:покажи|прочитай|посмотри|проверь|открой)/iu.test(text) &&
    mentionsSheet
  ) {
    if (!target) {
      return clarification(
        "Пришлите ссылку на таблицу или укажите её точное название в кавычках.",
        "sheet.target",
      );
    }

    return readySheetAction(text, {
      id: "action-1",
      type: "read_sheet",
      payload: {
        target,
        range,
      },
    });
  }

  return null;
}

function readySheetAction(
  sourceText: string,
  action: Extract<
    AssistantAction,
    { type: "find_sheet" | "read_sheet" | "update_sheet" }
  >,
): AssistantPlanOutcome {
  return {
    kind: "ready",
    plan: {
      version: 1,
      mode: "quick_command",
      sourceText,
      actions: [action],
    },
  };
}

function extractExistingSheetTarget(
  text: string,
): ExistingSheetTarget | null {
  const urlMatch = text.match(
    /https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/iu,
  );

  if (urlMatch?.[1]) {
    return {
      kind: "id",
      spreadsheetId: urlMatch[1],
    };
  }

  const idMatch = text.match(
    /\b(?:spreadsheet[_\s-]*id|id)\s*[:=]?\s*([A-Za-z0-9_-]{20,})\b/iu,
  );

  if (idMatch?.[1]) {
    return {
      kind: "id",
      spreadsheetId: idMatch[1],
    };
  }

  const titleMatch =
    text.match(/таблиц[аеуы]\s+«([^»]+)»/iu) ||
    text.match(/таблиц[аеуы]\s+"([^"]+)"/iu);

  return titleMatch?.[1]?.trim()
    ? {
        kind: "title",
        title: titleMatch[1].trim(),
      }
    : null;
}

function extractFindSheetTitle(text: string) {
  const match = text.match(
    /(?:найди|отыщи)(?:\s+мне)?\s+таблиц[ау]\s+([\s\S]+)$/iu,
  );

  return match?.[1]
    ?.trim()
    .replace(/[.!?]+$/, "")
    .trim();
}

function extractExplicitSheetRange(text: string) {
  const quoted = text.match(
    /('(?:[^']|'')+'!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)/iu,
  );

  if (quoted?.[1]) {
    return quoted[1];
  }

  return text.match(
    /\b([A-Za-zА-Яа-яЁё0-9_-]+!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)/iu,
  )?.[1];
}

function parseSheetCellValue(value: string): SheetCellValue {
  const normalized = value.trim();

  if (/^-?\d+(?:[.,]\d+)?$/.test(normalized)) {
    return Number(normalized.replace(",", "."));
  }

  if (/^(?:true|да)$/iu.test(normalized)) {
    return true;
  }

  if (/^(?:false|нет)$/iu.test(normalized)) {
    return false;
  }

  return normalized.replace(/^["«]|["»]$/g, "");
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

function isTickTickTaskListRequest(text: string) {
  return (
    /(?:tick\s*tick|тик\s*тик)/iu.test(text) &&
    /(?:посмотр|покаж|список|какие|что\s+у\s+меня|видишь).{0,40}задач|задач.{0,40}(?:посмотр|покаж|видишь)/iu.test(
      text,
    )
  );
}

function requiresConfirmation(text: string) {
  return /удал|очист|массов|перенес[иь]\s+все|перезапиш|измени\s+структур/i.test(text);
}

export function enforceAssistantSafety(
  sourceText: string,
  outcome: AssistantPlanOutcome,
): AssistantPlanOutcome {
  if (
    outcome.kind !== "ready" ||
    (!requiresConfirmation(sourceText) &&
      !hasDangerousPlannedAction(outcome.plan.actions))
  ) {
    return outcome;
  }

  return {
    kind: "confirmation",
    operationSummary: sourceText.trim(),
    reason: "Операция может массово, структурно или необратимо изменить данные.",
    prompt: "Подтверди операцию явно перед выполнением.",
  };
}

function hasDangerousPlannedAction(actions: AssistantAction[]) {
  if (actions.length > 5) {
    return true;
  }

  return actions.some((action) => {
    if (action.type === "create_sheet_tab") {
      return true;
    }

    if (action.type !== "update_sheet") {
      return false;
    }

    return (
      action.payload.operation === "clear_range" ||
      action.payload.range.includes(":") ||
      (action.payload.values?.flat().length ?? 0) > 20
    );
  });
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
    case "list_tasks":
      if (
        payload.limit !== undefined &&
        (!Number.isInteger(payload.limit) ||
          (payload.limit as number) < 1 ||
          (payload.limit as number) > 50)
      ) {
        errors.push(`${path}.payload.limit is invalid`);
      }
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
    case "find_sheet":
      requireStrings(payload, ["title"], path, errors);
      break;
    case "read_sheet":
      validateExistingSheetTarget(payload.target, path, errors);
      if (
        payload.range !== undefined &&
        !isNonEmptyString(payload.range)
      ) {
        errors.push(`${path}.payload.range is invalid`);
      }
      break;
    case "update_sheet":
      validateExistingSheetTarget(payload.target, path, errors);
      requireStrings(payload, ["range"], path, errors);
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

function validateExistingSheetTarget(
  value: unknown,
  path: string,
  errors: string[],
) {
  if (!isObject(value)) {
    errors.push(`${path}.payload.target is required`);
    return;
  }

  if (value.kind === "id" && isNonEmptyString(value.spreadsheetId)) {
    return;
  }

  if (value.kind === "title" && isNonEmptyString(value.title)) {
    return;
  }

  errors.push(`${path}.payload.target is invalid`);
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

function formatResults(plan: ActionPlan, results: ActionResult[]) {
  const task = plan.actions[0];
  const containsOnlyImplementedActions = plan.actions.every(
    (action) =>
      action.type === "create_sheet" ||
      action.type === "create_sheet_tab" ||
      action.type === "find_sheet" ||
      action.type === "read_sheet" ||
      action.type === "update_sheet" ||
      action.type === "create_sheet_blueprint" ||
      action.type === "create_task" ||
      action.type === "update_task" ||
      action.type === "complete_task" ||
      action.type === "list_tasks",
  );
  const dueDateText =
    task.type === "create_task" && task.payload.dueDateText
      ? `\nСрок из сообщения: ${task.payload.dueDateText}`
      : "";

  const heading = containsOnlyImplementedActions
    ? results.every((result) => result.status === "succeeded")
      ? "Готово"
      : "Результат"
    : "Предварительный результат";
  const lines = [
    heading,
    "",
    results.map((result) => result.message).join("\n"),
    dueDateText,
  ];

  if (!containsOnlyImplementedActions) {
    lines.push("", "Реальное внешнее действие не выполнялось.");
  }

  return lines.join("\n");
}
