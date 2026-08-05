import type { AssistantProjectContext } from "./project-context";
import type {
  ActionPlan,
  ActionResult,
  AssistantAction,
  ExistingSheetTarget,
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
  const observations = plan.actions.map((action) => {
    const result = byId.get(action.id);
    return {
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
    };
  });
  const serialized = JSON.stringify(observations);

  return serialized.length <= 20_000
    ? serialized
    : `${serialized.slice(0, 20_000)}…`;
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
