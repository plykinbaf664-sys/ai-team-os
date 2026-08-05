import type { AssistantProjectContext } from "../agents/assistant/project-context";
import { attachProactiveMonitoring } from "../agents/assistant/proactive-monitor";
import type {
  ActionPlan,
  ActionResult,
  AssistantAction,
  ProactiveFinding,
} from "../agents/assistant/types";
import {
  createGoogleCalendarAdapterFromEnv,
} from "../integrations/google-calendar/google-calendar-adapter";
import type {
  GoogleCalendarAdapter,
  GoogleCalendarEvent,
} from "../integrations/google-calendar/types";
import {
  inspectGoogleSheetsWorkspace,
} from "../integrations/google-sheets/document-context";
import { createGoogleSheetsAdapterFromEnv } from "../integrations/google-sheets/google-sheets-adapter";
import type { GoogleSheetsAdapter } from "../integrations/google-sheets/types";
import { createTickTickAdapterFromEnv } from "../integrations/ticktick/ticktick-adapter";
import type {
  TickTickAdapter,
  TickTickTask,
} from "../integrations/ticktick/types";

type DailySummaryAction = Extract<
  AssistantAction,
  { type: "generate_daily_summary" }
>;

type SummaryTask = TickTickTask & { projectName: string };

export async function executeDailySummaryAction(
  action: AssistantAction,
  plan: ActionPlan,
  projectContext?: AssistantProjectContext,
  {
    tickTickAdapter,
    calendarAdapter,
    sheetsAdapter,
    calendarId = process.env.GOOGLE_CALENDAR_ID || "primary",
    defaultTimezone = process.env.USER_TIMEZONE,
    now = new Date(),
  }: {
    tickTickAdapter?: TickTickAdapter | null;
    calendarAdapter?: GoogleCalendarAdapter | null;
    sheetsAdapter?: GoogleSheetsAdapter | null;
    calendarId?: string;
    defaultTimezone?: string;
    now?: Date;
  } = {},
): Promise<ActionResult | null> {
  if (action.type !== "generate_daily_summary") return null;
  const timezone = action.payload.timezone || projectContext?.timezone || defaultTimezone;
  if (!timezone || !isTimezone(timezone)) {
    return result(
      action,
      "needs_clarification",
      "Какой часовой пояс использовать для ежедневной сводки?",
      "daily_summary_timezone_required",
    );
  }
  const date = action.payload.date || dateInTimezone(now, timezone);
  if (!isIsoDate(date)) {
    return result(
      action,
      "needs_clarification",
      "На какую дату подготовить сводку?",
      "daily_summary_date_invalid",
    );
  }

  const tickTick =
    tickTickAdapter === undefined
      ? createTickTickAdapterFromEnv()
      : tickTickAdapter;
  const calendar =
    calendarAdapter === undefined
      ? createGoogleCalendarAdapterFromEnv()
      : calendarAdapter;
  const sheets =
    sheetsAdapter === undefined
      ? createGoogleSheetsAdapterFromEnv()
      : sheetsAdapter;
  const [tasksState, eventsState, sheetsState] = await Promise.allSettled([
    tickTick ? loadTasks(tickTick) : Promise.resolve<SummaryTask[] | null>(null),
    calendar
      ? loadEvents(calendar, calendarId, date, timezone)
      : Promise.resolve<GoogleCalendarEvent[] | null>(null),
    sheets
      ? loadSheets(sheets, plan, projectContext)
      : Promise.resolve<Awaited<ReturnType<typeof loadSheets>> | null>(null),
  ]);
  const tasks = fulfilled(tasksState);
  const events = fulfilled(eventsState);
  const workspace = fulfilled(sheetsState);
  const warnings = [
    tasksState.status === "rejected" ? "TickTick временно недоступен." : null,
    eventsState.status === "rejected" ? "Google Calendar временно недоступен." : null,
    sheetsState.status === "rejected" ? "Google Sheets временно недоступен." : null,
  ].filter((value): value is string => Boolean(value));

  if (tasks === null && events === null && workspace === null && !projectContext?.activeProject) {
    return result(
      action,
      "failed",
      "Не удалось получить данные для сводки: рабочие источники не настроены или временно недоступны.",
      "daily_summary_sources_unavailable",
    );
  }

  const openTasks = (tasks ?? []).filter((task) => task.status === 0);
  const monitoringPlan = workspace
    ? attachProactiveMonitoring(plan, {
        workspace,
        tickTick: {
          available: tasks !== null,
          tasks: openTasks.map((task) => ({
            id: task.id,
            projectId: task.projectId,
            projectName: task.projectName,
            title: task.title,
            ...(task.content ? { content: task.content } : {}),
            ...(task.dueDate ? { dueDate: task.dueDate } : {}),
          })),
        },
        projectContext,
        now,
      })
    : plan;
  const text = composeDailySummary({
    date,
    timezone,
    tasks: openTasks,
    events: events ?? [],
    findings: monitoringPlan.monitoringReport?.findings ?? [],
    projectContext,
    unavailable: [
      ...(tasks === null ? ["TickTick"] : []),
      ...(events === null ? ["Google Calendar"] : []),
      ...(workspace === null ? ["Google Sheets"] : []),
    ],
    warnings,
    now,
  });

  return result(action, "succeeded", text);
}

async function loadTasks(adapter: TickTickAdapter) {
  const projects = (await adapter.listProjects()).filter(
    (project) => !project.closed,
  );
  const data = await Promise.all(
    projects.map((project) => adapter.getProjectData(project.id)),
  );
  return data.flatMap((item) =>
    item.tasks.map((task) => ({
      ...task,
      projectName: item.project.name,
    })),
  );
}

async function loadEvents(
  adapter: GoogleCalendarAdapter,
  calendarId: string,
  date: string,
  timezone: string,
) {
  const nextDate = addDays(date, 1);
  return adapter.listEvents({
    calendarId,
    timeMin: localBoundary(date, timezone),
    timeMax: localBoundary(nextDate, timezone),
    maxResults: 50,
  });
}

async function loadSheets(
  adapter: GoogleSheetsAdapter,
  plan: ActionPlan,
  projectContext?: AssistantProjectContext,
) {
  const resourceTitles = projectContext?.activeProject?.resources
    .filter((resource) => resource.resourceType === "google_sheet")
    .map((resource) => resource.title) ?? [];
  return inspectGoogleSheetsWorkspace({
    adapter,
    sourceText: [
      plan.sourceText,
      "приоритеты просрочено план факт требует внимания",
      ...resourceTitles,
    ].join("\n"),
  });
}

function composeDailySummary({
  date,
  timezone,
  tasks,
  events,
  findings,
  projectContext,
  unavailable,
  warnings,
  now,
}: {
  date: string;
  timezone: string;
  tasks: SummaryTask[];
  events: GoogleCalendarEvent[];
  findings: ProactiveFinding[];
  projectContext?: AssistantProjectContext;
  unavailable: string[];
  warnings: string[];
  now: Date;
}) {
  const overdue = tasks
    .filter((task) => {
      const due = dueDateKey(task, timezone);
      return Boolean(due && due < date);
    })
    .sort(compareTasks)
    .slice(0, 7);
  const priorities = tasks
    .filter((task) => {
      const due = dueDateKey(task, timezone);
      if (due && due < date) return false;
      return task.priority >= 3 || due === date;
    })
    .sort(compareTasks)
    .slice(0, 7);
  const stale = tasks
    .filter((task) => {
      if (!task.modifiedTime || overdue.some((item) => item.id === task.id)) return false;
      const modified = new Date(task.modifiedTime);
      return Number.isFinite(modified.getTime()) &&
        now.getTime() - modified.getTime() >= 7 * 86_400_000;
    })
    .sort((left, right) =>
      String(left.modifiedTime).localeCompare(String(right.modifiedTime)),
    )
    .slice(0, 5);
  const activeEvents = events
    .filter((event) => event.status !== "cancelled")
    .sort((left, right) => eventStart(left).localeCompare(eventStart(right)))
    .slice(0, 12);
  const critical = findings.filter((finding) => finding.severity === "high");
  const deviations = findings.filter(
    (finding) => finding.kind === "plan_fact_deviation" || finding.severity === "medium",
  );
  const recentChanges = (projectContext?.activeProject?.recentActions ?? [])
    .filter((item) => item.status === "succeeded")
    .slice(0, 5)
    .map(formatRecentAction);
  const sections = [
    `Сводка на ${formatRussianDate(date)}`,
    projectContext?.activeProject
      ? `Проект: ${projectContext.activeProject.name}${projectContext.activeProject.stage ? ` — ${projectContext.activeProject.stage}` : ""}.`
      : null,
    section(
      "Главные приоритеты",
      priorities.length
        ? priorities.map((task) => formatTask(task, timezone))
        : ["Срочных или высокоприоритетных задач не найдено."],
    ),
    section(
      "Просрочено",
      overdue.length
        ? overdue.map((task) => formatTask(task, timezone))
        : ["Просроченных задач не найдено."],
    ),
    stale.length
      ? section(
          "Зависшие задачи",
          stale.map((task) =>
            `${task.title} — без изменений с ${formatDateTime(task.modifiedTime!, timezone)}.`,
          ),
        )
      : null,
    section(
      "Календарь",
      activeEvents.length
        ? activeEvents.map((event) => formatEvent(event, timezone))
        : ["Событий на этот день не найдено."],
    ),
    deviations.length
      ? section(
          "План-факт и процессы",
          deviations.slice(0, 6).map((finding) => finding.title),
        )
      : null,
    recentChanges.length
      ? section("Последние изменения", recentChanges)
      : null,
    critical.length
      ? section(
          "Критические вопросы",
          critical.slice(0, 6).map((finding) => finding.title),
        )
      : null,
    findings.length
      ? section(
          "Следующие действия",
          findings.slice(0, 6).map((finding) => finding.recommendation),
        )
      : null,
    unavailable.length || warnings.length
      ? section(
          "Доступность данных",
          unique([
            ...(unavailable.length
              ? [`Нет данных из: ${unavailable.join(", ")}.`]
              : []),
            ...warnings,
          ]),
        )
      : null,
  ];

  return sections.filter((value): value is string => Boolean(value)).join("\n\n");
}

function formatTask(task: SummaryTask, timezone: string) {
  const due = dueDateKey(task, timezone);
  const deadline = due ? `, срок ${formatRussianDate(due)}` : "";
  const priority = task.priority >= 5
    ? "срочно"
    : task.priority >= 3
      ? "высокий приоритет"
      : "";
  return `${task.title} — ${task.projectName}${deadline}${priority ? `, ${priority}` : ""}.`;
}

function formatEvent(event: GoogleCalendarEvent, timezone: string) {
  const allDay = event.start.date;
  if (allDay) return `${event.title} — весь день.`;
  const start = event.start.dateTime
    ? formatTime(event.start.dateTime, timezone)
    : "время не указано";
  const end = event.end.dateTime
    ? formatTime(event.end.dateTime, timezone)
    : undefined;
  return `${event.title} — ${start}${end ? `–${end}` : ""}.`;
}

function formatRecentAction(action: {
  actionType: string;
  createdAt?: string;
}) {
  const label: Record<string, string> = {
    update_sheet: "Обновлены данные Google Sheets",
    create_task: "Создана задача TickTick",
    update_task: "Обновлена задача TickTick",
    complete_task: "Завершена задача TickTick",
    create_calendar_event: "Создано событие календаря",
    update_calendar_event: "Обновлено событие календаря",
  };
  return `${label[action.actionType] ?? `Выполнено действие ${action.actionType}`}${action.createdAt ? ` — ${action.createdAt.slice(0, 10)}` : ""}.`;
}

function result(
  action: DailySummaryAction,
  status: ActionResult["status"],
  message: string,
  errorCode?: string,
): ActionResult {
  return {
    actionId: action.id,
    actionType: action.type,
    status,
    message,
    ...(errorCode ? { errorCode } : {}),
  };
}

function fulfilled<T>(state: PromiseSettledResult<T>): T | null {
  return state.status === "fulfilled" ? state.value : null;
}

function compareTasks(left: SummaryTask, right: SummaryTask) {
  return (
    right.priority - left.priority ||
    String(left.dueDate ?? "9999").localeCompare(String(right.dueDate ?? "9999")) ||
    left.title.localeCompare(right.title, "ru")
  );
}

function dueDateKey(task: TickTickTask, timezone: string) {
  if (!task.dueDate) return "";
  const direct = task.dueDate.match(/^(\d{4}-\d{2}-\d{2})/u)?.[1];
  if (task.isAllDay && direct) return direct;
  const date = new Date(task.dueDate);
  return Number.isFinite(date.getTime()) ? dateInTimezone(date, timezone) : direct ?? "";
}

function eventStart(event: GoogleCalendarEvent) {
  return event.start.dateTime || event.start.date || "";
}

function dateInTimezone(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localBoundary(date: string, timezone: string) {
  return `${date}T00:00:00${timezoneOffset(date, timezone)}`;
}

function timezoneOffset(date: string, timezone: string) {
  const sample = new Date(`${date}T12:00:00Z`);
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(sample)
    .find((part) => part.type === "timeZoneName")?.value;
  if (!label || label === "GMT") return "+00:00";
  return label.replace("GMT", "");
}

function addDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function formatRussianDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatDateTime(value: string, timezone: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: timezone,
      }).format(date)
    : value;
}

function formatTime(value: string, timezone: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: timezone,
      }).format(date)
    : value.slice(11, 16);
}

function section(title: string, lines: string[]) {
  return [title, ...unique(lines).map((line) => `- ${ensurePeriod(line)}`)].join("\n");
}

function ensurePeriod(value: string) {
  const trimmed = value.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function isIsoDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

function isTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
