import type { AssistantProjectContext } from "./project-context";
import type {
  GoogleSheetsWorkspaceContext,
  InspectedSheetTab,
} from "../../integrations/google-sheets/document-context";
import type {
  ActionPlan,
  AssistantAction,
  AssistantPlanOutcome,
  StrategicAction,
  StrategicActionKind,
  StrategicActionPlan,
  StrategicAssumption,
  StrategicExecutionPolicy,
  StrategicFact,
  StrategicTargetResource,
  SuggestedAction,
  UpdateSheetAction,
} from "./types";
import { columnName } from "../../integrations/google-sheets/sheet-profile";
import {
  resolveDateFromText,
  resolveTimeRangeFromText,
} from "./conversation-reconciliation";

type StrategicPlanInput = {
  sourceText: string;
  actions: AssistantAction[];
  projectContext?: AssistantProjectContext;
};

const FACT_SOURCES: StrategicFact["source"][] = [
  "message",
  "project_context",
  "resource_context",
  "history",
];
const RESOURCE_TYPES: StrategicTargetResource["type"][] = [
  "google_sheet",
  "ticktick_project",
  "calendar",
  "other",
];
const EXECUTION_POLICIES: StrategicExecutionPolicy[] = [
  "auto_execute",
  "suggest_first",
  "confirm_first",
];
const STRATEGIC_ACTION_KINDS: StrategicActionKind[] = [
  "execute_action",
  "recalculate_metrics",
  "audit_log",
  "verify_result",
];

export function attachStrategicPlan(
  plan: ActionPlan,
  projectContext?: AssistantProjectContext,
): ActionPlan {
  if (plan.strategicPlan) {
    return plan;
  }

  return {
    ...plan,
    strategicPlan: createFallbackStrategicActionPlan({
      sourceText: plan.sourceText,
      actions: plan.actions,
      projectContext,
    }),
  };
}

export function normalizeStrategicActionPlan(
  value: unknown,
  input: StrategicPlanInput,
): StrategicActionPlan {
  const fallback = createFallbackStrategicActionPlan(input);

  if (!isObject(value)) {
    return fallback;
  }

  const activeProject = input.projectContext?.activeProject;
  const targetResources = normalizeTargetResources(
    value.targetResources,
    activeProject?.resources ?? [],
  );

  return {
    version: 1,
    userGoal: textOr(value.userGoal, fallback.userGoal),
    projectId:
      activeProject?.id ?? nullableText(value.projectId) ?? fallback.projectId,
    targetResources:
      targetResources.length > 0
        ? targetResources
        : fallback.targetResources,
    factsFromMessage: normalizeFacts(value.factsFromMessage, "message"),
    factsFromContext: normalizeFacts(value.factsFromContext),
    assumptions: normalizeAssumptions(value.assumptions),
    actions: normalizeActions(value.actions, input.actions, input.sourceText),
    suggestions: normalizeSuggestions(value.suggestions),
    clarification: normalizeClarification(value.clarification),
    summaryIntent: textOr(value.summaryIntent, fallback.summaryIntent),
  };
}

export function reconcileStrategicPlanWithSheets(
  outcome: AssistantPlanOutcome,
  sourceText: string,
  workspace?: GoogleSheetsWorkspaceContext,
  {
    timezone,
    now = new Date(),
  }: {
    timezone?: string;
    now?: Date;
  } = {},
): AssistantPlanOutcome {
  if (outcome.kind !== "ready" || !workspace) return outcome;
  outcome = reconcileSheetReadTargets(outcome, sourceText, workspace);
  const contactOutcome = reconcileContactRecord(
    outcome,
    sourceText,
    workspace,
    { timezone, now },
  );
  if (contactOutcome) return contactOutcome;
  const increment = extractOutreachIncrement(sourceText);
  const explicitTotal = extractExplicitOutreachTotal(sourceText);
  if (increment === null && explicitTotal === null) return outcome;
  const reportedValue = explicitTotal ?? increment!;

  const candidates = workspace.inspectedDocuments
    .flatMap((document) =>
      document.tabs.flatMap((tab) =>
        tab.profile.entityType === "outreach_segment" &&
        tab.profile.columns.some(
          (column) => column.semanticKey === "actual_sends",
        )
          ? tab.rowMatches
              .filter(
                (match) =>
                  match.confidence >=
                    tab.profile.rowMatchingRules.minimumConfidence &&
                  !isAggregateRow(match.entity.rowKey),
              )
              .map((match) => ({ document, tab, match }))
          : [],
      ),
    )
    .sort((left, right) => right.match.confidence - left.match.confidence);
  const first = candidates[0];
  const second = candidates[1];

  if (!first) {
    return invalidSheetTarget(outcome, workspace)
      ? {
          kind: "clarification",
          question:
            "Не нашёл в связанных таблицах строку партнёрского сегмента. Как называется нужный сегмент?",
          missingField: "sheet.row_entity",
        }
      : outcome;
  }

  if (
    second &&
    first.match.confidence - second.match.confidence <
      first.tab.profile.rowMatchingRules.ambiguityDelta
  ) {
    return {
      kind: "clarification",
      question: `К какому сегменту относятся ${reportedValue} рассылок: «${shortRowKey(first.match.entity.rowKey)}» или «${shortRowKey(second.match.entity.rowKey)}»?`,
      missingField: "sheet.row_entity",
    };
  }

  const metricColumn = first.tab.profile.columns.find(
    (column) => column.semanticKey === "actual_sends",
  );
  const updateAction = outcome.plan.actions.find(
    (action): action is UpdateSheetAction => action.type === "update_sheet",
  );
  const currentValue = metricColumn
    ? parseFiniteNumber(first.match.entity.values[metricColumn.index])
    : null;

  if (!metricColumn || !updateAction || currentValue === null) {
    return {
      kind: "clarification",
      question:
        "Нашёл партнёрский сегмент, но не смог безопасно определить текущее значение отправок. Проверить, где хранится факт рассылок?",
      missingField: "sheet.actual_sends_source",
    };
  }

  if (explicitTotal !== null && explicitTotal < currentValue) {
    return {
      kind: "clarification",
      question: `В таблице уже зафиксировано ${currentValue} отправок, а в сообщении указан итог ${explicitTotal}. Это исправление общего факта до ${explicitTotal}?`,
      missingField: "sheet.actual_sends_conflict",
    };
  }

  const nextValue = explicitTotal ?? currentValue + increment!;
  const correctedAction: UpdateSheetAction = {
    ...updateAction,
    payload: {
      target: {
        kind: "id",
        spreadsheetId: first.document.spreadsheetId,
      },
      range: `'${first.tab.title.replace(/'/g, "''")}'!${metricColumn.columnLetter}${first.match.entity.rowNumber}`,
      operation: "update_cells",
      values: [[nextValue]],
    },
  };
  const actions = outcome.plan.actions.map((action) =>
    action.id === updateAction.id ? correctedAction : action,
  );
  const base = outcome.plan.strategicPlan ??
    createFallbackStrategicActionPlan({ sourceText, actions });
  const existingExecution = base.actions.find(
    (action) =>
      action.kind === "execute_action" &&
      action.linkedActionId === correctedAction.id,
  );
  const strategicActions: StrategicAction[] = [
    {
      ...(existingExecution ?? fallbackStrategicAction(correctedAction, sourceText)),
      id: existingExecution?.id ?? `execute-${correctedAction.id}`,
      kind: "execute_action",
      linkedActionId: correctedAction.id,
      actionType: "update_sheet",
      executionPolicy: "auto_execute",
      expectedChange: `actual_sends: ${currentValue} → ${nextValue}`,
      verification: `Повторно прочитать ${metricColumn.columnLetter}${first.match.entity.rowNumber}.`,
    },
    ...ensureOperationalSteps(base.actions, currentValue, nextValue),
  ];
  const followUpSuggestion = createFollowUpSuggestion(first.tab, first.match.entity.values);

  return {
    kind: "ready",
    plan: {
      ...outcome.plan,
      actions,
      strategicPlan: {
        ...base,
        targetResources: [
          {
            type: "google_sheet",
            externalId: first.document.spreadsheetId,
            title: first.document.title,
            sheetName: first.tab.title,
            entityId: first.match.entity.entityId,
            entityLabel: shortRowKey(first.match.entity.rowKey),
            rowNumber: first.match.entity.rowNumber,
          },
        ],
        factsFromContext: upsertFact(base.factsFromContext, {
          key: "current_actual_sends",
          value: currentValue,
          source: "resource_context",
          evidence: `${first.tab.title}, строка ${first.match.entity.rowNumber}`,
        }),
        actions: strategicActions,
        suggestions: followUpSuggestion
          ? upsertSuggestion(base.suggestions, followUpSuggestion)
          : base.suggestions,
        summaryIntent: `Обновить существующий сегмент «${shortRowKey(first.match.entity.rowKey)}» и проверить связанные показатели.`,
      },
    },
  };
}

function reconcileSheetReadTargets(
  outcome: Extract<AssistantPlanOutcome, { kind: "ready" }>,
  sourceText: string,
  workspace: GoogleSheetsWorkspaceContext,
): Extract<AssistantPlanOutcome, { kind: "ready" }> {
  const normalizedSource = normalizeResourceName(sourceText);
  const explicitlyMentionedDocuments = workspace.inspectedDocuments.filter(
    (document) =>
      normalizedSource.includes(normalizeResourceName(document.title)),
  );

  const actions = outcome.plan.actions.map((action) => {
    if (action.type !== "read_sheet" || !action.payload.range) {
      return action;
    }

    const sheetName = extractRangeSheetName(action.payload.range);
    if (!sheetName) return action;

    const documentsWithTab = workspace.inspectedDocuments.filter((document) =>
      document.tabs.some(
        (tab) =>
          normalizeResourceName(tab.title) ===
          normalizeResourceName(sheetName),
      ),
    );
    const explicitlyMentionedMatches = explicitlyMentionedDocuments.filter(
      (document) => documentsWithTab.includes(document),
    );
    const candidates = explicitlyMentionedMatches.length
      ? explicitlyMentionedMatches
      : documentsWithTab;

    if (candidates.length !== 1) return action;

    return {
      ...action,
      payload: {
        ...action.payload,
        target: {
          kind: "id" as const,
          spreadsheetId: candidates[0].spreadsheetId,
        },
      },
    };
  });

  return {
    ...outcome,
    plan: {
      ...outcome.plan,
      actions,
    },
  };
}

function extractRangeSheetName(range: string) {
  const separatorIndex = range.indexOf("!");
  if (separatorIndex < 1) return "";

  return range
    .slice(0, separatorIndex)
    .trim()
    .replace(/^'(.*)'$/u, "$1")
    .replace(/''/g, "'");
}

function normalizeResourceName(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function reconcileContactRecord(
  outcome: Extract<AssistantPlanOutcome, { kind: "ready" }>,
  sourceText: string,
  workspace: GoogleSheetsWorkspaceContext,
  {
    timezone,
    now,
  }: {
    timezone?: string;
    now: Date;
  },
): AssistantPlanOutcome | null {
  const sheetWriteRequested =
    /(?:таблиц|google\s*sheets?|гугл[^\n]*таблиц)/iu.test(sourceText) &&
    /(?:добав|занес|внес|зафикс|запиш|обнов)/iu.test(sourceText);
  const contactIntent =
    /(?:аккаунт|контакт|карточк|человек|лид|сделк|созвон|встреч)/iu.test(sourceText) ||
    /https?:\/\//iu.test(sourceText);
  const plannedSheetAction = outcome.plan.actions.find(
    (action): action is UpdateSheetAction => action.type === "update_sheet",
  );

  if (!contactIntent || (!sheetWriteRequested && !plannedSheetAction)) {
    return null;
  }

  const contactTabs = workspace.inspectedDocuments.flatMap((document) =>
    document.tabs
      .filter((tab) => tab.profile.entityType === "contact_record")
      .map((tab) => ({ document, tab })),
  );
  const rankedTabs = contactTabs.sort(
    (left, right) =>
      contactTabScore(right.tab.title) - contactTabScore(left.tab.title),
  );
  const firstTab = rankedTabs[0];

  if (!firstTab) {
    return {
      kind: "clarification",
      question:
        "Не нашёл в связанных документах операционный лист с карточками контактов. Как называется такая таблица или лист?",
      missingField: "sheet.contact_resource",
    };
  }
  if (
    rankedTabs[1] &&
    contactTabScore(firstTab.tab.title) === contactTabScore(rankedTabs[1].tab.title)
  ) {
    return {
      kind: "clarification",
      question: `Нашёл два равнозначных листа контактов: «${firstTab.tab.title}» и «${rankedTabs[1].tab.title}». В какой вести эту карточку?`,
      missingField: "sheet.contact_resource",
    };
  }

  const url = extractUrl(sourceText);
  const explicitName = extractContactName(sourceText);
  if (!url && !explicitName) {
    return {
      kind: "clarification",
      question: "Кого добавить? Пришли имя или ссылку на контакт.",
      missingField: "sheet.contact_identity",
    };
  }

  const date = resolveDateFromText(sourceText, now, timezone);
  const { startTime, endTime } = resolveTimeRangeFromText(sourceText);
  const existingMatches = firstTab.tab.rowMatches.filter(
    (match) =>
      match.confidence >= firstTab.tab.profile.rowMatchingRules.minimumConfidence &&
      isExactContactIdentity(
        firstTab.tab,
        match.entity.values,
        url,
        explicitName,
      ),
  );
  if (
    existingMatches[1] &&
    existingMatches[0].confidence - existingMatches[1].confidence <
      firstTab.tab.profile.rowMatchingRules.ambiguityDelta
  ) {
    return {
      kind: "clarification",
      question: `Нашёл несколько похожих контактов: «${shortRowKey(existingMatches[0].entity.rowKey)}» и «${shortRowKey(existingMatches[1].entity.rowKey)}». Какой из них обновить?`,
      missingField: "sheet.contact_row",
    };
  }

  const existing = existingMatches[0];
  const contactActions = existing
    ? buildExistingContactUpdates({
        actionId: plannedSheetAction?.id ?? "action-contact",
        spreadsheetId: firstTab.document.spreadsheetId,
        tab: firstTab.tab,
        rowNumber: existing.entity.rowNumber,
        existingValues: existing.entity.values,
        sourceText,
        url,
        date,
        startTime,
        endTime,
      })
    : [
        buildNewContactAppend({
          actionId: plannedSheetAction?.id ?? "action-contact",
          spreadsheetId: firstTab.document.spreadsheetId,
          tab: firstTab.tab,
          sourceText,
          url,
          explicitName,
          date,
          startTime,
          endTime,
        }),
      ];

  const actions = replacePlannedSheetAction(
    outcome.plan.actions,
    plannedSheetAction,
    contactActions,
  );
  const base = outcome.plan.strategicPlan ??
    createFallbackStrategicActionPlan({ sourceText, actions });
  const contactIds = new Set(contactActions.map((action) => action.id));
  const strategicActions = actions.map((action) => {
    const previous = base.actions.find(
      (candidate) =>
        candidate.kind === "execute_action" &&
        candidate.linkedActionId === action.id,
    );
    if (!contactIds.has(action.id)) {
      return previous ?? fallbackStrategicAction(action, sourceText);
    }
    return {
      ...(previous ?? fallbackStrategicAction(action, sourceText)),
      id: `execute-${action.id}`,
      linkedActionId: action.id,
      actionType: "update_sheet" as const,
      reason: existing
        ? "Контакт уверенно найден по данным сообщения; обновляется его существующая карточка."
        : "Пользователь прямо попросил добавить новый контакт в связанную операционную таблицу.",
      evidence: [url ?? explicitName ?? sourceText.trim()],
      confidence: 1,
      executionPolicy: "auto_execute" as const,
      expectedChange: existing
        ? `Обновить карточку контакта в строке ${existing.entity.rowNumber}.`
        : `Добавить одну карточку в лист «${firstTab.tab.title}».`,
      verification: "Повторно прочитать изменённую строку и сверить сохранённые факты.",
    };
  });

  return {
    kind: "ready",
    plan: {
      ...outcome.plan,
      actions,
      strategicPlan: {
        ...base,
        targetResources: [
          ...base.targetResources.filter(
            (resource) => resource.type !== "google_sheet",
          ),
          {
            type: "google_sheet",
            externalId: firstTab.document.spreadsheetId,
            title: firstTab.document.title,
            sheetName: firstTab.tab.title,
            ...(existing
              ? {
                  entityId: existing.entity.entityId,
                  entityLabel: shortRowKey(existing.entity.rowKey),
                  rowNumber: existing.entity.rowNumber,
                }
              : {}),
          },
        ],
        factsFromContext: upsertFact(base.factsFromContext, {
          key: "contact_sheet_resolution",
          value: firstTab.tab.title,
          source: "resource_context",
          evidence: `Sheet Profile: entity_type=contact_record; лист «${firstTab.tab.title}».`,
        }),
        actions: strategicActions,
        summaryIntent: existing
          ? `Обновить существующую карточку контакта в листе «${firstTab.tab.title}».`
          : `Добавить новую карточку контакта в лист «${firstTab.tab.title}», сохранив только известные факты.`,
      },
    },
  };
}

function buildNewContactAppend({
  actionId,
  spreadsheetId,
  tab,
  sourceText,
  url,
  explicitName,
  date,
  startTime,
  endTime,
}: {
  actionId: string;
  spreadsheetId: string;
  tab: InspectedSheetTab;
  sourceText: string;
  url?: string;
  explicitName?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
}): UpdateSheetAction {
  const values = tab.profile.columns.map((column) => {
    switch (column.semanticKey) {
      case "name":
      case "contact_name":
        return explicitName ?? null;
      case "source_contact":
        return url ?? null;
      case "next_contact_at":
        return date ?? null;
      case "status":
        return date && startTime && /созвон|встреч/iu.test(sourceText)
          ? "Созвон назначен"
          : null;
      case "interview_at":
        return date && startTime ? `${date} ${startTime}` : null;
      case "current_process":
        return buildContactProcess(sourceText, url, date, startTime, endTime);
      default:
        return null;
    }
  });

  return {
    id: actionId,
    type: "update_sheet",
    payload: {
      target: { kind: "id", spreadsheetId },
      range: `'${tab.title.replace(/'/g, "''")}'!A:${columnName(tab.profile.columns.length - 1)}`,
      operation: "append_rows",
      values: [values],
    },
  };
}

function buildExistingContactUpdates({
  actionId,
  spreadsheetId,
  tab,
  rowNumber,
  existingValues,
  sourceText,
  url,
  date,
  startTime,
  endTime,
}: {
  actionId: string;
  spreadsheetId: string;
  tab: InspectedSheetTab;
  rowNumber: number;
  existingValues: unknown[];
  sourceText: string;
  url?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
}) {
  const updates: Array<{ semanticKey: string; value: string }> = [];
  if (date) updates.push({ semanticKey: "next_contact_at", value: date });
  if (date && startTime && /созвон|встреч/iu.test(sourceText)) {
    updates.push({ semanticKey: "status", value: "Созвон назначен" });
    updates.push({ semanticKey: "interview_at", value: `${date} ${startTime}` });
  }
  const processColumn = tab.profile.columns.find(
    (column) => column.semanticKey === "current_process",
  );
  if (processColumn) {
    const previous = String(existingValues[processColumn.index] ?? "").trim();
    const next = buildContactProcess(sourceText, url, date, startTime, endTime);
    updates.push({
      semanticKey: "current_process",
      value: previous && !previous.includes(next) ? `${previous}\n${next}` : next,
    });
  }

  return updates.flatMap((update, index): UpdateSheetAction[] => {
    const column = tab.profile.columns.find(
      (candidate) => candidate.semanticKey === update.semanticKey,
    );
    if (!column || column.isProtected || column.isFormula) return [];
    return [{
      id: index === 0 ? actionId : `${actionId}-${index + 1}`,
      type: "update_sheet",
      payload: {
        target: { kind: "id", spreadsheetId },
        range: `'${tab.title.replace(/'/g, "''")}'!${column.columnLetter}${rowNumber}`,
        operation: "update_cells",
        values: [[update.value]],
      },
    }];
  });
}

function replacePlannedSheetAction(
  actions: AssistantAction[],
  planned: UpdateSheetAction | undefined,
  replacements: UpdateSheetAction[],
) {
  if (!planned) return [...replacements, ...actions];
  return actions.flatMap((action) =>
    action.id === planned.id ? replacements : [action],
  );
}

function buildContactProcess(
  sourceText: string,
  url?: string,
  date?: string,
  startTime?: string,
  endTime?: string,
) {
  if (date && startTime && /созвон|встреч/iu.test(sourceText)) {
    const time = endTime ? `${startTime}–${endTime}` : startTime;
    return `Созвон назначен на ${date}, ${time}${url ? `. Контакт: ${url}` : ""}.`;
  }
  return sourceText.trim().replace(/\s+/g, " ").slice(0, 500);
}

function extractUrl(value: string) {
  return value.match(/https?:\/\/[^\s,;]+/iu)?.[0].replace(/[).!?]+$/u, "");
}

function extractContactName(value: string) {
  return value.match(
    /(?:контакт|аккаунт|лид|карточк[ау])\s+(?:с\s+)?([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/u,
  )?.[1];
}

function isExactContactIdentity(
  tab: InspectedSheetTab,
  values: unknown[],
  url?: string,
  explicitName?: string,
) {
  if (url) {
    const sourceColumn = tab.profile.columns.find(
      (column) => column.semanticKey === "source_contact",
    );
    const stored = sourceColumn
      ? String(values[sourceColumn.index] ?? "")
      : "";
    return normalizeContactIdentity(stored) === normalizeContactIdentity(url);
  }
  if (explicitName) {
    const nameColumns = tab.profile.columns.filter(
      (column) =>
        column.semanticKey === "name" ||
        column.semanticKey === "contact_name",
    );
    return nameColumns.some(
      (column) =>
        normalizeContactIdentity(String(values[column.index] ?? "")) ===
        normalizeContactIdentity(explicitName),
    );
  }
  return false;
}

function normalizeContactIdentity(value: string) {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/\/+$/u, "")
    .trim();
}

function contactTabScore(title: string) {
  if (/^интервью$/iu.test(title.trim())) return 100;
  if (/интервью/iu.test(title)) return 80;
  if (/пилот|клиент/iu.test(title)) return 40;
  return 0;
}

export function createFallbackStrategicActionPlan({
  sourceText,
  actions,
  projectContext,
}: StrategicPlanInput): StrategicActionPlan {
  const project = projectContext?.activeProject;
  const factsFromContext: StrategicFact[] = [];

  if (project?.goal) {
    factsFromContext.push({
      key: "project_goal",
      value: project.goal,
      source: "project_context",
      evidence: `Цель активного проекта: ${project.goal}`,
    });
  }

  if (project?.stage) {
    factsFromContext.push({
      key: "project_stage",
      value: project.stage,
      source: "project_context",
      evidence: `Стадия активного проекта: ${project.stage}`,
    });
  }

  return {
    version: 1,
    userGoal: project?.goal ?? sourceText.trim(),
    projectId: project?.id ?? null,
    targetResources:
      project?.resources.map((resource) => ({
        type: resource.resourceType,
        externalId: resource.externalId,
        title: resource.title,
      })) ?? [],
    factsFromMessage: sourceText.trim()
      ? [
          {
            key: "user_request",
            value: sourceText.trim(),
            source: "message",
            evidence: sourceText.trim(),
          },
        ]
      : [],
    factsFromContext,
    assumptions: [],
    actions: actions.map((action) =>
      fallbackStrategicAction(action, sourceText),
    ),
    suggestions: [],
    summaryIntent: `Выполнить запрос пользователя: ${sourceText.trim()}`,
  };
}

export function validateStrategicActionPlan(value: unknown): string[] {
  if (!isObject(value)) {
    return ["strategicPlan must be an object"];
  }

  const errors: string[] = [];

  if (value.version !== 1) errors.push("strategicPlan.version must be 1");
  if (!isText(value.userGoal)) errors.push("strategicPlan.userGoal is required");
  if (value.projectId !== null && !isText(value.projectId)) {
    errors.push("strategicPlan.projectId is invalid");
  }
  if (!isText(value.summaryIntent)) {
    errors.push("strategicPlan.summaryIntent is required");
  }

  validateArray(value.targetResources, "targetResources", errors);
  validateArray(value.factsFromMessage, "factsFromMessage", errors);
  validateArray(value.factsFromContext, "factsFromContext", errors);
  validateArray(value.assumptions, "assumptions", errors);
  validateArray(value.actions, "actions", errors);
  validateArray(value.suggestions, "suggestions", errors);

  if (Array.isArray(value.actions)) {
    value.actions.forEach((action, index) => {
      if (!isObject(action)) {
        errors.push(`strategicPlan.actions[${index}] must be an object`);
        return;
      }
      if (
        !isText(action.id) ||
        !STRATEGIC_ACTION_KINDS.includes(action.kind as StrategicActionKind)
      ) {
        errors.push(`strategicPlan.actions[${index}] identity is invalid`);
      }
      if (
        action.kind === "execute_action" &&
        (!isText(action.linkedActionId) || !isText(action.actionType))
      ) {
        errors.push(`strategicPlan.actions[${index}] executable link is invalid`);
      }
      if (!EXECUTION_POLICIES.includes(action.executionPolicy as StrategicExecutionPolicy)) {
        errors.push(`strategicPlan.actions[${index}].executionPolicy is invalid`);
      }
      if (!isConfidence(action.confidence)) {
        errors.push(`strategicPlan.actions[${index}].confidence is invalid`);
      }
      if (!Array.isArray(action.evidence) || !action.evidence.every(isText)) {
        errors.push(`strategicPlan.actions[${index}].evidence is invalid`);
      }
    });
  }

  return errors;
}

function normalizeTargetResources(
  value: unknown,
  linkedResources: Array<{
    resourceType: "google_sheet" | "ticktick_project";
    externalId: string;
  }>,
) {
  if (!Array.isArray(value)) return [];
  const knownExternalIds = new Set(
    linkedResources.map((resource) => resource.externalId),
  );

  return value.flatMap((item): StrategicTargetResource[] => {
    if (!isObject(item) || !RESOURCE_TYPES.includes(item.type as StrategicTargetResource["type"])) {
      return [];
    }

    const externalId = nullableText(item.externalId);
    if (
      externalId &&
      knownExternalIds.size > 0 &&
      (item.type === "google_sheet" || item.type === "ticktick_project") &&
      !knownExternalIds.has(externalId)
    ) {
      return [];
    }

    const rowNumber =
      Number.isInteger(item.rowNumber) && (item.rowNumber as number) > 0
        ? (item.rowNumber as number)
        : undefined;

    return [
      compact({
        type: item.type as StrategicTargetResource["type"],
        externalId,
        title: nullableText(item.title),
        sheetName: nullableText(item.sheetName),
        entityId: nullableText(item.entityId),
        entityLabel: nullableText(item.entityLabel),
        rowNumber,
      }),
    ];
  });
}

function normalizeFacts(
  value: unknown,
  requiredSource?: StrategicFact["source"],
) {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): StrategicFact[] => {
    if (!isObject(item) || !isText(item.key) || !isFactValue(item.value)) {
      return [];
    }
    const source = requiredSource ?? item.source;
    if (!FACT_SOURCES.includes(source as StrategicFact["source"])) return [];
    if (!isText(item.evidence)) return [];

    return [
      {
        key: item.key.trim(),
        value: item.value,
        source: source as StrategicFact["source"],
        evidence: item.evidence.trim(),
      },
    ];
  });
}

function normalizeAssumptions(value: unknown): StrategicAssumption[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) =>
    isObject(item) &&
    isText(item.text) &&
    isText(item.evidence) &&
    isConfidence(item.confidence)
      ? [
          {
            text: item.text.trim(),
            evidence: item.evidence.trim(),
            confidence: item.confidence,
          },
        ]
      : [],
  );
}

function normalizeActions(
  value: unknown,
  actions: AssistantAction[],
  sourceText: string,
): StrategicAction[] {
  const candidates = Array.isArray(value) ? value : [];
  const executableActions = actions.map((action): StrategicAction => {
    const candidate = candidates.find(
      (item) =>
        isObject(item) &&
        item.kind === "execute_action" &&
        item.linkedActionId === action.id,
    );
    const fallback = fallbackStrategicAction(action, sourceText);

    if (!isObject(candidate)) return fallback;
    const requiredPolicy = requiredPolicyForAction(action);
    const proposedPolicy = EXECUTION_POLICIES.includes(
      candidate.executionPolicy as StrategicExecutionPolicy,
    )
      ? (candidate.executionPolicy as StrategicExecutionPolicy)
      : fallback.executionPolicy;

    return {
      id: textOr(candidate.id, fallback.id),
      kind: "execute_action" as const,
      linkedActionId: action.id,
      actionType: action.type,
      reason: textOr(candidate.reason, fallback.reason),
      evidence: stringArray(candidate.evidence, fallback.evidence),
      confidence: isConfidence(candidate.confidence)
        ? candidate.confidence
        : fallback.confidence,
      executionPolicy:
        requiredPolicy === "confirm_first"
          ? "confirm_first"
          : proposedPolicy === "confirm_first"
            ? "confirm_first"
            : "auto_execute",
      expectedChange: textOr(
        candidate.expectedChange,
        fallback.expectedChange,
      ),
      verification: textOr(candidate.verification, fallback.verification),
    };
  });

  const operationalActions = candidates
    .slice(0, 10)
    .flatMap((candidate, index): StrategicAction[] => {
      if (!isObject(candidate)) return [];
      const kind = candidate.kind as StrategicActionKind;
      if (
        kind !== "recalculate_metrics" &&
        kind !== "audit_log" &&
        kind !== "verify_result"
      ) {
        return [];
      }
      if (
        !isText(candidate.reason) ||
        !isText(candidate.expectedChange) ||
        !isText(candidate.verification)
      ) {
        return [];
      }
      const evidence = stringArray(candidate.evidence, []);
      if (!evidence.length || !isConfidence(candidate.confidence)) return [];

      return [
        {
          id: isText(candidate.id)
            ? candidate.id.trim()
            : `strategic-${index + 1}`,
          kind,
          reason: candidate.reason.trim(),
          evidence,
          confidence: candidate.confidence,
          executionPolicy: "auto_execute",
          expectedChange: candidate.expectedChange.trim(),
          verification: candidate.verification.trim(),
        },
      ];
    });

  return [...executableActions, ...operationalActions];
}

function normalizeSuggestions(value: unknown): SuggestedAction[] {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 5).flatMap((item, index) => {
    if (!isObject(item) || !isText(item.title) || !isText(item.reason)) {
      return [];
    }

    const evidence = stringArray(item.evidence, []);
    if (!evidence.length || !isConfidence(item.confidence)) return [];

    return [
      {
        id: isText(item.id) ? item.id.trim() : `suggestion-${index + 1}`,
        title: item.title.trim(),
        reason: item.reason.trim(),
        evidence,
        confidence: item.confidence,
      },
    ];
  });
}

function normalizeClarification(value: unknown) {
  if (
    !isObject(value) ||
    !isText(value.question) ||
    !isText(value.missingField)
  ) {
    return undefined;
  }

  return {
    question: value.question.trim(),
    missingField: value.missingField.trim(),
  };
}

function fallbackStrategicAction(
  action: AssistantAction,
  sourceText: string,
): StrategicAction {
  return {
    id: `execute-${action.id}`,
    kind: "execute_action",
    linkedActionId: action.id,
    actionType: action.type,
    reason: "Действие прямо следует из запроса пользователя.",
    evidence: [sourceText.trim()].filter(Boolean),
    confidence: 0.8,
    executionPolicy: requiredPolicyForAction(action),
    expectedChange: `Выполнить ${action.type}.`,
    verification: "Проверить результат через соответствующий API adapter.",
  };
}

function requiredPolicyForAction(
  action: AssistantAction,
): StrategicExecutionPolicy {
  if (action.type === "create_sheet_tab") return "confirm_first";
  if (action.type !== "update_sheet") return "auto_execute";
  if (action.payload.operation === "clear_range") return "confirm_first";

  const rowCount = action.payload.values?.length ?? 0;
  const cellCount = action.payload.values?.flat().length ?? 0;
  return rowCount > 5 || cellCount > 50
    ? "confirm_first"
    : "auto_execute";
}

function extractOutreachIncrement(sourceText: string) {
  if (
    !/(?:рассыл|отправ)/iu.test(sourceText) ||
    !/(?:сделал|сделала|отправил|отправила|провёл|провела|внёс|внесла|зафиксир)/iu.test(
      sourceText,
    )
  ) {
    return null;
  }

  const match = sourceText.match(/\b(\d+(?:[.,]\d+)?)\b/u);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractExplicitOutreachTotal(sourceText: string) {
  if (!/(?:рассыл|отправ)/iu.test(sourceText)) return null;
  const match = sourceText.match(
    /(?:всего|итого|общ(?:ий|ая)\s+факт|фактически)\s*[:=—-]?\s*(\d+(?:[.,]\d+)?)/iu,
  );
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function invalidSheetTarget(
  outcome: Extract<AssistantPlanOutcome, { kind: "ready" }>,
  workspace: GoogleSheetsWorkspaceContext,
) {
  const knownTabs = new Set(
    workspace.inspectedDocuments.flatMap((document) =>
      document.tabs.map((tab) => tab.title.toLocaleLowerCase("ru")),
    ),
  );

  return outcome.plan.actions.some((action) => {
    if (
      action.type !== "read_sheet" &&
      action.type !== "update_sheet"
    ) {
      return false;
    }
    const range = action.payload.range;
    if (!range) return false;
    const title = range
      .split("!", 1)[0]
      .trim()
      .replace(/^'(.*)'$/u, "$1")
      .replace(/''/g, "'")
      .toLocaleLowerCase("ru");
    return !knownTabs.has(title);
  });
}

function parseFiniteNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function ensureOperationalSteps(
  existing: StrategicAction[],
  currentValue: number,
  nextValue: number,
) {
  const operational = existing.filter(
    (action) => action.kind !== "execute_action",
  );
  const defaults: StrategicAction[] = [
    {
      id: "recalculate-related-metrics",
      kind: "recalculate_metrics",
      reason: "Изменение отправок влияет на зависимые конверсии.",
      evidence: [`actual_sends: ${currentValue} → ${nextValue}`],
      confidence: 1,
      executionPolicy: "auto_execute",
      expectedChange: "Пересчитать зависимые показатели обычным кодом.",
      verification: "Сверить формулы и расчётные значения после записи.",
    },
    {
      id: "audit-metric-update",
      kind: "audit_log",
      reason: "Изменение метрики должно быть трассируемым.",
      evidence: [`actual_sends: ${currentValue} → ${nextValue}`],
      confidence: 1,
      executionPolicy: "auto_execute",
      expectedChange: "Записать действие и результат в audit log.",
      verification: "Проверить audit entry по trace_id.",
    },
    {
      id: "verify-metric-update",
      kind: "verify_result",
      reason: "Запись нужно проверить после выполнения.",
      evidence: [`ожидаемое значение: ${nextValue}`],
      confidence: 1,
      executionPolicy: "auto_execute",
      expectedChange: "Подтвердить сохранённое значение.",
      verification: "Повторно прочитать изменённую ячейку.",
    },
  ];

  for (const item of defaults) {
    if (!operational.some((action) => action.kind === item.kind)) {
      operational.push(item);
    }
  }

  return operational;
}

function createFollowUpSuggestion(
  tab: InspectedSheetTab,
  values: unknown[],
): SuggestedAction | undefined {
  const column = tab.profile.columns.find(
    (candidate) => candidate.semanticKey === "follow_up_message",
  );
  if (!column) return undefined;
  const value = String(values[column.index] ?? "").trim();
  if (!value || !/(?:не\s+зафикс|через\s+\d)/iu.test(value)) {
    return undefined;
  }

  return {
    id: "suggest-follow-up",
    title: "Уточнить следующий follow-up",
    reason: "В строке сегмента follow-up ещё не зафиксирован или задан правилом.",
    evidence: [value],
    confidence: 0.9,
  };
}

function upsertFact(facts: StrategicFact[], fact: StrategicFact) {
  return [...facts.filter((item) => item.key !== fact.key), fact];
}

function upsertSuggestion(
  suggestions: SuggestedAction[],
  suggestion: SuggestedAction,
) {
  return [
    ...suggestions.filter((item) => item.id !== suggestion.id),
    suggestion,
  ];
}

function isAggregateRow(rowKey: string) {
  return /(?:^|\|)\s*итого(?:\s*\||$)/iu.test(rowKey);
}

function shortRowKey(rowKey: string) {
  return rowKey.split("|")[0].trim().slice(0, 100);
}

function validateArray(value: unknown, field: string, errors: string[]) {
  if (!Array.isArray(value)) errors.push(`strategicPlan.${field} must be an array`);
}

function stringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const result = value.filter(isText).map((item) => item.trim());
  return result.length ? result : fallback;
}

function textOr(value: unknown, fallback: string) {
  return isText(value) ? value.trim() : fallback;
}

function nullableText(value: unknown) {
  return isText(value) ? value.trim() : undefined;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFactValue(value: unknown): value is string | number | boolean {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
