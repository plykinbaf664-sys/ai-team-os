import { createHash } from "node:crypto";
import type {
  ActionResult,
  AssistantAction,
} from "../agents/assistant/types";
import {
  createGoogleCalendarAdapterFromEnv,
} from "../integrations/google-calendar/google-calendar-adapter";
import type {
  GoogleCalendarAdapter,
  GoogleCalendarEvent,
  GoogleCalendarWriteEventInput,
} from "../integrations/google-calendar/types";

type CalendarAction = Extract<
  AssistantAction,
  { type: "create_calendar_event" | "update_calendar_event" }
>;

export async function executeGoogleCalendarAction(
  action: AssistantAction,
  adapterOverride?: GoogleCalendarAdapter | null,
  {
    calendarId = process.env.GOOGLE_CALENDAR_ID || "primary",
    defaultTimezone = process.env.USER_TIMEZONE,
    now = new Date(),
  }: {
    calendarId?: string;
    defaultTimezone?: string;
    now?: Date;
  } = {},
): Promise<ActionResult | null> {
  if (!isCalendarAction(action)) return null;
  const adapter =
    adapterOverride === undefined
      ? createGoogleCalendarAdapterFromEnv()
      : adapterOverride;

  if (!adapter) {
    return failure(
      action,
      "Google Calendar не настроен. Нужны GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET и GOOGLE_REFRESH_TOKEN со scope calendar.events.",
      "google_calendar_not_configured",
    );
  }
  if (!calendarId.trim()) {
    return clarification(action, "Не указан календарь для события.", "calendar_id");
  }

  try {
    return action.type === "create_calendar_event"
      ? await createEvent(adapter, action, calendarId, defaultTimezone)
      : await updateEvent(adapter, action, calendarId, defaultTimezone, now);
  } catch (error) {
    return failure(
      action,
      error instanceof Error ? error.message : "Неизвестная ошибка Google Calendar.",
      "google_calendar_request_failed",
    );
  }
}

async function createEvent(
  adapter: GoogleCalendarAdapter,
  action: Extract<CalendarAction, { type: "create_calendar_event" }>,
  calendarId: string,
  defaultTimezone: string | undefined,
) {
  const timezone = action.payload.timezone || defaultTimezone;
  const problem = validateTiming({
    date: action.payload.date,
    startTime: action.payload.startTime,
    endTime: action.payload.endTime,
    timezone,
  });
  if (problem) return clarification(action, problem.message, problem.field);

  const input = writeInput({
    calendarId,
    title: action.payload.title,
    date: action.payload.date,
    startTime: action.payload.startTime,
    endTime: action.payload.endTime!,
    timezone: timezone!,
  });
  const marker = eventMarker(input);
  input.extendedProperties = {
    private: { ai_team_os_key: marker },
  };
  const duplicate = await findDuplicate(adapter, input, marker);

  if (duplicate) {
    return success(
      action,
      `Событие уже существует: «${duplicate.title}», ${formatTiming(duplicate)}. Дубль не создан.`,
    );
  }

  const created = await adapter.createEvent(input);
  const verified = await adapter.getEvent(calendarId, created.id);
  if (!sameEvent(verified, input)) {
    return failure(
      action,
      "Событие создано, но повторная проверка не подтвердила дату и время.",
      "google_calendar_verification_failed",
    );
  }

  return success(
    action,
    `Создал событие «${verified.title}»: ${formatTiming(verified)}. Результат проверен в Google Calendar.`,
  );
}

async function updateEvent(
  adapter: GoogleCalendarAdapter,
  action: Extract<CalendarAction, { type: "update_calendar_event" }>,
  calendarId: string,
  defaultTimezone: string | undefined,
  now: Date,
) {
  const located = await locateEvent(adapter, action, calendarId, now);
  if (located.kind !== "found") {
    return clarification(action, located.message, "calendar_event");
  }
  const existing = located.event;
  if (!existing.start.dateTime || !existing.end.dateTime) {
    return clarification(
      action,
      "Найдено событие на весь день. Для его изменения нужны конкретные дата и время.",
      "calendar_event_time",
    );
  }
  const existingDate = existing.start.dateTime.slice(0, 10);
  const existingStart = existing.start.dateTime.slice(11, 16);
  const existingEnd = existing.end.dateTime.slice(11, 16);
  const date = action.payload.changes.date || existingDate;
  const startTime = action.payload.changes.startTime || existingStart;
  const timezone =
    action.payload.changes.timezone ||
    existing.start.timeZone ||
    defaultTimezone;
  const endTime =
    action.payload.changes.endTime ||
    preserveDuration(existingStart, existingEnd, startTime);
  const problem = validateTiming({ date, startTime, endTime, timezone });
  if (problem) return clarification(action, problem.message, problem.field);

  const input: GoogleCalendarWriteEventInput & { eventId: string } = {
    ...writeInput({
      calendarId,
      title: action.payload.changes.title || existing.title,
      date,
      startTime,
      endTime,
      timezone: timezone!,
      description: existing.description,
    }),
    eventId: existing.id,
    ...(existing.extendedProperties
      ? { extendedProperties: existing.extendedProperties }
      : {}),
  };
  const updated = await adapter.updateEvent(input);
  const verified = await adapter.getEvent(calendarId, updated.id);
  if (!sameEvent(verified, input)) {
    return failure(
      action,
      "Google Calendar принял изменение, но повторная проверка не подтвердила результат.",
      "google_calendar_verification_failed",
    );
  }

  return success(
    action,
    `Обновил событие «${verified.title}»: ${formatTiming(verified)}. Результат проверен в Google Calendar.`,
  );
}

async function locateEvent(
  adapter: GoogleCalendarAdapter,
  action: Extract<CalendarAction, { type: "update_calendar_event" }>,
  calendarId: string,
  now: Date,
): Promise<
  | { kind: "found"; event: GoogleCalendarEvent }
  | { kind: "missing" | "ambiguous"; message: string }
> {
  if (action.payload.eventId) {
    return {
      kind: "found",
      event: await adapter.getEvent(calendarId, action.payload.eventId),
    };
  }
  const title = action.payload.eventTitle?.trim();
  if (!title) return { kind: "missing", message: "Какое событие нужно изменить?" };
  const timeMin = new Date(now);
  timeMin.setUTCDate(timeMin.getUTCDate() - 30);
  const timeMax = new Date(now);
  timeMax.setUTCFullYear(timeMax.getUTCFullYear() + 1);
  const matches = (await adapter.listEvents({
    calendarId,
    query: title,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    maxResults: 20,
  })).filter((event) => normalize(event.title) === normalize(title));

  if (!matches.length) {
    return { kind: "missing", message: `Событие «${title}» не найдено.` };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      message: `Нашёл несколько событий «${title}». Укажи дату нужного события.`,
    };
  }
  return { kind: "found", event: matches[0] };
}

async function findDuplicate(
  adapter: GoogleCalendarAdapter,
  input: GoogleCalendarWriteEventInput,
  marker: string,
) {
  const marked = await adapter.listEvents({
    calendarId: input.calendarId,
    privateExtendedProperty: `ai_team_os_key=${marker}`,
    maxResults: 2,
  });
  if (marked[0]) return marked[0];
  const date = input.start.dateTime!.slice(0, 10);
  const min = new Date(`${date}T00:00:00.000Z`);
  min.setUTCDate(min.getUTCDate() - 1);
  const max = new Date(`${date}T23:59:59.999Z`);
  max.setUTCDate(max.getUTCDate() + 1);
  const candidates = await adapter.listEvents({
    calendarId: input.calendarId,
    query: input.title,
    timeMin: min.toISOString(),
    timeMax: max.toISOString(),
    maxResults: 20,
  });
  return candidates.find((event) => sameEvent(event, input));
}

function validateTiming({
  date,
  startTime,
  endTime,
  timezone,
}: {
  date: string;
  startTime: string;
  endTime?: string;
  timezone?: string;
}) {
  if (!validDate(date)) return { message: "Укажи дату события в формате ГГГГ-ММ-ДД.", field: "calendar.date" };
  if (!validTime(startTime)) return { message: "Укажи точное время начала события.", field: "calendar.start_time" };
  if (!endTime) return { message: "Во сколько событие закончится?", field: "calendar.end_time" };
  if (!validTime(endTime) || endTime <= startTime) {
    return { message: "Время окончания должно быть позже времени начала.", field: "calendar.end_time" };
  }
  if (!timezone || !validTimezone(timezone)) {
    return { message: "Не удалось определить часовой пояс пользователя.", field: "calendar.timezone" };
  }
  return null;
}

function writeInput({
  calendarId,
  title,
  date,
  startTime,
  endTime,
  timezone,
  description,
}: {
  calendarId: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  timezone: string;
  description?: string;
}): GoogleCalendarWriteEventInput {
  return {
    calendarId,
    title: title.trim(),
    ...(description ? { description } : {}),
    start: { dateTime: `${date}T${startTime}:00`, timeZone: timezone },
    end: { dateTime: `${date}T${endTime}:00`, timeZone: timezone },
  };
}

function eventMarker(input: GoogleCalendarWriteEventInput) {
  return createHash("sha256")
    .update([
      input.calendarId,
      normalize(input.title),
      input.start.dateTime,
      input.end.dateTime,
      input.start.timeZone,
    ].join("|"))
    .digest("hex")
    .slice(0, 32);
}

function sameEvent(event: GoogleCalendarEvent, input: GoogleCalendarWriteEventInput) {
  return (
    normalize(event.title) === normalize(input.title) &&
    localDateTime(event.start.dateTime) === localDateTime(input.start.dateTime) &&
    localDateTime(event.end.dateTime) === localDateTime(input.end.dateTime)
  );
}

function preserveDuration(existingStart: string, existingEnd: string, nextStart: string) {
  const duration = minutes(existingEnd) - minutes(existingStart);
  const nextEnd = minutes(nextStart) + duration;
  if (duration <= 0 || nextEnd >= 24 * 60) return existingEnd;
  return `${String(Math.floor(nextEnd / 60)).padStart(2, "0")}:${String(nextEnd % 60).padStart(2, "0")}`;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTime(value: string) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function minutes(value: string) {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function localDateTime(value: string | undefined) {
  return value?.slice(0, 16);
}

function formatTiming(event: GoogleCalendarEvent) {
  const start = event.start.dateTime;
  const end = event.end.dateTime;
  if (!start || !end) return "событие на весь день";
  return `${start.slice(8, 10)}.${start.slice(5, 7)}.${start.slice(0, 4)}, ${start.slice(11, 16)}–${end.slice(11, 16)}`;
}

function isCalendarAction(action: AssistantAction): action is CalendarAction {
  return action.type === "create_calendar_event" || action.type === "update_calendar_event";
}

function normalize(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("ru").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function success(action: CalendarAction, message: string): ActionResult {
  return { actionId: action.id, actionType: action.type, status: "succeeded", message };
}

function clarification(
  action: CalendarAction,
  message: string,
  errorCode: string,
): ActionResult {
  return { actionId: action.id, actionType: action.type, status: "needs_clarification", message, errorCode };
}

function failure(
  action: CalendarAction,
  message: string,
  errorCode: string,
): ActionResult {
  return { actionId: action.id, actionType: action.type, status: "failed", message, errorCode };
}
