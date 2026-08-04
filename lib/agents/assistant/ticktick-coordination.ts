import type { AssistantProjectContext } from "./project-context";
import type {
  ActionPlan,
  AssistantConversationMessage,
  CreateTaskAction,
  StrategicTargetResource,
  SuggestedAction,
  TaskSourceEntity,
} from "./types";

const TASK_SOURCE_MARKER_PREFIX = "ai-team-os:google-sheet-row:";
const PROJECT_NAME_STOP_TOKENS = new Set([
  "запуск",
  "проект",
  "проекта",
  "агент",
  "агенты",
  "агентов",
  "день",
  "дня",
  "дней",
]);

export function coordinateTickTickPlan(
  plan: ActionPlan,
  {
    sourceText,
    conversation = [],
    projectContext,
    tickTickProjectNames = [],
  }: {
    sourceText: string;
    conversation?: AssistantConversationMessage[];
    projectContext?: AssistantProjectContext;
    tickTickProjectNames?: string[];
  },
): ActionPlan {
  if (!plan.strategicPlan) return plan;

  const sourceEntity = resolveTaskSourceEntity(
    plan.strategicPlan.targetResources,
  );
  const linkedProject = resolveLinkedTickTickProject(
    projectContext,
    tickTickProjectNames,
  );
  const explicitlyRequested = isExplicitTaskRequest(
    sourceText,
    conversation,
  );
  const actions = plan.actions.map((action): typeof action => {
    if (action.type !== "create_task") return action;

    return {
      ...action,
      payload: {
        ...action.payload,
        ...(action.payload.project || !linkedProject
          ? {}
          : { project: linkedProject.externalId }),
        ...(action.payload.sourceEntity || !sourceEntity
          ? {}
          : { sourceEntity }),
      },
    };
  });
  const proactiveTasks = explicitlyRequested
    ? []
    : actions.filter(
        (action): action is CreateTaskAction => action.type === "create_task",
      );
  let suggestions = plan.strategicPlan.suggestions;

  if (proactiveTasks[0]) {
    suggestions = upsertSuggestion(
      suggestions,
      createTaskSuggestion(proactiveTasks[0]),
    );
  }

  suggestions = enrichFollowUpSuggestion({
    suggestions,
    sourceEntity,
    linkedProjectId: linkedProject?.externalId,
    projectContext,
  });

  const proactiveIds = new Set(proactiveTasks.map((action) => action.id));
  const strategicActions = plan.strategicPlan.actions.map((action) =>
    action.kind === "execute_action" &&
    action.linkedActionId &&
    proactiveIds.has(action.linkedActionId)
      ? { ...action, executionPolicy: "suggest_first" as const }
      : action,
  );

  return {
    ...plan,
    actions,
    strategicPlan: {
      ...plan.strategicPlan,
      actions: strategicActions,
      suggestions,
    },
  };
}

export function buildTaskSourceMarker(
  source: TaskSourceEntity,
  taskTitle: string,
) {
  return `[${TASK_SOURCE_MARKER_PREFIX}${encodeURIComponent(source.spreadsheetId)}:${encodeURIComponent(source.entityId)}:${encodeURIComponent(taskPurpose(taskTitle))}]`;
}

export function buildTaskSourceContent(
  source: TaskSourceEntity,
  taskTitle: string,
) {
  const spreadsheet = source.spreadsheetTitle
    ? `«${source.spreadsheetTitle}»`
    : source.spreadsheetId;
  const entity = source.entityLabel ? `, объект «${source.entityLabel}»` : "";

  return [
    `Источник: Google Sheets ${spreadsheet}, лист «${source.sheetName}», строка ${source.rowNumber}${entity}.`,
    buildTaskSourceMarker(source, taskTitle),
  ].join("\n");
}

export function parseTaskSourceMarker(content: string | undefined) {
  if (!content) return undefined;
  const match = content.match(
    /\[ai-team-os:google-sheet-row:([^:\]]+):([^:\]]+):([^\]]+)\]/u,
  );
  if (!match) return undefined;

  try {
    return {
      spreadsheetId: decodeURIComponent(match[1]),
      entityId: decodeURIComponent(match[2]),
      purpose: decodeURIComponent(match[3]),
    };
  } catch {
    return undefined;
  }
}

function taskPurpose(title: string) {
  if (/follow.?up|повтор|пушн/iu.test(title)) return "follow_up";
  return title
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function resolveTaskSourceEntity(
  resources: StrategicTargetResource[],
): TaskSourceEntity | undefined {
  const matches = resources.filter(
    (resource) =>
      resource.type === "google_sheet" &&
      resource.externalId &&
      resource.sheetName &&
      resource.entityId &&
      resource.rowNumber,
  );
  if (matches.length !== 1) return undefined;
  const resource = matches[0];

  return {
    type: "google_sheet_row",
    spreadsheetId: resource.externalId!,
    ...(resource.title ? { spreadsheetTitle: resource.title } : {}),
    sheetName: resource.sheetName!,
    rowNumber: resource.rowNumber!,
    entityId: resource.entityId!,
    ...(resource.entityLabel ? { entityLabel: resource.entityLabel } : {}),
  };
}

function resolveLinkedTickTickProject(
  context: AssistantProjectContext | undefined,
  projectNames: string[],
) {
  const matches = (context?.activeProject?.resources ?? []).filter(
    (resource) => resource.resourceType === "ticktick_project",
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 || !context?.activeProject) return undefined;

  const references = [
    context.activeProject.name,
    ...context.activeProject.aliases,
  ];
  const ranked = projectNames
    .map((name) => ({ name, score: projectNameScore(name, references) }))
    .sort((left, right) => right.score - left.score);
  if (
    !ranked[0] ||
    ranked[0].score < 0.55 ||
    ranked[0].score - (ranked[1]?.score ?? 0) < 0.2
  ) {
    return undefined;
  }

  return {
    externalId: ranked[0].name,
    title: ranked[0].name,
  };
}

function projectNameScore(candidate: string, references: string[]) {
  const candidateTokens = projectNameTokens(candidate);
  return Math.max(
    0,
    ...references.map((reference) => {
      const referenceTokens = projectNameTokens(reference);
      const intersection = [...candidateTokens].filter((token) =>
        referenceTokens.has(token),
      ).length;
      const smaller = Math.min(candidateTokens.size, referenceTokens.size);
      return smaller ? intersection / smaller : 0;
    }),
  );
}

function projectNameTokens(value: string) {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase("ru")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => {
        if (token === "ai" || token === "ии") return "ai";
        if (token === "marketplace" || token.startsWith("магазин")) {
          return "marketplace";
        }
        return token;
      })
      .filter((token) => !PROJECT_NAME_STOP_TOKENS.has(token)),
  );
}

function createTaskSuggestion(action: CreateTaskAction): SuggestedAction {
  return {
    id: /follow.?up|повтор/iu.test(action.payload.title)
      ? "suggest-follow-up"
      : `suggest-${action.id}`,
    title: "Создать одну задачу в TickTick",
    reason: `Следующее конкретное действие: «${action.payload.title}».`,
    evidence: [action.payload.sourceEntity?.entityLabel, action.payload.title]
      .filter((value): value is string => Boolean(value)),
    confidence: 0.9,
    proposedTask: { ...action.payload },
  };
}

function enrichFollowUpSuggestion({
  suggestions,
  sourceEntity,
  linkedProjectId,
  projectContext,
}: {
  suggestions: SuggestedAction[];
  sourceEntity?: TaskSourceEntity;
  linkedProjectId?: string;
  projectContext?: AssistantProjectContext;
}) {
  if (!sourceEntity?.entityLabel) return suggestions;
  const followUp = suggestions.find(isFollowUpSuggestion);
  if (!followUp || followUp.proposedTask) return suggestions;
  const dueDateText = extractExactFollowUpDelay([
    followUp.title,
    followUp.reason,
    ...followUp.evidence,
    ...(projectContext?.activeProject?.operatingRules
      .filter((rule) => /follow.?up|повтор/iu.test(`${rule.key} ${rule.text}`))
      .map((rule) => rule.text) ?? []),
  ]);
  if (!dueDateText) return suggestions;

  return upsertSuggestion(suggestions, {
    ...followUp,
    title: "Создать одну follow-up задачу в TickTick",
    proposedTask: {
      title: `Сделать follow-up по «${sourceEntity.entityLabel}»`,
      dueDateText,
      ...(linkedProjectId ? { project: linkedProjectId } : {}),
      sourceEntity,
    },
  });
}

function extractExactFollowUpDelay(values: string[]) {
  for (const value of values) {
    const match = value.match(/через\s+(\d{1,3})\s+(?:день|дня|дней)/iu);
    if (!match) continue;
    const days = Number(match[1]);
    if (days >= 1 && days <= 365) return `через ${days} ${dayWord(days)}`;
  }
  return undefined;
}

function dayWord(days: number) {
  const lastTwo = days % 100;
  const last = days % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "дней";
  if (last === 1) return "день";
  if (last >= 2 && last <= 4) return "дня";
  return "дней";
}

function isExplicitTaskRequest(
  sourceText: string,
  conversation: AssistantConversationMessage[],
) {
  const normalized = sourceText
    .trim()
    .replace(/^(?:ассистент|assistant)(?:@\w+)?[\s,.:;—-]+/iu, "");
  if (
    /(?:создай|создать|добавь|добавить|поставь|поставить|занеси|занести).{0,40}(?:задач|tick\s*tick|тик\s*тик)|(?:напомни|напоминание)/iu.test(
      normalized,
    )
  ) {
    return true;
  }
  if (!/^(?:да|давай|создай|создавай|добавь|добавляй|подтверждаю)[\s.!]*$/iu.test(normalized)) {
    return false;
  }

  const previousAssistant = [...conversation]
    .reverse()
    .find((message) => message.role === "assistant");
  return Boolean(
    previousAssistant &&
      /создать.{0,50}(?:задач|tick\s*tick|тик\s*тик)|задач.{0,50}(?:tick\s*tick|тик\s*тик)/iu.test(
        previousAssistant.text,
      ),
  );
}

function isFollowUpSuggestion(suggestion: SuggestedAction) {
  return /follow.?up|повтор/iu.test(
    `${suggestion.id} ${suggestion.title} ${suggestion.reason}`,
  );
}

function upsertSuggestion(
  suggestions: SuggestedAction[],
  suggestion: SuggestedAction,
) {
  return [
    ...suggestions.filter((candidate) => candidate.id !== suggestion.id),
    suggestion,
  ].slice(0, 5);
}
