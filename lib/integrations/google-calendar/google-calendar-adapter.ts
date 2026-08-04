import { createGoogleAccessTokenProvider } from "../google-sheets/google-auth";
import type {
  GoogleCalendarAdapter,
  GoogleCalendarEvent,
  GoogleCalendarSummary,
  GoogleCalendarWriteEventInput,
} from "./types";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

type FetchImplementation = typeof fetch;

type CalendarWire = {
  id?: string;
  summary?: string;
  timeZone?: string;
};

type EventWire = {
  id?: string;
  summary?: string;
  description?: string;
  status?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
};

type EventListWire = {
  items?: EventWire[];
};

export function createGoogleCalendarAdapter({
  getAccessToken,
  fetchImplementation = fetch,
}: {
  getAccessToken: () => Promise<string>;
  fetchImplementation?: FetchImplementation;
}): GoogleCalendarAdapter {
  async function request<T>(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await getAccessToken()}`);
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await fetchImplementation(`${CALENDAR_API}${path}`, {
      ...init,
      headers,
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Google Calendar API failed with status ${response.status}: ${responseText.slice(0, 1_000)}`,
      );
    }

    return responseText ? (JSON.parse(responseText) as T) : ({} as T);
  }

  return {
    async getCalendar(calendarId) {
      const wire = await request<CalendarWire>(
        `/calendars/${encodeURIComponent(calendarId)}`,
      );
      if (!wire.id) throw new Error("Google Calendar response has no calendar id.");
      return {
        id: wire.id,
        summary: wire.summary?.trim() || wire.id,
        ...(wire.timeZone ? { timeZone: wire.timeZone } : {}),
      } satisfies GoogleCalendarSummary;
    },

    async listEvents(input) {
      const parameters = new URLSearchParams({
        singleEvents: "true",
        showDeleted: "false",
        maxResults: String(Math.min(Math.max(input.maxResults ?? 20, 1), 50)),
        orderBy: "startTime",
      });
      if (input.timeMin) parameters.set("timeMin", input.timeMin);
      if (input.timeMax) parameters.set("timeMax", input.timeMax);
      if (input.privateExtendedProperty) {
        parameters.set("privateExtendedProperty", input.privateExtendedProperty);
      }
      if (input.query) parameters.set("q", input.query);
      const wire = await request<EventListWire>(
        `/calendars/${encodeURIComponent(input.calendarId)}/events?${parameters.toString()}`,
      );
      return (wire.items ?? []).flatMap((event) =>
        normalizeEvent(event, input.calendarId),
      );
    },

    async getEvent(calendarId, eventId) {
      const wire = await request<EventWire>(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
      const event = normalizeEvent(wire, calendarId)[0];
      if (!event) throw new Error("Google Calendar response has no event id.");
      return event;
    },

    async createEvent(input) {
      const wire = await request<EventWire>(
        `/calendars/${encodeURIComponent(input.calendarId)}/events`,
        { method: "POST", body: JSON.stringify(eventBody(input)) },
      );
      const event = normalizeEvent(wire, input.calendarId)[0];
      if (!event) throw new Error("Google Calendar did not return the created event.");
      return event;
    },

    async updateEvent(input) {
      const wire = await request<EventWire>(
        `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
        { method: "PATCH", body: JSON.stringify(eventBody(input)) },
      );
      const event = normalizeEvent(wire, input.calendarId)[0];
      if (!event) throw new Error("Google Calendar did not return the updated event.");
      return event;
    },
  };
}

export function createGoogleCalendarAdapterFromEnv() {
  const getAccessToken = createGoogleAccessTokenProvider();
  return getAccessToken ? createGoogleCalendarAdapter({ getAccessToken }) : null;
}

function eventBody(input: GoogleCalendarWriteEventInput) {
  return {
    summary: input.title,
    ...(input.description ? { description: input.description } : {}),
    start: input.start,
    end: input.end,
    ...(input.extendedProperties
      ? { extendedProperties: input.extendedProperties }
      : {}),
  };
}

function normalizeEvent(event: EventWire, calendarId: string): GoogleCalendarEvent[] {
  if (!event.id || !event.start || !event.end) return [];
  return [
    {
      id: event.id,
      calendarId,
      title: event.summary?.trim() || "Без названия",
      start: event.start,
      end: event.end,
      ...(event.description ? { description: event.description } : {}),
      ...(event.status ? { status: event.status } : {}),
      ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
      ...(event.extendedProperties
        ? { extendedProperties: event.extendedProperties }
        : {}),
    },
  ];
}
