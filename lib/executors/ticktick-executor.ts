import type {
  ActionResult,
  AssistantAction,
  TaskPriority,
} from "../agents/assistant/types";
import {
  createTickTickAdapterFromEnv,
} from "../integrations/ticktick/ticktick-adapter";
import type {
  TickTickAdapter,
  TickTickPriority,
  TickTickProject,
  TickTickTask,
} from "../integrations/ticktick/types";
import {
  buildTaskSourceContent,
  buildTaskSourceMarker,
} from "../agents/assistant/ticktick-coordination";

type TickTickAction = Extract<
  AssistantAction,
  {
    type:
      | "create_task"
      | "update_task"
      | "complete_task"
      | "list_tasks";
  }
>;

type ResolvedProject =
  | { kind: "resolved"; projectId: string; projectName: string }
  | { kind: "missing"; message: string }
  | { kind: "ambiguous"; message: string };

type LocatedTask = {
  task: TickTickTask;
  project: TickTickProject;
};

export async function executeTickTickAction(
  action: AssistantAction,
  adapterOverride?: TickTickAdapter | null,
  {
    defaultProjectId = process.env.TICKTICK_DEFAULT_PROJECT_ID,
    timezone = process.env.USER_TIMEZONE,
    now = new Date(),
  }: {
    defaultProjectId?: string;
    timezone?: string;
    now?: Date;
  } = {},
): Promise<ActionResult | null> {
  if (!isTickTickAction(action)) {
    return null;
  }

  const adapter =
    adapterOverride === undefined
      ? createTickTickAdapterFromEnv()
      : adapterOverride;

  if (!adapter) {
    return failure(
      action,
      "TickTick не настроен. Добавьте TICKTICK_ACCESS_TOKEN.",
      "ticktick_not_configured",
    );
  }

  try {
    if (action.type === "list_tasks") {
      return executeListTasks(adapter, action);
    }

    if (action.type === "create_task") {
      return executeCreateTask(
        adapter,
        action,
        defaultProjectId,
        timezone,
        now,
      );
    }

    if (action.type === "update_task") {
      return executeUpdateTask(adapter, action, timezone, now);
    }

    return executeCompleteTask(adapter, action);
  } catch (error) {
    return failure(
      action,
      error instanceof Error ? error.message : "Неизвестная ошибка TickTick.",
      "ticktick_request_failed",
    );
  }
}

async function executeListTasks(
  adapter: TickTickAdapter,
  action: Extract<TickTickAction, { type: "list_tasks" }>,
): Promise<ActionResult> {
  const projects = (await adapter.listProjects()).filter(
    (project) => !project.closed,
  );
  let selectedProjects = projects;

  if (action.payload.project?.trim()) {
    const resolved = resolveProject(projects, action.payload.project);

    if (resolved.kind !== "resolved") {
      return clarification(action, resolved.message, "ticktick_project");
    }

    selectedProjects = projects.filter(
      (project) => project.id === resolved.projectId,
    );
  }

  const projectData = await Promise.all(
    selectedProjects.map(async (project) => ({
      project,
      data: await adapter.getProjectData(project.id),
    })),
  );
  const limit = Math.min(Math.max(action.payload.limit ?? 20, 1), 50);
  const tasks = projectData
    .flatMap(({ project, data }) =>
      data.tasks
        .filter((task) => task.status === 0)
        .map((task) => ({ project, task })),
    )
    .sort(compareTasks)
    .slice(0, limit);

  if (!tasks.length) {
    return success(
      action,
      action.payload.project
        ? `В проекте «${action.payload.project}» открытых задач нет.`
        : "Открытых задач в TickTick не найдено.",
    );
  }

  const lines = [
    "Открытые задачи TickTick",
    "",
    ...tasks.map(
      ({ project, task }) =>
        `• ${task.title}\n  Проект: ${project.name}${formatTaskDetails(task)}`,
    ),
  ];

  if (tasks.length === limit) {
    lines.push("", `Показаны первые ${limit} задач.`);
  }

  return success(action, lines.join("\n"));
}

function compareTasks(left: LocatedTask, right: LocatedTask) {
  const leftDueDate = left.task.dueDate || "9999-12-31";
  const rightDueDate = right.task.dueDate || "9999-12-31";

  return (
    leftDueDate.localeCompare(rightDueDate) ||
    right.task.priority - left.task.priority ||
    left.task.title.localeCompare(right.task.title, "ru")
  );
}

function formatTaskDetails(task: TickTickTask) {
  const details: string[] = [];
  const priority = formatPriority(task.priority);

  if (priority) {
    details.push(`приоритет: ${priority}`);
  }

  if (task.dueDate) {
    details.push(`срок: ${formatTickTickDate(task.dueDate)}`);
  }

  return details.length ? ` · ${details.join(" · ")}` : "";
}

function formatPriority(priority: number) {
  if (priority === 5) {
    return "высокий";
  }

  if (priority === 3) {
    return "средний";
  }

  if (priority === 1) {
    return "низкий";
  }

  return "";
}

function formatTickTickDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);

  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

async function executeCreateTask(
  adapter: TickTickAdapter,
  action: Extract<TickTickAction, { type: "create_task" }>,
  defaultProjectId: string | undefined,
  timezone: string | undefined,
  now: Date,
): Promise<ActionResult> {
  if (looksLikeMassProcessTask(action.payload.title)) {
    return clarification(
      action,
      "Массовое процессовое действие не создаётся как отдельная задача. Укажите конкретный результат.",
      "task_concrete_result_required",
    );
  }

  const projects = await adapter.listProjects();
  const project = resolveProject(
    projects,
    action.payload.project,
    defaultProjectId,
  );

  if (project.kind !== "resolved") {
    return clarification(action, project.message, "ticktick_project_required");
  }

  const projectData = await adapter.getProjectData(project.projectId);
  const sourceMarker = action.payload.sourceEntity
    ? buildTaskSourceMarker(
        action.payload.sourceEntity,
        action.payload.title,
      )
    : undefined;
  const duplicate = projectData.tasks.find(
    (task) =>
      task.status === 0 &&
      (normalizeTitle(task.title) === normalizeTitle(action.payload.title) ||
        (sourceMarker && task.content?.includes(sourceMarker))),
  );

  if (duplicate) {
    return success(
      action,
      `Задача уже существует в списке «${project.projectName}»: ${duplicate.title}. Дубль не создан.`,
    );
  }

  const dueDate = resolveTaskDueDate(
    action.payload.dueDateText,
    timezone,
    now,
  );

  if (dueDate.kind === "invalid") {
    return clarification(action, dueDate.message, "task.dueDate");
  }

  const created = await adapter.createTask({
    projectId: project.projectId,
    title: action.payload.title.trim(),
    ...(action.payload.sourceEntity
      ? {
          content: buildTaskSourceContent(
            action.payload.sourceEntity,
            action.payload.title,
          ),
        }
      : {}),
    priority: mapPriority(action.payload.priority),
    ...(dueDate.kind === "resolved"
      ? {
          dueDate: dueDate.dueDate,
          timeZone: dueDate.timeZone,
          isAllDay: true,
        }
      : {}),
  });

  return success(
    action,
    [
      `Задача создана в TickTick, список «${project.projectName}»: ${created.title}.`,
      action.payload.sourceEntity
        ? "Связал её с исходной строкой Google Sheets."
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

async function executeUpdateTask(
  adapter: TickTickAdapter,
  action: Extract<TickTickAction, { type: "update_task" }>,
  timezone: string | undefined,
  now: Date,
): Promise<ActionResult> {
  const projects = await adapter.listProjects();
  const matches = await locateTasks(
    adapter,
    projects,
    action.payload.taskId,
    action.payload.taskTitle,
  );

  if (!matches.length) {
    return clarification(
      action,
      "Задача для обновления не найдена. Укажите точное название или ID.",
      "task.selector",
    );
  }

  if (matches.length > 1) {
    return clarification(
      action,
      "Найдено несколько задач с таким названием. Укажите ID задачи.",
      "task.id",
    );
  }

  const located = matches[0];
  const destination = action.payload.changes.project
    ? resolveProject(projects, action.payload.changes.project)
    : {
        kind: "resolved" as const,
        projectId: located.project.id,
        projectName: located.project.name,
      };

  if (destination.kind !== "resolved") {
    return clarification(
      action,
      destination.message,
      "task.changes.project",
    );
  }

  const dueDate = resolveTaskDueDate(
    action.payload.changes.dueDateText,
    timezone,
    now,
  );

  if (dueDate.kind === "invalid") {
    return clarification(action, dueDate.message, "task.changes.dueDate");
  }

  if (destination.projectId !== located.project.id) {
    await adapter.moveTask({
      taskId: located.task.id,
      fromProjectId: located.project.id,
      toProjectId: destination.projectId,
    });
  }

  const updated = await adapter.updateTask({
    id: located.task.id,
    projectId: destination.projectId,
    title: action.payload.changes.title?.trim() || located.task.title,
    priority:
      action.payload.changes.priority === undefined
        ? normalizeTickTickPriority(located.task.priority)
        : mapPriority(action.payload.changes.priority),
    dueDate:
      dueDate.kind === "resolved"
        ? dueDate.dueDate
        : located.task.dueDate,
    timeZone:
      dueDate.kind === "resolved"
        ? dueDate.timeZone
        : located.task.timeZone,
    isAllDay:
      dueDate.kind === "resolved"
        ? true
        : located.task.isAllDay,
  });

  return success(
    action,
    `Задача обновлена в TickTick, список «${destination.projectName}»: ${updated.title}.`,
  );
}

async function executeCompleteTask(
  adapter: TickTickAdapter,
  action: Extract<TickTickAction, { type: "complete_task" }>,
): Promise<ActionResult> {
  const projects = await adapter.listProjects();
  const matches = await locateTasks(
    adapter,
    projects,
    action.payload.taskId,
    action.payload.taskTitle,
  );

  if (!matches.length) {
    return clarification(
      action,
      "Открытая задача не найдена. Укажите точное название или ID.",
      "task.selector",
    );
  }

  if (matches.length > 1) {
    return clarification(
      action,
      "Найдено несколько открытых задач с таким названием. Укажите ID.",
      "task.id",
    );
  }

  const located = matches[0];
  await adapter.completeTask(located.project.id, located.task.id);

  return success(
    action,
    `Задача завершена в TickTick: ${located.task.title}.`,
  );
}

async function locateTasks(
  adapter: TickTickAdapter,
  projects: TickTickProject[],
  taskId?: string,
  taskTitle?: string,
) {
  const writableProjects = projects.filter(
    (project) =>
      !project.closed &&
      project.permission !== "read" &&
      project.permission !== "comment",
  );
  const projectData = await Promise.all(
    writableProjects.map(async (project) => ({
      project,
      data: await adapter.getProjectData(project.id),
    })),
  );
  const normalizedTitle = taskTitle
    ? normalizeTitle(taskTitle)
    : null;

  return projectData.flatMap(({ project, data }) =>
    data.tasks
      .filter(
        (task) =>
          task.status === 0 &&
          (taskId
            ? task.id === taskId
            : normalizedTitle !== null &&
              normalizeTitle(task.title) === normalizedTitle),
      )
      .map((task) => ({ task, project }) satisfies LocatedTask),
  );
}

function resolveProject(
  projects: TickTickProject[],
  selector?: string,
  defaultProjectId?: string,
): ResolvedProject {
  const projectSelector = selector?.trim() || defaultProjectId?.trim();

  if (!projectSelector) {
    return {
      kind: "missing",
      message: [
        "Не могу уверенно определить проект TickTick.",
        formatProjectChoices(projects),
        "В какой проект добавить задачу?",
      ].join(" "),
    };
  }

  const normalizedSelector = normalizeProjectName(projectSelector);
  const matches = projects.filter(
    (project) =>
      !project.closed &&
      (project.id === projectSelector ||
        normalizeProjectName(project.name) === normalizedSelector),
  );

  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      message: "Найдено несколько списков с таким названием. Укажите ID.",
    };
  }

  if (matches.length === 1) {
    return {
      kind: "resolved",
      projectId: matches[0].id,
      projectName: matches[0].name,
    };
  }

  if (/^[a-f0-9]{24}$/i.test(projectSelector)) {
    return {
      kind: "resolved",
      projectId: projectSelector,
      projectName: projectSelector,
    };
  }

  return {
    kind: "missing",
    message: [
      `Проект TickTick «${projectSelector}» не найден.`,
      formatProjectChoices(projects),
      "Какой проект выбрать?",
    ].join(" "),
  };
}

function normalizeProjectName(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function formatProjectChoices(projects: TickTickProject[]) {
  const names = projects
    .filter(
      (project) =>
        !project.closed &&
        project.permission !== "read" &&
        project.permission !== "comment",
    )
    .map((project) => `«${project.name}»`);

  return names.length
    ? `Доступные проекты: ${names.join(", ")}.`
    : "Доступных проектов нет.";
}

export function resolveTaskDueDate(
  dueDateText: string | undefined,
  timezone: string | undefined,
  now: Date,
):
  | { kind: "none" }
  | {
      kind: "resolved";
      dueDate: string;
      timeZone: string;
    }
  | { kind: "invalid"; message: string } {
  if (!dueDateText?.trim()) {
    return { kind: "none" };
  }

  if (!timezone) {
    return {
      kind: "invalid",
      message: "Для дедлайна настройте USER_TIMEZONE.",
    };
  }

  const localDate = getLocalDate(now, timezone);

  if (!localDate) {
    return {
      kind: "invalid",
      message: `Некорректный часовой пояс: ${timezone}.`,
    };
  }

  const normalized = dueDateText.trim().toLowerCase();
  const isoDate = normalized.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const ruDate = normalized.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  let date: Date | null = null;

  if (isoDate) {
    date = createUtcDate(
      Number(isoDate[1]),
      Number(isoDate[2]),
      Number(isoDate[3]),
    );
  } else if (ruDate) {
    date = createUtcDate(
      Number(ruDate[3]),
      Number(ruDate[2]),
      Number(ruDate[1]),
    );
  } else if (/\bпослезавтра\b/u.test(normalized)) {
    date = addDays(localDate, 2);
  } else if (/\bзавтра\b/u.test(normalized)) {
    date = addDays(localDate, 1);
  } else if (/\bсегодня\b/u.test(normalized)) {
    date = localDate;
  } else {
    const relativeDays = normalized.match(
      /через\s+(\d{1,3})\s+(?:день|дня|дней)/u,
    );
    const days = relativeDays ? Number(relativeDays[1]) : null;
    const weekday = extractWeekday(normalized);

    if (days !== null && days >= 1 && days <= 365) {
      date = addDays(localDate, days);
    } else if (weekday !== null) {
      date = addDays(localDate, (weekday - localDate.getUTCDay() + 7) % 7);
    }
  }

  if (!date) {
    return {
      kind: "invalid",
      message:
        "Укажите дедлайн как сегодня, завтра, день недели, YYYY-MM-DD или DD.MM.YYYY.",
    };
  }

  return {
    kind: "resolved",
    dueDate: `${formatDate(date)}T00:00:00+0000`,
    timeZone: timezone,
  };
}

function getLocalDate(now: Date, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );

    return createUtcDate(values.year, values.month, values.day);
  } catch {
    return null;
  }
}

function createUtcDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatDate(date: Date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function extractWeekday(value: string) {
  const weekdays: Array<[string, number]> = [
    ["воскресен", 0],
    ["понедель", 1],
    ["вторник", 2],
    ["сред", 3],
    ["четверг", 4],
    ["пятниц", 5],
    ["суббот", 6],
  ];

  return weekdays.find(([root]) => value.includes(root))?.[1] ?? null;
}

function mapPriority(priority: TaskPriority | undefined) {
  if (priority === undefined) {
    return undefined;
  }

  const priorities: Record<TaskPriority, TickTickPriority> = {
    low: 1,
    normal: 3,
    high: 5,
    urgent: 5,
  };

  return priorities[priority];
}

function normalizeTickTickPriority(priority: number): TickTickPriority {
  return priority === 1 || priority === 3 || priority === 5
    ? priority
    : 0;
}

function normalizeTitle(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function looksLikeMassProcessTask(title: string) {
  return (
    /(?:написать|отправить|обработать|ответить)\s+\d{2,}\s+(?:люд|человек|контакт|сообщен)/iu.test(
      title,
    ) ||
    /(?:обработать|написать|ответить).*(?:всю|всей)\s+баз/iu.test(title) ||
    /ежедневно.*(?:отвечать|обрабатывать|писать)/iu.test(title)
  );
}

function isTickTickAction(action: AssistantAction): action is TickTickAction {
  return (
    action.type === "create_task" ||
    action.type === "update_task" ||
    action.type === "complete_task" ||
    action.type === "list_tasks"
  );
}

function success(action: TickTickAction, message: string): ActionResult {
  return {
    actionId: action.id,
    actionType: action.type,
    status: "succeeded",
    message,
  };
}

function clarification(
  action: TickTickAction,
  message: string,
  errorCode: string,
): ActionResult {
  return {
    actionId: action.id,
    actionType: action.type,
    status: "needs_clarification",
    message,
    errorCode,
  };
}

function failure(
  action: TickTickAction,
  message: string,
  errorCode: string,
): ActionResult {
  return {
    actionId: action.id,
    actionType: action.type,
    status: "failed",
    message,
    errorCode,
  };
}
