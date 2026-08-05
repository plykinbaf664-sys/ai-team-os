import type {
  AssistantAction,
  AssistantConversationMessage,
  AssistantPlanOutcome,
} from "./types";

export function reconcileConversationDependentActions(
  outcome: AssistantPlanOutcome,
  {
    sourceText,
    conversation,
    timezone,
    now = new Date(),
  }: {
    sourceText: string;
    conversation: AssistantConversationMessage[];
    timezone?: string;
    now?: Date;
  },
): AssistantPlanOutcome {
  const recent = conversation.slice(-12);
  const recentCalendarQuestion = recent.some(
    (message) =>
      message.role === "assistant" &&
      /во сколько событие закончится|на какую дату.*(?:встреч|созвон)|когда.*(?:встреч|созвон)|дата.*событ|время.*событ/iu.test(
        message.text,
      ),
  );
  const workingOutcome =
    outcome.kind === "ready"
      ? outcome
      : outcome.kind === "clarification" && recentCalendarQuestion
        ? {
            kind: "ready" as const,
            plan: {
              version: 1 as const,
              mode: "quick_command" as const,
              sourceText,
              actions: [],
            },
          }
        : null;
  if (!workingOutcome) return outcome;
  const calendarAction = workingOutcome.plan.actions.find(
    (action): action is Extract<AssistantAction, { type: "create_calendar_event" }> =>
      action.type === "create_calendar_event",
  );
  const calendarThread = [
    sourceText,
    ...recent.map((message) => message.text),
  ].some((text) => /календар|событ|встреч|созвон/iu.test(text));

  if (!calendarAction && !(calendarThread && recentCalendarQuestion)) {
    return outcome;
  }

  const evidenceTexts = [
    sourceText,
    ...recent
      .filter((message) => message.role === "user")
      .reverse()
      .map((message) => message.text),
  ];
  const date = calendarAction?.payload.date || firstResolvedDate(evidenceTexts, now, timezone);
  const times = firstResolvedTimes(evidenceTexts);
  const startTime = calendarAction?.payload.startTime || times.startTime;
  const endTime = calendarAction?.payload.endTime || times.endTime;
  const title = calendarAction?.payload.title || resolveCalendarTitle(
    workingOutcome.plan.actions,
    evidenceTexts,
  );
  const resolvedTimezone = calendarAction?.payload.timezone || timezone;

  if (!title) {
    return calendarClarification(
      workingOutcome,
      calendarAction,
      "Как назвать событие?",
      "calendar.title",
    );
  }
  if (!date) {
    return calendarClarification(
      workingOutcome,
      calendarAction,
      "На какую дату поставить событие?",
      "calendar.date",
    );
  }
  if (!startTime) {
    return calendarClarification(
      workingOutcome,
      calendarAction,
      "Во сколько событие начнётся?",
      "calendar.start_time",
    );
  }
  if (!endTime) {
    return calendarClarification(
      workingOutcome,
      calendarAction,
      "Во сколько событие закончится?",
      "calendar.end_time",
    );
  }
  if (!resolvedTimezone) {
    return calendarClarification(
      workingOutcome,
      calendarAction,
      "Какой часовой пояс использовать для события?",
      "calendar.timezone",
    );
  }

  const repaired: Extract<AssistantAction, { type: "create_calendar_event" }> = {
    id: calendarAction?.id || nextActionId(workingOutcome.plan.actions),
    type: "create_calendar_event",
    payload: {
      title,
      date,
      startTime,
      endTime,
      timezone: resolvedTimezone,
    },
  };
  const actions = workingOutcome.plan.actions
    .filter((action) => action !== calendarAction)
    .filter(
      (action) =>
        !(
          recentCalendarQuestion &&
          action.type === "update_task" &&
          !/tick\s*tick|тик\s*тик|задач/iu.test(sourceText)
        ),
    );
  actions.push(repaired);

  return {
    kind: "ready",
    plan: {
      ...workingOutcome.plan,
      actions,
      strategicPlan: undefined,
    },
  };
}

export function resolveDateFromText(
  text: string,
  now = new Date(),
  timezone?: string,
) {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/u);
  if (iso && validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const numeric = text.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/u);
  const today = datePartsInTimezone(now, timezone);
  if (numeric) {
    const year = numeric[3]
      ? normalizeYear(Number(numeric[3]))
      : today.year;
    return formatDateIfValid(year, Number(numeric[2]), Number(numeric[1]));
  }
  const months: Record<string, number> = {
    января: 1,
    февраля: 2,
    марта: 3,
    апреля: 4,
    мая: 5,
    июня: 6,
    июля: 7,
    августа: 8,
    сентября: 9,
    октября: 10,
    ноября: 11,
    декабря: 12,
  };
  const named = text.match(
    /\b(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?(?=\s|[,.!?;]|$)/iu,
  );
  if (named) {
    return formatDateIfValid(
      named[3] ? Number(named[3]) : today.year,
      months[named[2].toLocaleLowerCase("ru")],
      Number(named[1]),
    );
  }
  if (/завтр/iu.test(text)) {
    return addCalendarDays(today, 1);
  }
  const weekday = text.match(
    /(?:следующ\w*\s+)?(понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье)/iu,
  );
  if (weekday) {
    const target = weekdayNumber(weekday[1]);
    const current = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    let delta = (target - current + 7) % 7;
    if (delta === 0 || /следующ/iu.test(weekday[0])) delta ||= 7;
    return addCalendarDays(today, delta);
  }
  return undefined;
}

export function resolveTimeRangeFromText(text: string) {
  const normalized = normalizeSpokenTimes(text);
  const range = normalized.match(
    /(?:с\s*)?([01]?\d|2[0-3])(?::([0-5]\d))?\s*(?:до|[-–—])\s*([01]?\d|2[0-3])(?::([0-5]\d))?/iu,
  );
  if (range) {
    return {
      startTime: clock(range[1], range[2]),
      endTime: clock(range[3], range[4]),
    };
  }
  const single = normalized.match(
    /(?:в|на)\s*([01]?\d|2[0-3])(?::([0-5]\d))?/iu,
  );
  if (!single) return {};
  const time = clock(single[1], single[2]);
  return /законч|до\s+этого/iu.test(text)
    ? { endTime: time }
    : { startTime: time };
}

function firstResolvedDate(texts: string[], now: Date, timezone?: string) {
  for (const text of texts) {
    const date = resolveDateFromText(text, now, timezone);
    if (date) return date;
  }
  return undefined;
}

function firstResolvedTimes(texts: string[]) {
  let startTime: string | undefined;
  let endTime: string | undefined;
  for (const text of texts) {
    const times = resolveTimeRangeFromText(text);
    startTime ||= times.startTime;
    endTime ||= times.endTime;
    if (startTime && endTime) break;
  }
  return { startTime, endTime };
}

function resolveCalendarTitle(actions: AssistantAction[], texts: string[]) {
  const task = actions.find(
    (action): action is Extract<AssistantAction, { type: "create_task" }> =>
      action.type === "create_task",
  );
  if (task?.payload.title.trim()) return task.payload.title.trim();
  for (const text of texts) {
    const match = text.match(
      /((?:созвониться|созвон|встреча|эфир)\s+(?:с\s+)?[^.,\n]+?)(?=\s+(?:в\s+следующ|завтра|\d{1,2}[.:]|с\s+\d)|[.,\n]|$)/iu,
    );
    if (match?.[1]) return capitalize(match[1].trim());
  }
  return /созвон/iu.test(texts.join("\n")) ? "Созвон" : undefined;
}

function normalizeSpokenTimes(text: string) {
  const hours: Record<string, string> = {
    четырнадцать: "14",
    пятнадцать: "15",
    шестнадцать: "16",
    семнадцать: "17",
    восемнадцать: "18",
    девятнадцать: "19",
    двадцать: "20",
  };
  let result = text.toLocaleLowerCase("ru");
  for (const [word, value] of Object.entries(hours)) {
    result = result.replace(new RegExp(`\\b${word}\\s+ноль\\s+ноль\\b`, "giu"), `${value}:00`);
  }
  return result;
}

function datePartsInTimezone(now: Date, timezone?: string) {
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
    return { year: values.year, month: values.month, day: values.day };
  } catch {
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  }
}

function addCalendarDays(value: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function formatDateIfValid(year: number, month: number, day: number) {
  return validDate(year, month, day) ? formatDate(year, month, day) : undefined;
}

function validDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeYear(year: number) {
  return year < 100 ? 2000 + year : year;
}

function weekdayNumber(value: string) {
  const normalized = value.toLocaleLowerCase("ru");
  if (normalized.startsWith("пон")) return 1;
  if (normalized.startsWith("вто")) return 2;
  if (normalized.startsWith("сре")) return 3;
  if (normalized.startsWith("чет")) return 4;
  if (normalized.startsWith("пят")) return 5;
  if (normalized.startsWith("суб")) return 6;
  return 0;
}

function clock(hour: string, minute?: string) {
  return `${hour.padStart(2, "0")}:${minute || "00"}`;
}

function nextActionId(actions: AssistantAction[]) {
  let index = actions.length + 1;
  while (actions.some((action) => action.id === `action-${index}`)) index += 1;
  return `action-${index}`;
}

function capitalize(value: string) {
  return value ? `${value[0].toLocaleUpperCase("ru")}${value.slice(1)}` : value;
}

function clarification(question: string, missingField: string): AssistantPlanOutcome {
  return { kind: "clarification", question, missingField };
}

function calendarClarification(
  outcome: Extract<AssistantPlanOutcome, { kind: "ready" }>,
  calendarAction: Extract<AssistantAction, { type: "create_calendar_event" }> | undefined,
  question: string,
  missingField: string,
): AssistantPlanOutcome {
  const remainingActions = outcome.plan.actions.filter(
    (action) => action !== calendarAction,
  );
  if (!remainingActions.length) return clarification(question, missingField);

  const existingStrategic = outcome.plan.strategicPlan;
  return {
    kind: "ready",
    plan: {
      ...outcome.plan,
      actions: remainingActions,
      strategicPlan: existingStrategic
        ? {
            ...existingStrategic,
            actions: existingStrategic.actions.filter(
              (action) => action.linkedActionId !== calendarAction?.id,
            ),
            clarification: { question, missingField },
          }
        : {
            version: 1,
            userGoal: outcome.plan.sourceText,
            projectId: null,
            targetResources: [],
            factsFromMessage: [
              {
                key: "user_request",
                value: outcome.plan.sourceText,
                source: "message",
                evidence: outcome.plan.sourceText,
              },
            ],
            factsFromContext: [],
            assumptions: [],
            actions: remainingActions.map((action) => ({
              id: `execute-${action.id}`,
              kind: "execute_action" as const,
              linkedActionId: action.id,
              actionType: action.type,
              reason: "Действие прямо следует из запроса пользователя.",
              evidence: [outcome.plan.sourceText],
              confidence: 0.8,
              executionPolicy: "auto_execute" as const,
              expectedChange: `Выполнить ${action.type}.`,
              verification: "Проверить результат через соответствующий API adapter.",
            })),
            suggestions: [],
            clarification: { question, missingField },
            summaryIntent: "Выполнить однозначную часть запроса и уточнить календарь.",
          },
    },
  };
}
