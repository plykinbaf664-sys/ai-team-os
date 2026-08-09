import type { AssistantProjectContext } from "./project-context";
import type {
  ActionPlan,
  ActionResult,
  AssistantAction,
  ExistingSheetTarget,
  SheetCellValue,
} from "./types";

const DISCOVERY_ACTIONS = new Set<AssistantAction["type"]>([
  "find_sheet",
  "read_sheet",
  "list_tasks",
]);

export function repairAssistantReadTargets(
  plan: ActionPlan,
  projectContext?: AssistantProjectContext,
): ActionPlan {
  const actions = plan.actions.map((action) => {
    if (action.type !== "read_sheet" || isSheetTarget(action.payload.target)) {
      return action;
    }

    const target = resolveSheetTarget(plan, action.payload.range, projectContext);
    return target
      ? {
          ...action,
          payload: {
            ...action.payload,
            target,
          },
        }
      : action;
  });

  return { ...plan, actions };
}

export function createDiscoveryPlan(plan: ActionPlan): ActionPlan | null {
  if (plan.continueAfterReads !== true) return null;
  const actions = plan.actions
    .filter((action) => DISCOVERY_ACTIONS.has(action.type))
    .slice(0, 6)
    .map((action, index) => ({
      ...action,
      id: `discovery-${index + 1}`,
    }));

  if (!actions.length) return null;

  return {
    version: 1,
    mode: plan.mode,
    sourceText: plan.sourceText,
    actions,
    continueAfterReads: false,
  };
}

export function formatAssistantToolContext(
  plan: ActionPlan,
  results: ActionResult[],
) {
  const byId = new Map(results.map((result) => [result.actionId, result]));
  const observations = plan.actions.map((action, index) => {
    const result = byId.get(action.id);
    return formatObservation({
      index,
      action: {
        type: action.type,
        payload: action.payload,
      },
      result: result
        ? {
            status: result.status,
            errorCode: result.errorCode,
            data: result.data,
            message: result.message.slice(0, 1_500),
          }
        : { status: "failed", message: "Tool result is missing." },
    });
  });
  const budget = Math.max(1_500, Math.floor(20_000 / Math.max(1, observations.length)));

  return observations
    .map((observation) => truncateEvenly(observation, budget))
    .join("\n\n");
}

function formatObservation({
  index,
  action,
  result,
}: {
  index: number;
  action: { type: AssistantAction["type"]; payload: unknown };
  result: {
    status: ActionResult["status"];
    errorCode?: string;
    data?: ActionResult["data"];
    message: string;
  };
}) {
  const lines = [
    `Наблюдение ${index + 1}`,
    `Действие: ${action.type}; параметры: ${JSON.stringify(action.payload)}`,
    `Результат: ${result.status}${result.errorCode ? `; ошибка: ${result.errorCode}` : ""}`,
    `Сообщение: ${result.message}`,
  ];

  if (result.data?.kind === "sheet_range") {
    lines.push(
      `Таблица: ${result.data.spreadsheetTitle} [${result.data.spreadsheetId}]`,
      `Диапазон: ${result.data.range}`,
      "Данные:",
      ...formatSheetRows(result.data.values),
    );
  } else if (result.data) {
    lines.push(`Данные: ${JSON.stringify(result.data)}`);
  }

  return lines.join("\n");
}

function formatSheetRows(values: SheetCellValue[][]) {
  if (!values.length) return ["(пусто)"];
  const rowBudget = Math.max(120, Math.floor(12_000 / values.length));

  return values.map((row, index) => {
    const cells = row.map((cell) => String(cell ?? "").trim());
    return truncateEvenly(`${index + 1}: ${cells.join(" | ")}`, rowBudget);
  });
}

function truncateEvenly(value: string, limit: number) {
  if (value.length <= limit) return value;
  const headLength = Math.ceil((limit - 3) * 0.65);
  const tailLength = Math.max(0, limit - 3 - headLength);
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}

export function mergeDiscoveryPlan(
  finalPlan: ActionPlan,
  discoveryPlan: ActionPlan,
): ActionPlan {
  return {
    ...finalPlan,
    continueAfterReads: false,
    actions: [...discoveryPlan.actions, ...finalPlan.actions],
  };
}

export function isDiscoveryAction(action: AssistantAction) {
  return DISCOVERY_ACTIONS.has(action.type);
}

function resolveSheetTarget(
  plan: ActionPlan,
  range: string | undefined,
  projectContext?: AssistantProjectContext,
): ExistingSheetTarget | undefined {
  const sheetName = extractSheetName(range);
  const strategicResources = (plan.strategicPlan?.targetResources ?? []).filter(
    (resource) =>
      resource.type === "google_sheet" &&
      (!sheetName || !resource.sheetName || normalize(resource.sheetName) === normalize(sheetName)),
  );
  const strategic = strategicResources.find((resource) => resource.externalId);

  if (strategic?.externalId) {
    return { kind: "id", spreadsheetId: strategic.externalId };
  }

  const linked = (projectContext?.activeProject?.resources ?? []).filter(
    (resource) => resource.resourceType === "google_sheet",
  );

  if (linked.length === 1) {
    return { kind: "id", spreadsheetId: linked[0].externalId };
  }

  return undefined;
}

function extractSheetName(range?: string) {
  if (!range?.includes("!")) return undefined;
  return range
    .split("!", 1)[0]
    .trim()
    .replace(/^'(.*)'$/u, "$1")
    .replace(/''/g, "'");
}

function isSheetTarget(value: unknown): value is ExistingSheetTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    (target.kind === "id" && typeof target.spreadsheetId === "string") ||
    (target.kind === "title" && typeof target.title === "string")
  );
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("ru").trim();
}
