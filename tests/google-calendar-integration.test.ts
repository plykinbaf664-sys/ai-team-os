import assert from "node:assert/strict";
import test from "node:test";
import { validateActionPlan } from "../lib/agents/assistant/assistant-core";
import type { AssistantAction } from "../lib/agents/assistant/types";
import { executeGoogleCalendarAction } from "../lib/executors/google-calendar-executor";
import { createGoogleCalendarAdapter } from "../lib/integrations/google-calendar/google-calendar-adapter";
import type {
  GoogleCalendarAdapter,
  GoogleCalendarEvent,
  GoogleCalendarWriteEventInput,
} from "../lib/integrations/google-calendar/types";

test("uses the documented Calendar v3 endpoints and bearer token", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = createGoogleCalendarAdapter({
    getAccessToken: async () => "token-1",
    fetchImplementation: (async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/calendars/primary")) {
        return Response.json({ id: "primary", summary: "Основной", timeZone: "Europe/Moscow" });
      }
      if (init?.method === "POST") return Response.json(wireEvent("event-1"));
      if (init?.method === "PATCH") return Response.json(wireEvent("event-1", "20:00", "21:00"));
      if (url.includes("/events/event-1")) return Response.json(wireEvent("event-1"));
      return Response.json({ items: [wireEvent("event-1")] });
    }) as typeof fetch,
  });

  await adapter.getCalendar("primary");
  await adapter.listEvents({ calendarId: "primary", privateExtendedProperty: "ai_team_os_key=abc" });
  await adapter.getEvent("primary", "event-1");
  await adapter.createEvent(writeInput());
  await adapter.updateEvent({ ...writeInput(), eventId: "event-1" });

  assert.equal(requests.length, 5);
  assert.ok(requests.every((request) => new Headers(request.init?.headers).get("Authorization") === "Bearer token-1"));
  assert.match(requests[1].url, /privateExtendedProperty=ai_team_os_key%3Dabc/u);
  assert.equal(requests[3].init?.method, "POST");
  assert.equal(requests[4].init?.method, "PATCH");
});

test("asks for end time instead of inventing a duration", async () => {
  let calls = 0;
  const result = await executeGoogleCalendarAction(
    createAction({ endTime: undefined }),
    fakeAdapter({ onCall: () => { calls += 1; } }),
    { defaultTimezone: "Europe/Moscow" },
  );

  assert.equal(result?.status, "needs_clarification");
  assert.match(result?.message ?? "", /закончится/u);
  assert.equal(calls, 0);
});

test("creates one exact event, marks it and verifies the result", async () => {
  let createdInput: GoogleCalendarWriteEventInput | undefined;
  const adapter = fakeAdapter({
    createEvent: async (input) => {
      createdInput = input;
      return eventFromInput("event-1", input);
    },
    getEvent: async () => eventFromInput("event-1", createdInput!),
  });
  const result = await executeGoogleCalendarAction(
    createAction(),
    adapter,
    { defaultTimezone: "Europe/Moscow" },
  );

  assert.equal(result?.status, "succeeded");
  assert.equal(createdInput?.start.dateTime, "2026-08-13T19:00:00");
  assert.equal(createdInput?.end.dateTime, "2026-08-13T20:00:00");
  assert.equal(createdInput?.start.timeZone, "Europe/Moscow");
  assert.match(createdInput?.extendedProperties?.private?.ai_team_os_key ?? "", /^[a-f0-9]{32}$/u);
  assert.match(result?.message ?? "", /Результат проверен/u);
});

test("does not create a semantic duplicate", async () => {
  let createCalls = 0;
  const input = writeInput();
  const result = await executeGoogleCalendarAction(
    createAction(),
    fakeAdapter({
      listEvents: async () => [eventFromInput("existing", input)],
      createEvent: async () => {
        createCalls += 1;
        return eventFromInput("new", input);
      },
    }),
    { defaultTimezone: "Europe/Moscow" },
  );

  assert.equal(result?.status, "succeeded");
  assert.match(result?.message ?? "", /Дубль не создан/u);
  assert.equal(createCalls, 0);
});

test("requires a valid configured timezone", async () => {
  const result = await executeGoogleCalendarAction(
    createAction({ timezone: undefined }),
    fakeAdapter(),
    { defaultTimezone: undefined },
  );

  assert.equal(result?.status, "needs_clarification");
  assert.match(result?.message ?? "", /часовой пояс/u);
});

test("keeps an update ambiguous when equal titles exist", async () => {
  const result = await executeGoogleCalendarAction(
    {
      id: "update",
      type: "update_calendar_event",
      payload: { eventTitle: "Эфир с Мариной", changes: { startTime: "20:00" } },
    },
    fakeAdapter({
      listEvents: async () => [
        eventFromInput("one", writeInput()),
        eventFromInput("two", writeInput()),
      ],
    }),
    { defaultTimezone: "Europe/Moscow" },
  );

  assert.equal(result?.status, "needs_clarification");
  assert.match(result?.message ?? "", /несколько событий/u);
});

test("updates one selected event and preserves its duration", async () => {
  const existing = eventFromInput("event-1", writeInput());
  let updatedInput: (GoogleCalendarWriteEventInput & { eventId: string }) | undefined;
  const adapter = fakeAdapter({
    getEvent: async () => updatedInput ? eventFromInput("event-1", updatedInput) : existing,
    updateEvent: async (input) => {
      updatedInput = input;
      return eventFromInput("event-1", input);
    },
  });
  const result = await executeGoogleCalendarAction(
    {
      id: "update",
      type: "update_calendar_event",
      payload: { eventId: "event-1", changes: { startTime: "20:00" } },
    },
    adapter,
    { defaultTimezone: "Europe/Moscow" },
  );

  assert.equal(result?.status, "succeeded");
  assert.equal(updatedInput?.start.dateTime, "2026-08-13T20:00:00");
  assert.equal(updatedInput?.end.dateTime, "2026-08-13T21:00:00");
});

test("runtime validation rejects impossible calendar dates and times", () => {
  const validation = validateActionPlan({
    version: 1,
    mode: "quick_command",
    sourceText: "Создай событие",
    actions: [
      createAction({ date: "2026-02-31", startTime: "25:90" }),
    ],
  });

  assert.equal(validation.valid, false);
  if (validation.valid) return;
  assert.ok(validation.errors.some((error) => error.includes("date is invalid")));
  assert.ok(validation.errors.some((error) => error.includes("startTime is invalid")));
});

function createAction(
  overrides: Partial<Extract<AssistantAction, { type: "create_calendar_event" }>["payload"]> = {},
): Extract<AssistantAction, { type: "create_calendar_event" }> {
  return {
    id: "event",
    type: "create_calendar_event",
    payload: {
      title: "Эфир с Мариной",
      date: "2026-08-13",
      startTime: "19:00",
      endTime: "20:00",
      timezone: "Europe/Moscow",
      ...overrides,
    },
  };
}

function writeInput(): GoogleCalendarWriteEventInput {
  return {
    calendarId: "primary",
    title: "Эфир с Мариной",
    start: { dateTime: "2026-08-13T19:00:00", timeZone: "Europe/Moscow" },
    end: { dateTime: "2026-08-13T20:00:00", timeZone: "Europe/Moscow" },
  };
}

function wireEvent(id: string, start = "19:00", end = "20:00") {
  return {
    id,
    summary: "Эфир с Мариной",
    start: { dateTime: `2026-08-13T${start}:00`, timeZone: "Europe/Moscow" },
    end: { dateTime: `2026-08-13T${end}:00`, timeZone: "Europe/Moscow" },
  };
}

function eventFromInput(id: string, input: GoogleCalendarWriteEventInput): GoogleCalendarEvent {
  return {
    id,
    calendarId: input.calendarId,
    title: input.title,
    start: input.start,
    end: input.end,
    ...(input.description ? { description: input.description } : {}),
    ...(input.extendedProperties ? { extendedProperties: input.extendedProperties } : {}),
  };
}

function fakeAdapter(
  overrides: Partial<GoogleCalendarAdapter> & { onCall?: () => void } = {},
): GoogleCalendarAdapter {
  const call = overrides.onCall ?? (() => undefined);
  return {
    getCalendar: async (calendarId) => {
      call();
      return { id: calendarId, summary: calendarId, timeZone: "Europe/Moscow" };
    },
    listEvents: async () => {
      call();
      return [];
    },
    getEvent: async () => {
      call();
      return eventFromInput("event-1", writeInput());
    },
    createEvent: async (input) => {
      call();
      return eventFromInput("event-1", input);
    },
    updateEvent: async (input) => {
      call();
      return eventFromInput(input.eventId, input);
    },
    ...overrides,
  };
}
