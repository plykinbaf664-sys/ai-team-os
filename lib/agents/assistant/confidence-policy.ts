import type { AssistantProjectContext } from "./project-context";
import type {
  ActionConfidenceAssessment,
  ActionPlan,
  ActionPlanPolicyEvaluation,
  ActionResult,
  ActionRiskLevel,
  AssistantAction,
  StrategicAction,
} from "./types";

const THRESHOLDS: Record<ActionRiskLevel, number> = {
  read: 0.5,
  safe_write: 0.72,
  sensitive_write: 0.8,
  critical: 1,
};

export function evaluateActionPlanPolicy(
  plan: ActionPlan,
  projectContext?: AssistantProjectContext,
): ActionPlanPolicyEvaluation {
  const taskWriteCount = plan.actions.filter(
    (action) => action.type === "update_task" || action.type === "complete_task",
  ).length;
  const assessments = plan.actions.map((action) =>
    assessAction(action, plan, projectContext, taskWriteCount > 5),
  );
  const strategicQuestion = plan.strategicPlan?.clarification?.question;
  const clarificationQuestions = unique([
    ...assessments.flatMap((assessment) =>
      assessment.question ? [assessment.question] : [],
    ),
    ...(strategicQuestion ? [strategicQuestion] : []),
  ]);

  return {
    assessments,
    executableActionIds: assessments
      .filter((assessment) => assessment.decision === "execute")
      .map((assessment) => assessment.actionId),
    blockedActionIds: assessments
      .filter((assessment) => assessment.decision !== "execute")
      .map((assessment) => assessment.actionId),
    clarificationQuestions,
  };
}

export function filterExecutableActionPlan(
  plan: ActionPlan,
  evaluation: ActionPlanPolicyEvaluation,
): ActionPlan | null {
  const allowed = new Set(evaluation.executableActionIds);
  const actions = plan.actions.filter((action) => allowed.has(action.id));
  return actions.length ? { ...plan, actions } : null;
}

export function createPolicyBlockedResults(
  plan: ActionPlan,
  evaluation: ActionPlanPolicyEvaluation,
): ActionResult[] {
  const assessments = new Map(
    evaluation.assessments.map((assessment) => [assessment.actionId, assessment]),
  );

  return plan.actions.flatMap((action): ActionResult[] => {
    const assessment = assessments.get(action.id);
    if (!assessment || assessment.decision === "execute") return [];

    return [
      {
        actionId: action.id,
        actionType: action.type,
        status:
          assessment.decision === "confirm"
            ? "needs_confirmation"
            : "needs_clarification",
        message:
          assessment.decision === "confirm"
            ? `Действие ${action.type} ожидает подтверждения.`
            : `Действие ${action.type} пока не выполнено: недостаточно уверенного контекста.`,
        errorCode:
          assessment.decision === "confirm"
            ? "confidence_confirmation_required"
            : "confidence_too_low",
      },
    ];
  });
}

export function formatAdaptiveQuestions(questions: string[]) {
  const normalized = unique(questions.map((question) => question.trim()));
  if (!normalized.length) return "";
  if (normalized.length === 1) return normalized[0];

  return [
    "Нужно уточнить:",
    ...normalized.map((question, index) => `${index + 1}. ${question}`),
  ].join("\n");
}

function assessAction(
  action: AssistantAction,
  plan: ActionPlan,
  projectContext?: AssistantProjectContext,
  massTaskWrite = false,
): ActionConfidenceAssessment {
  const strategic = plan.strategicPlan?.actions.find(
    (candidate) =>
      candidate.kind === "execute_action" &&
      candidate.linkedActionId === action.id,
  );
  const risk = classifyRisk(action);
  const threshold = THRESHOLDS[risk];
  const evidence = collectEvidence(strategic, projectContext);
  let confidence = strategic?.confidence ?? 0.55;

  if (risk === "read") {
    confidence = Math.max(confidence, 0.7);
  } else if (action.type === "update_sheet") {
    const resourceConfidence = assessSheetTarget(
      action,
      plan,
      projectContext,
      evidence,
    );
    confidence = confidence * 0.4 + resourceConfidence * 0.6;
  } else if (evidence.length > 0) {
    confidence = Math.max(confidence, 0.78);
  }

  if (
    projectContext?.resolution === "ambiguous" &&
    requiresResolvedProject(action) &&
    !hasExplicitResourceId(action)
  ) {
    confidence = Math.min(confidence, 0.55);
    evidence.push("Активный проект неоднозначен.");
  }

  confidence = roundConfidence(confidence);
  const forcedConfirmation =
    risk === "critical" ||
    strategic?.executionPolicy === "confirm_first" ||
    (massTaskWrite &&
      (action.type === "update_task" || action.type === "complete_task"));
  const suggestedOnly = strategic?.executionPolicy === "suggest_first";
  const decision = forcedConfirmation
    ? "confirm"
    : suggestedOnly || confidence < threshold
      ? "clarify"
      : "execute";

  return {
    actionId: action.id,
    risk,
    confidence,
    threshold,
    decision,
    evidence,
    question:
      decision === "execute" || suggestedOnly
        ? undefined
        : buildQuestion(action, projectContext, decision),
  };
}

function assessSheetTarget(
  action: Extract<AssistantAction, { type: "update_sheet" }>,
  plan: ActionPlan,
  projectContext: AssistantProjectContext | undefined,
  evidence: string[],
) {
  const target = action.payload.target;
  const resources = plan.strategicPlan?.targetResources ?? [];
  const linkedResources = projectContext?.activeProject?.resources ?? [];
  const rangeRow = parseSingleRow(action.payload.range);
  const targetResource = resources.find((resource) => {
    if (resource.type !== "google_sheet") return false;
    if (target.kind === "id") return resource.externalId === target.spreadsheetId;
    return normalize(resource.title) === normalize(target.title);
  });
  const linked = linkedResources.some((resource) => {
    if (resource.resourceType !== "google_sheet") return false;
    return target.kind === "id"
      ? resource.externalId === target.spreadsheetId
      : normalize(resource.title) === normalize(target.title);
  });

  if (
    targetResource?.entityId &&
    targetResource.rowNumber &&
    rangeRow === targetResource.rowNumber &&
    linked
  ) {
    evidence.push("Ресурс и существующая строка подтверждены runtime-контекстом.");
    return 0.98;
  }
  if (targetResource && linked) {
    evidence.push("Google Sheet подтверждён связью с активным проектом.");
    return rangeRow ? 0.84 : 0.76;
  }
  if (target.kind === "id" && linked) {
    evidence.push("Google Sheet связан с активным проектом.");
    return 0.76;
  }
  if (targetResource) {
    evidence.push("Цель есть только в proposed strategic plan.");
    return 0.62;
  }

  return 0.4;
}

function classifyRisk(action: AssistantAction): ActionRiskLevel {
  if (
    action.type === "list_tasks" ||
    action.type === "find_sheet" ||
    action.type === "read_sheet" ||
    action.type === "analyze_metrics" ||
    action.type === "generate_daily_summary"
  ) {
    return "read";
  }

  if (action.type === "create_sheet_tab") return "critical";
  if (action.type === "update_sheet") {
    if (action.payload.operation === "clear_range") return "critical";
    const rowCount = action.payload.values?.length ?? 0;
    const cellCount = action.payload.values?.flat().length ?? 0;
    if (rowCount > 5 || cellCount > 50) return "critical";
    return "safe_write";
  }

  if (
    action.type === "update_task" ||
    action.type === "complete_task" ||
    action.type === "update_calendar_event" ||
    action.type === "update_project_status"
  ) {
    return "sensitive_write";
  }

  return "safe_write";
}

function collectEvidence(
  strategic: StrategicAction | undefined,
  projectContext?: AssistantProjectContext,
) {
  return unique([
    ...(strategic?.evidence ?? []),
    ...(projectContext?.resolution === "resolved" && projectContext.activeProject
      ? [`Активный проект: ${projectContext.activeProject.name}`]
      : []),
  ]);
}

function buildQuestion(
  action: AssistantAction,
  projectContext: AssistantProjectContext | undefined,
  decision: "clarify" | "confirm",
) {
  if (decision === "confirm") {
    return `Подтверди опасное действие: ${action.type}.`;
  }
  if (
    projectContext?.resolution === "ambiguous" &&
    projectContext.candidates.length > 1
  ) {
    return `К какому проекту относится действие: ${projectContext.candidates
      .slice(0, 4)
      .map((candidate) => `«${candidate.name}»`)
      .join(" или ")}?`;
  }
  if (action.type === "update_sheet") {
    return "Какую существующую строку таблицы нужно обновить?";
  }
  if (action.type === "create_task") {
    return "В какой проект TickTick добавить эту задачу?";
  }
  return `Уточни контекст для действия ${action.type}.`;
}

function requiresResolvedProject(action: AssistantAction) {
  return (
    action.type === "update_sheet" ||
    action.type === "add_metrics" ||
    action.type === "update_metrics" ||
    action.type === "update_project_status"
  );
}

function hasExplicitResourceId(action: AssistantAction) {
  return (
    action.type === "update_sheet" &&
    action.payload.target.kind === "id"
  );
}

function parseSingleRow(range: string) {
  const cells = range.split("!").at(-1) ?? "";
  const match = cells.match(/^[A-Z]+(\d+)(?::[A-Z]+\1)?$/iu);
  return match ? Number(match[1]) : undefined;
}

function roundConfidence(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function normalize(value: string | undefined) {
  return (value ?? "")
    .normalize("NFC")
    .toLocaleLowerCase("ru")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
