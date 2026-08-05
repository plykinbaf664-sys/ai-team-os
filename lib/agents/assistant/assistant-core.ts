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
import { executeGoogleCalendarAction } from "@/lib/executors/google-calendar-executor";
import { executeDailySummaryAction } from "@/lib/executors/daily-summary-executor";
import { createTickTickAdapterFromEnv } from "@/lib/integrations/ticktick/ticktick-adapter";
import {
  formatGoogleSheetsWorkspaceContext,
  inspectGoogleSheetsWorkspace,
  type GoogleSheetsWorkspaceContext,
} from "@/lib/integrations/google-sheets/document-context";
import { createGoogleSheetsAdapterFromEnv } from "@/lib/integrations/google-sheets/google-sheets-adapter";
import { planAssistantMessage } from "./assistant-planner";
import { reconcileConversationDependentActions } from "./conversation-reconciliation";
import type { AssistantProjectContext } from "./project-context";
import {
  attachStrategicPlan,
  reconcileStrategicPlanWithSheets,
  validateStrategicActionPlan,
} from "./strategic-planner";
import {
  createPolicyBlockedResults,
  evaluateActionPlanPolicy,
  filterExecutableActionPlan,
} from "./confidence-policy";
import { composeStrategicResponse } from "./strategic-response-composer";
import { coordinateTickTickPlan } from "./ticktick-coordination";
import {
  attachProactiveMonitoring,
  type TickTickMonitoringContext,
} from "./proactive-monitor";
import type { TickTickProject } from "@/lib/integrations/ticktick/types";

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
  projectContext?: AssistantProjectContext;
};

export async function runAssistantPipeline(
  sourceText: string,
  {
    conversation = [],
    projectContext,
  }: {
    conversation?: AssistantConversationMessage[];
    projectContext?: AssistantProjectContext;
  } = {},
): Promise<AssistantPipelineResult> {
  const confirmedSourceText = resolveConfirmedRequest(
    sourceText,
    conversation,
  );
  const planningSourceText = confirmedSourceText ?? sourceText;
  const plannedOutcome = await createAssistantPlan(planningSourceText, {
    conversation,
    confirmationGranted: confirmedSourceText !== null,
    projectContext,
  });
  const outcome =
    confirmedSourceText !== null
      ? plannedOutcome
      : enforceAssistantSafety(sourceText, plannedOutcome);

  if (outcome.kind === "response") {
    return {
      outcome,
      results: [],
      text: outcome.text,
      projectContext,
    };
  }

  if (outcome.kind === "clarification") {
    return {
      outcome,
      results: [],
      text: outcome.question,
      projectContext,
    };
  }

  if (outcome.kind === "confirmation") {
    return {
      outcome,
      results: [],
      text: [
        "Перед выполнением нужно твоё подтверждение.",
        outcome.operationSummary,
        outcome.reason,
        outcome.prompt,
      ].join("\n"),
      projectContext,
    };
  }

  const validation = validateActionPlan(outcome.plan);

  if (!validation.valid) {
    return {
      outcome,
      results: [],
      text: formatFriendlyValidationError(validation.errors),
      projectContext,
    };
  }

  const policy = evaluateActionPlanPolicy(
    validation.plan,
    projectContext,
  );
  const executablePlan = filterExecutableActionPlan(
    validation.plan,
    policy,
  );
  const executedResults = executablePlan
    ? await executeActionPlan(executablePlan, { projectContext })
    : [];
  const blockedResults = createPolicyBlockedResults(
    validation.plan,
    policy,
  );
  const results = validation.plan.actions.flatMap((action) => {
    const result = [...executedResults, ...blockedResults].find(
      (candidate) => candidate.actionId === action.id,
    );
    return result ? [result] : [];
  });
  const resultText = composeStrategicResponse(
    validation.plan,
    results,
    policy.clarificationQuestions,
  );

  return {
    outcome,
    results,
    text: resultText,
    projectContext,
  };
}

export async function createAssistantPlan(
  sourceText: string,
  {
    conversation = [],
    confirmationGranted = false,
    projectContext,
  }: {
    conversation?: AssistantConversationMessage[];
    confirmationGranted?: boolean;
    projectContext?: AssistantProjectContext;
  } = {},
): Promise<AssistantPlanOutcome> {
  try {
    const [tickTickProjectNames, googleSheetsContext] =
      await Promise.all([
        getTickTickProjectNames(),
        getGoogleSheetsContext(sourceText, conversation, projectContext),
      ]);

    const outcome =
      (await planAssistantMessage(sourceText, {
        conversation,
        tickTickProjectNames,
        googleSheetsContext: googleSheetsContext.text,
        confirmationGranted,
        projectContext,
      })) ??
      createMockActionPlan(sourceText);

    const contextualOutcome = reconcileConversationDependentActions(
      outcome,
      {
        sourceText,
        conversation,
        timezone: projectContext?.timezone,
      },
    );
    const reconciled = reconcileStrategicPlanWithSheets(
      contextualOutcome,
      sourceText,
      googleSheetsContext.workspace,
      { timezone: projectContext?.timezone },
    );

    if (reconciled.kind !== "ready") return reconciled;
    const strategicPlan = attachStrategicPlan(
      reconciled.plan,
      projectContext,
    );

    const coordinatedPlan = coordinateTickTickPlan(strategicPlan, {
      sourceText,
      conversation,
      projectContext,
      tickTickProjectNames,
    });
    const tickTickMonitoring = googleSheetsContext.workspace
      ? await getTickTickMonitoringContext()
      : { available: false, tasks: [] };

    return {
      ...reconciled,
      plan: attachProactiveMonitoring(coordinatedPlan, {
        workspace: googleSheetsContext.workspace,
        tickTick: tickTickMonitoring,
        projectContext,
        conversation,
      }),
    };
  } catch (error) {
    console.error(
      "Assistant planner failed; using deterministic fallback:",
      error instanceof Error ? error.message : "unknown error",
    );
    const fallback = createMockActionPlan(sourceText);
    if (fallback.kind !== "ready") return fallback;
    const strategicPlan = attachStrategicPlan(
      fallback.plan,
      projectContext,
    );

    return {
      ...fallback,
      plan: coordinateTickTickPlan(strategicPlan, {
        sourceText,
        conversation,
        projectContext,
      }),
    };
  }
}

export function resolveConfirmedRequest(
  sourceText: string,
  conversation: AssistantConversationMessage[],
) {
  if (!isExplicitConfirmationText(sourceText)) {
    return null;
  }

  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];

    if (message.role !== "assistant") {
      continue;
    }

    if (
      !/(?:нужно|требуется)\s+(?:тво[её]\s+)?подтверждени|подтверди\s+(?:операци|действи)/iu.test(
        message.text,
      )
    ) {
      return null;
    }

    for (let requestIndex = index - 1; requestIndex >= 0; requestIndex -= 1) {
      const request = conversation[requestIndex];

      if (
        request.role === "user" &&
        request.text.trim() &&
        !isExplicitConfirmationText(request.text)
      ) {
        return request.text.trim();
      }
    }

    return null;
  }

  return null;
}

function isExplicitConfirmationText(value: string) {
  const normalized = value
    .trim()
    .replace(
      /^(?:ассистент|assistant)(?:@\w+)?[\s,.:;—-]+/iu,
      "",
    );

  return /^(?:я\s+)?(?:подтверждаю|подтверждено|выполняй|применяй|да[\s,.:;-]*(?:подтверждаю|выполняй|делай|применяй))[\s.!]*$/iu.test(
    normalized,
  );
}

async function getGoogleSheetsContext(
  sourceText: string,
  conversation: AssistantConversationMessage[],
  projectContext?: AssistantProjectContext,
): Promise<{
  text: string;
  workspace?: GoogleSheetsWorkspaceContext;
}> {
  if (!shouldInspectGoogleSheets(sourceText, conversation)) {
    return { text: "" };
  }

  const adapter = createGoogleSheetsAdapterFromEnv();

  if (!adapter) {
    return { text: "" };
  }

  try {
    const workspace = await inspectGoogleSheetsWorkspace({
      adapter,
      sourceText: [
        sourceText,
        ...(projectContext?.activeProject?.resources ?? [])
          .filter(
            (resource) => resource.resourceType === "google_sheet",
          )
          .map((resource) => resource.title),
      ].join("\n"),
      conversation,
    });
    return {
      text: formatGoogleSheetsWorkspaceContext(workspace),
      workspace,
    };
  } catch (error) {
    console.error(
      "Google Sheets document context load failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return { text: "" };
  }
}

export function shouldInspectGoogleSheets(
  sourceText: string,
  conversation: AssistantConversationMessage[],
) {
  const context = [
    sourceText,
    ...conversation.slice(-6).map((message) => message.text),
  ].join("\n");
  const mentionsSheets =
    /таблиц|лист[аеуы]?|google\s*sheets?|spreadsheet|ячейк/iu.test(
      context,
    );
  const writesData =
    /внес|зафикс|запиш|добав|обнов|измени|отмет|сделал|сделала|отправил|отправила|пров[её]л|провела|получил|получила/iu.test(
      sourceText,
    ) &&
    /данн|показател|метрик|результат|факт|рассыл|лид|продаж|выруч|расход|сегмент|созвон|интервью|\d/iu.test(
      sourceText,
    );
  const requestsOperationalReview =
    /что.*(?:требует внимания|зависло|просрочено)|где.*(?:отставание|расхождение)|следующ(?:ее|ий)\s+действие|проверь.*(?:статус|план.?факт|follow.?up)/iu.test(
      sourceText,
    );

  return mentionsSheets || writesData || requestsOperationalReview;
}

let tickTickProjectCache:
  | {
      expiresAt: number;
      projects: TickTickProject[];
    }
  | undefined;

async function getTickTickProjectNames() {
  return (await getWritableTickTickProjects()).map((project) => project.name);
}

async function getWritableTickTickProjects() {
  const now = Date.now();

  if (tickTickProjectCache && tickTickProjectCache.expiresAt > now) {
    return tickTickProjectCache.projects;
  }

  const adapter = createTickTickAdapterFromEnv();

  if (!adapter) {
    return [];
  }

  try {
    const projects = (await adapter.listProjects())
      .filter(
        (project) =>
          !project.closed &&
          project.permission !== "read" &&
          project.permission !== "comment",
      );

    tickTickProjectCache = {
      projects,
      expiresAt: now + 5 * 60 * 1_000,
    };

    return projects;
  } catch (error) {
    console.error(
      "TickTick project context load failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return [];
  }
}

let tickTickMonitoringCache:
  | {
      expiresAt: number;
      context: TickTickMonitoringContext;
    }
  | undefined;

async function getTickTickMonitoringContext(): Promise<TickTickMonitoringContext> {
  const now = Date.now();

  if (tickTickMonitoringCache && tickTickMonitoringCache.expiresAt > now) {
    return tickTickMonitoringCache.context;
  }

  const adapter = createTickTickAdapterFromEnv();
  if (!adapter) return { available: false, tasks: [] };

  try {
    const projects = await getWritableTickTickProjects();
    const projectData = await Promise.all(
      projects.map((project) => adapter.getProjectData(project.id)),
    );
    const context: TickTickMonitoringContext = {
      available: true,
      tasks: projectData
        .flatMap((data) =>
          data.tasks
            .filter((task) => task.status === 0)
            .map((task) => ({
              id: task.id,
              projectId: task.projectId,
              projectName: data.project.name,
              title: task.title,
              ...(task.content ? { content: task.content } : {}),
              ...(task.dueDate ? { dueDate: task.dueDate } : {}),
            })),
        )
        .slice(0, 200),
    };

    tickTickMonitoringCache = {
      context,
      expiresAt: now + 5 * 60 * 1_000,
    };
    return context;
  } catch (error) {
    console.error(
      "TickTick monitoring context load failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return { available: false, tasks: [] };
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

  if (isDailySummaryRequest(text)) {
    return {
      kind: "ready",
      plan: {
        version: 1,
        mode: "daily_summary",
        sourceText: text,
        actions: [
          {
            id: "action-1",
            type: "generate_daily_summary",
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

  if (value.strategicPlan !== undefined) {
    errors.push(...validateStrategicActionPlan(value.strategicPlan));
  }

  if (value.monitoringReport !== undefined) {
    errors.push(...validateMonitoringReport(value.monitoringReport));
  }

  if (errors.length) {
    return { valid: false, errors };
  }

  return { valid: true, plan: value as ActionPlan };
}

export async function executeActionPlan(
  plan: ActionPlan,
  {
    projectContext,
  }: {
    projectContext?: AssistantProjectContext;
  } = {},
) {
  const results: ActionResult[] = [];

  for (const action of plan.actions) {
    const googleSheetsResult = await executeGoogleSheetsAction(action);
    const tickTickResult =
      googleSheetsResult === null
        ? await executeTickTickAction(action)
        : null;
    const calendarResult =
      googleSheetsResult === null && tickTickResult === null
        ? await executeGoogleCalendarAction(action)
        : null;
    const dailySummaryResult =
      googleSheetsResult === null &&
      tickTickResult === null &&
      calendarResult === null
        ? await executeDailySummaryAction(action, plan, projectContext)
        : null;

    results.push(
      googleSheetsResult ??
        tickTickResult ??
        calendarResult ??
        dailySummaryResult ??
        unsupportedActionResult(action),
    );
  }

  return results;
}

function unsupportedActionResult(action: AssistantAction): ActionResult {
  if (
    action.type === "add_metrics" ||
    action.type === "update_metrics"
  ) {
    return {
      actionId: action.id,
      actionType: action.type,
      status: "needs_clarification",
      message:
        "В какую таблицу и лист записать эти данные? Если структура ещё не обсуждалась, также пришлите названия колонок.",
      errorCode: "metrics_destination_required",
    };
  }

  return {
    actionId: action.id,
    actionType: action.type,
    status: "failed",
    message: `Действие ${action.type} пока не подключено к реальному исполнителю.`,
    errorCode: "action_not_implemented",
  };
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

function isDailySummaryRequest(text: string) {
  return /(?:дай|покажи|собери|подготовь|сделай)?\s*(?:ежедневн\w*|утренн\w*|операционн\w*)?\s*сводк|что\s+у\s+меня\s+(?:сегодня|на\s+сегодня)/iu.test(
    text,
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

    if (action.payload.operation === "clear_range") {
      return true;
    }

    const rowCount = action.payload.values?.length ?? 0;
    const cellCount = action.payload.values?.flat().length ?? 0;

    return rowCount > 5 || cellCount > 50;
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
      if (
        payload.sourceEntity !== undefined &&
        !isTaskSourceEntity(payload.sourceEntity)
      ) {
        errors.push(`${path}.payload.sourceEntity is invalid`);
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
      if (isNonEmptyString(payload.date) && !isIsoDate(payload.date)) {
        errors.push(`${path}.payload.date is invalid`);
      }
      if (isNonEmptyString(payload.startTime) && !isClockTime(payload.startTime)) {
        errors.push(`${path}.payload.startTime is invalid`);
      }
      if (payload.endTime !== undefined && !isClockTime(payload.endTime)) {
        errors.push(`${path}.payload.endTime is invalid`);
      }
      if (payload.timezone !== undefined && !isTimezone(payload.timezone)) {
        errors.push(`${path}.payload.timezone is invalid`);
      }
      break;
    case "update_calendar_event":
      requireSelector(payload, "eventId", "eventTitle", path, errors);
      if (!isObject(payload.changes) || !Object.keys(payload.changes).length) {
        errors.push(`${path}.payload.changes is required`);
      } else {
        if (payload.changes.date !== undefined && !isIsoDate(payload.changes.date)) {
          errors.push(`${path}.payload.changes.date is invalid`);
        }
        for (const key of ["startTime", "endTime"] as const) {
          if (payload.changes[key] !== undefined && !isClockTime(payload.changes[key])) {
            errors.push(`${path}.payload.changes.${key} is invalid`);
          }
        }
        if (
          payload.changes.timezone !== undefined &&
          !isTimezone(payload.changes.timezone)
        ) {
          errors.push(`${path}.payload.changes.timezone is invalid`);
        }
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
        isNonEmptyString(payload.range) &&
        !payload.range.includes("!")
      ) {
        errors.push(
          `${path}.payload.range must include an exact sheet title`,
        );
      }
      if (
        payload.operation === "append_rows" &&
        isNonEmptyString(payload.range) &&
        /\d/.test(payload.range.split("!").at(-1) ?? "")
      ) {
        errors.push(
          `${path}.payload.range for append_rows must not contain row numbers`,
        );
      }
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

export function formatFriendlyValidationError(errors: string[]) {
  const details = errors.join(" ").toLocaleLowerCase("ru");

  if (/\.payload\.date\b/.test(details)) {
    return "Не смог однозначно восстановить дату события. Напиши дату обычными словами — остальной контекст я подхвачу сам.";
  }
  if (/\.payload\.starttime\b/.test(details)) {
    return "Не смог однозначно восстановить время начала. Напиши только время — остальной контекст я подхвачу сам.";
  }
  if (/\.payload\.endtime\b/.test(details)) {
    return "Не смог однозначно восстановить время окончания. Напиши только время — остальной контекст я подхвачу сам.";
  }

  if (/append_rows|payload\.range|sheet title/.test(details)) {
    return "Не смог безопасно определить место записи в таблице. Диапазон и номера ячеек от тебя не нужны — уточни только, что именно нужно зафиксировать.";
  }

  return "Не смог безопасно собрать действие из контекста. Повтори цель одним сообщением — технические поля, диапазоны и ID указывать не нужно.";
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

function isTaskSourceEntity(value: unknown) {
  return (
    isObject(value) &&
    value.type === "google_sheet_row" &&
    isNonEmptyString(value.spreadsheetId) &&
    isNonEmptyString(value.sheetName) &&
    Number.isInteger(value.rowNumber) &&
    (value.rowNumber as number) > 0 &&
    isNonEmptyString(value.entityId) &&
    (value.spreadsheetTitle === undefined ||
      isNonEmptyString(value.spreadsheetTitle)) &&
    (value.entityLabel === undefined || isNonEmptyString(value.entityLabel))
  );
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

function isIsoDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isClockTime(value: unknown) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function isTimezone(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateMonitoringReport(value: unknown) {
  if (!isObject(value)) return ["monitoringReport must be an object"];
  const errors: string[] = [];

  if (value.version !== 1) errors.push("monitoringReport.version must be 1");
  if (value.scope !== "relevant_context") {
    errors.push("monitoringReport.scope is invalid");
  }
  if (!isNonEmptyString(value.checkedAt)) {
    errors.push("monitoringReport.checkedAt is required");
  }
  if (!Array.isArray(value.findings) || value.findings.length > 8) {
    errors.push("monitoringReport.findings must contain at most 8 items");
    return errors;
  }

  const kinds = new Set([
    "stale_segment",
    "missed_follow_up",
    "plan_fact_deviation",
    "missing_next_action",
    "inconsistent_data",
  ]);
  const severities = new Set(["low", "medium", "high"]);

  value.findings.forEach((finding, index) => {
    if (!isObject(finding)) {
      errors.push(`monitoringReport.findings[${index}] must be an object`);
      return;
    }
    const prefix = `monitoringReport.findings[${index}]`;
    if (!kinds.has(String(finding.kind))) errors.push(`${prefix}.kind is invalid`);
    if (!severities.has(String(finding.severity))) {
      errors.push(`${prefix}.severity is invalid`);
    }
    for (const key of [
      "id",
      "title",
      "recommendation",
      "spreadsheetId",
      "sheetName",
      "entityId",
      "entityLabel",
    ]) {
      if (!isNonEmptyString(finding[key])) errors.push(`${prefix}.${key} is required`);
    }
    if (!Number.isInteger(finding.rowNumber) || Number(finding.rowNumber) < 1) {
      errors.push(`${prefix}.rowNumber is invalid`);
    }
    if (
      !Array.isArray(finding.evidence) ||
      finding.evidence.some((item) => !isNonEmptyString(item))
    ) {
      errors.push(`${prefix}.evidence is invalid`);
    }
  });

  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
