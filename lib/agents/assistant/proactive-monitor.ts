import { createHash } from "node:crypto";
import type {
  GoogleSheetsWorkspaceContext,
  InspectedSheetTab,
} from "@/lib/integrations/google-sheets/document-context";
import type {
  SheetColumnProfile,
  SheetRowEntity,
  SheetScalar,
} from "@/lib/integrations/google-sheets/types";
import type { AssistantProjectContext } from "./project-context";
import { parseTaskSourceMarker } from "./ticktick-coordination";
import type {
  ActionPlan,
  AssistantConversationMessage,
  ProactiveFinding,
  ProactiveFindingKind,
} from "./types";

export type TickTickMonitoringTask = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  content?: string;
  dueDate?: string;
};

export type TickTickMonitoringContext = {
  available: boolean;
  tasks: TickTickMonitoringTask[];
};

export function attachProactiveMonitoring(
  plan: ActionPlan,
  {
    workspace,
    tickTick,
    projectContext,
    conversation = [],
    now = new Date(),
  }: {
    workspace?: GoogleSheetsWorkspaceContext;
    tickTick: TickTickMonitoringContext;
    projectContext?: AssistantProjectContext;
    conversation?: AssistantConversationMessage[];
    now?: Date;
  },
): ActionPlan {
  if (!workspace) return plan;
  const today = dateInTimezone(now, projectContext?.timezone);
  const staleDays = resolveStaleDays(projectContext);
  const findings: ProactiveFinding[] = [];

  for (const document of workspace.inspectedDocuments) {
    for (const tab of document.tabs) {
      if (tab.profile.entityType !== "outreach_segment") continue;

      for (const entity of tab.entities) {
        if (isAggregateOrTerminal(entity, tab)) continue;
        const entityTasks = findEntityTasks(
          tickTick.tasks,
          document.spreadsheetId,
          entity,
        );
        const input: RowMonitoringInput = {
          plan,
          spreadsheetId: document.spreadsheetId,
          spreadsheetTitle: document.title,
          sheetName: tab.title,
          tab,
          entity,
          entityTasks,
          tickTickAvailable: tickTick.available,
          today,
          staleDays,
        };

        findings.push(
          ...detectInconsistentData(input),
          ...detectMissedFollowUp(input),
          ...detectPlanFactDeviation(input),
          ...detectStaleSegment(input),
          ...detectMissingNextAction(input),
        );
      }
    }
  }

  const recentAssistantText = normalize(
    conversation
      .filter((message) => message.role === "assistant")
      .slice(-6)
      .map((message) => message.text)
      .join("\n"),
  );
  const uniqueFindings = uniqueById(findings)
    .filter(
      (finding) => !recentAssistantText.includes(normalize(finding.title)),
    )
    .sort(compareFindings)
    .slice(0, 8);

  return {
    ...plan,
    monitoringReport: {
      version: 1,
      checkedAt: now.toISOString(),
      scope: "relevant_context",
      findings: uniqueFindings,
    },
  };
}

type RowMonitoringInput = {
  plan: ActionPlan;
  spreadsheetId: string;
  spreadsheetTitle: string;
  sheetName: string;
  tab: InspectedSheetTab;
  entity: SheetRowEntity;
  entityTasks: TickTickMonitoringTask[];
  tickTickAvailable: boolean;
  today: Date;
  staleDays: number;
};

function detectInconsistentData(input: RowMonitoringInput) {
  const sends = metric(input, "actual_sends");
  const replies = metric(input, "replies");
  const interviews = metric(input, "interviews");
  const pilots = metric(input, "pilot_discussions");
  const pairs: Array<[string, number | null, string, number | null]> = [
    ["ответов", replies, "отправок", sends],
    ["интервью", interviews, "ответов", replies],
    ["обсуждений пилота", pilots, "интервью", interviews],
  ];

  return pairs.flatMap(([childName, child, parentName, parent]) =>
    child !== null && parent !== null && child > parent
      ? [
          finding(input, {
            kind: "inconsistent_data",
            severity: "high",
            title: `В строке «${label(input.entity)}» ${childName} (${formatNumber(child)}) больше, чем ${parentName} (${formatNumber(parent)}).`,
            recommendation: "Проверить первичные значения и исправить источник расхождения.",
            evidence: [
              `${childName}: ${formatNumber(child)}`,
              `${parentName}: ${formatNumber(parent)}`,
            ],
          }),
        ]
      : [],
  );
}

function detectMissedFollowUp(input: RowMonitoringInput) {
  const overdueTask = input.entityTasks.find((task) => {
    const due = parseDate(task.dueDate);
    return due && due < input.today;
  });
  const followUpValue = text(input, ["follow_up_at", "due_date", "follow_up_message"]);
  const updatedAt = date(input, "updated_at");
  const explicitDate = parseDate(followUpValue);
  const relativeDays = parseRelativeDays(followUpValue);
  const derivedDate =
    relativeDays !== null && updatedAt
      ? addDays(updatedAt, relativeDays)
      : undefined;
  const dueDate = explicitDate ?? derivedDate;

  if (!overdueTask && (!dueDate || dueDate >= input.today)) return [];
  const evidence = overdueTask
    ? [`Задача «${overdueTask.title}» просрочена с ${formatDate(parseDate(overdueTask.dueDate)!)}.`]
    : [`Follow-up был запланирован на ${formatDate(dueDate!)}.`];

  return [
    finding(input, {
      kind: "missed_follow_up",
      severity: "high",
      title: `По строке «${label(input.entity)}» пропущен follow-up.`,
      recommendation: overdueTask
        ? "Проверить задачу TickTick и определить новый срок контакта."
        : "Определить новый срок follow-up; задачу создавать только после явной команды.",
      evidence,
    }),
  ];
}

function detectPlanFactDeviation(input: RowMonitoringInput) {
  const plan = metric(input, "planned_sends");
  const actual = metric(input, "actual_sends");
  if (plan === null || actual === null || plan <= 0 || actual / plan >= 0.7) {
    return [];
  }
  const updatedAt = date(input, "updated_at");
  const dueDate = date(input, "due_date");
  const stale = updatedAt
    ? daysBetween(updatedAt, input.today) >= input.staleDays
    : false;
  if (!stale && (!dueDate || dueDate > input.today)) return [];
  const completion = Math.round((actual / plan) * 100);

  return [
    finding(input, {
      kind: "plan_fact_deviation",
      severity: "medium",
      title: `По строке «${label(input.entity)}» выполнено ${completion}% плана отправок (${formatNumber(actual)} из ${formatNumber(plan)}).`,
      recommendation: "Проверить актуальность плана и определить следующее конкретное действие.",
      evidence: [
        `План: ${formatNumber(plan)}`,
        `Факт: ${formatNumber(actual)}`,
      ],
    }),
  ];
}

function detectStaleSegment(input: RowMonitoringInput) {
  if (rowTouchedByPlan(input)) return [];
  const updatedAt = date(input, "updated_at");
  if (!updatedAt) return [];
  const age = daysBetween(updatedAt, input.today);
  if (age < input.staleDays) return [];

  return [
    finding(input, {
      kind: "stale_segment",
      severity: "medium",
      title: `Строка «${label(input.entity)}» не обновлялась ${age} дней.`,
      recommendation: "Проверить текущий статус сегмента и зафиксировать следующее действие.",
      evidence: [`Последнее обновление: ${formatDate(updatedAt)}.`],
    }),
  ];
}

function detectMissingNextAction(input: RowMonitoringInput) {
  if (!input.tickTickAvailable || input.entityTasks.length) return [];
  const activity = [
    metric(input, "actual_sends"),
    metric(input, "replies"),
    metric(input, "interviews"),
  ].some((value) => value !== null && value > 0);
  if (!activity) return [];
  const nextAction = text(input, ["next_action", "follow_up_at", "due_date"]);
  const operationalText = text(input, ["follow_up_message", "status_comment"]);
  const explicitlyMissing = /(?:не\s+(?:зафикс|назнач|заплан)|нет\s+(?:след|срок|дат))/iu.test(
    operationalText,
  );
  const hasScheduledText =
    !explicitlyMissing &&
    /(?:через\s+\d|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?|до\s+\d{1,2}|(?:напис|позвон|созвон|пушн).{0,30}(?:через|\d{1,2}[./-]\d{1,2}))/iu.test(
      operationalText,
    );
  if (nextAction || hasScheduledText) return [];

  return [
    finding(input, {
      kind: "missing_next_action",
      severity: "low",
      title: `Для строки «${label(input.entity)}» не найдено следующего действия.`,
      recommendation: "Определить один конкретный следующий шаг; задачу TickTick создавать только по явной команде.",
      evidence: ["В таблице нет срока или следующего действия.", "Связанной открытой задачи TickTick не найдено."],
    }),
  ];
}

function metric(input: RowMonitoringInput, semanticKey: string) {
  return number(projectedCell(input, semanticKey));
}

function date(input: RowMonitoringInput, semanticKey: string) {
  return parseDate(projectedCell(input, semanticKey));
}

function text(input: RowMonitoringInput, semanticKeys: string[]) {
  for (const key of semanticKeys) {
    const value = projectedCell(input, key);
    if (value !== null && value !== undefined && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function projectedCell(input: RowMonitoringInput, semanticKey: string) {
  const profileColumn = column(input.tab, semanticKey);
  if (!profileColumn) return undefined;
  const planned = plannedCellValue(input, profileColumn);
  return planned === undefined
    ? input.entity.values[profileColumn.index]
    : planned;
}

function plannedCellValue(
  input: RowMonitoringInput,
  column: SheetColumnProfile,
): SheetScalar | undefined {
  for (const action of input.plan.actions) {
    if (
      action.type !== "update_sheet" ||
      action.payload.operation !== "update_cells" ||
      action.payload.values?.length !== 1 ||
      action.payload.values[0]?.length !== 1
    ) {
      continue;
    }
    const targetMatches =
      action.payload.target.kind === "id"
        ? action.payload.target.spreadsheetId === input.spreadsheetId
        : normalize(action.payload.target.title) ===
          normalize(input.spreadsheetTitle);
    const coordinate = parseCellRange(action.payload.range);
    if (
      targetMatches &&
      coordinate?.sheetName === input.sheetName &&
      coordinate.rowNumber === input.entity.rowNumber &&
      coordinate.columnLetter === column.columnLetter
    ) {
      return action.payload.values[0][0];
    }
  }
  return undefined;
}

function rowTouchedByPlan(input: RowMonitoringInput) {
  return input.plan.actions.some((action) => {
    if (action.type !== "update_sheet") return false;
    const targetMatches =
      action.payload.target.kind === "id"
        ? action.payload.target.spreadsheetId === input.spreadsheetId
        : normalize(action.payload.target.title) ===
          normalize(input.spreadsheetTitle);
    const coordinate = parseCellRange(action.payload.range);
    return (
      targetMatches &&
      coordinate?.sheetName === input.sheetName &&
      coordinate.rowNumber === input.entity.rowNumber
    );
  });
}

function findEntityTasks(
  tasks: TickTickMonitoringTask[],
  spreadsheetId: string,
  entity: SheetRowEntity,
) {
  const normalizedLabel = normalize(label(entity));
  return tasks.filter((task) => {
    const marker = parseTaskSourceMarker(task.content);
    if (
      marker?.spreadsheetId === spreadsheetId &&
      marker.entityId === entity.entityId
    ) {
      return true;
    }
    return normalizedLabel.length >= 4 && normalize(task.title).includes(normalizedLabel);
  });
}

function isAggregateOrTerminal(entity: SheetRowEntity, tab: InspectedSheetTab) {
  if (/(?:^|\|)\s*итого(?:\s*\||$)/iu.test(entity.rowKey)) return true;
  const statusColumn = column(tab, "status");
  const status = statusColumn
    ? String(entity.values[statusColumn.index] ?? "")
    : "";
  return /заверш|закрыт|готов|архив|неактив|отказ/iu.test(status);
}

function finding(
  input: RowMonitoringInput,
  value: Pick<
    ProactiveFinding,
    "kind" | "severity" | "title" | "recommendation" | "evidence"
  >,
): ProactiveFinding {
  return {
    id: findingId(value.kind, input.spreadsheetId, input.entity.entityId),
    ...value,
    spreadsheetId: input.spreadsheetId,
    sheetName: input.sheetName,
    rowNumber: input.entity.rowNumber,
    entityId: input.entity.entityId,
    entityLabel: label(input.entity),
  };
}

function resolveStaleDays(context: AssistantProjectContext | undefined) {
  const rule = context?.activeProject?.operatingRules.find((candidate) =>
    /stale|завис|без.*обнов/iu.test(`${candidate.key} ${candidate.text}`),
  );
  const days = rule?.text.match(/(\d{1,3})\s*(?:день|дня|дней|day|days)/iu);
  const value = days ? Number(days[1]) : 14;
  return value >= 1 && value <= 365 ? value : 14;
}

function column(tab: InspectedSheetTab, semanticKey: string) {
  return tab.profile.columns.find(
    (candidate) => candidate.semanticKey === semanticKey,
  );
}

function parseCellRange(range: string) {
  const match = range.match(/^'?([^'!]+)'?!([A-Z]{1,3})(\d+)$/iu);
  return match
    ? { sheetName: match[1].replace(/''/g, "'"), columnLetter: match[2].toUpperCase(), rowNumber: Number(match[3]) }
    : undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return utcDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value !== "string") return undefined;
  const iso = value.match(/(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?:\D|$)/u);
  const ru = value.match(/(?:^|\D)(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\D|$)/u);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (ru) return utcDate(Number(ru[3]), Number(ru[2]), Number(ru[1]));
  return undefined;
}

function parseRelativeDays(value: string) {
  const match = value.match(/через\s+(\d{1,3})\s+(?:день|дня|дней)/iu);
  if (!match) return null;
  const days = Number(match[1]);
  return days >= 1 && days <= 365 ? days : null;
}

function dateInTimezone(now: Date, timezone: string | undefined) {
  if (!timezone) return utcDate(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate())!;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
    );
    return utcDate(values.year, values.month, values.day)!;
  } catch {
    return utcDate(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate())!;
  }
}

function utcDate(year: number, month: number, day: number) {
  const result = new Date(Date.UTC(year, month - 1, day));
  return result.getUTCFullYear() === year && result.getUTCMonth() === month - 1 && result.getUTCDate() === day
    ? result
    : undefined;
}

function addDays(value: Date, days: number) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function daysBetween(left: Date, right: Date) {
  return Math.floor((right.getTime() - left.getTime()) / 86_400_000);
}

function number(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.replace(/\s/g, "").replace("%", "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function label(entity: SheetRowEntity) {
  return entity.rowKey.split("|")[0].trim().slice(0, 100);
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(".", ",");
}

function formatDate(value: Date) {
  return `${String(value.getUTCDate()).padStart(2, "0")}.${String(value.getUTCMonth() + 1).padStart(2, "0")}.${value.getUTCFullYear()}`;
}

function findingId(kind: ProactiveFindingKind, spreadsheetId: string, entityId: string) {
  return createHash("sha256").update(`${kind}:${spreadsheetId}:${entityId}`).digest("hex").slice(0, 20);
}

function uniqueById(findings: ProactiveFinding[]) {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}

function compareFindings(left: ProactiveFinding, right: ProactiveFinding) {
  const severity = { high: 3, medium: 2, low: 1 };
  return severity[right.severity] - severity[left.severity] || left.rowNumber - right.rowNumber;
}

function normalize(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("ru").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
