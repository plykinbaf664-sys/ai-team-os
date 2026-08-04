export type GoogleCalendarSummary = {
  id: string;
  summary: string;
  timeZone?: string;
};

export type GoogleCalendarEventDateTime = {
  dateTime?: string;
  date?: string;
  timeZone?: string;
};

export type GoogleCalendarEvent = {
  id: string;
  calendarId: string;
  title: string;
  description?: string;
  status?: string;
  htmlLink?: string;
  start: GoogleCalendarEventDateTime;
  end: GoogleCalendarEventDateTime;
  extendedProperties?: {
    private?: Record<string, string>;
  };
};

export type GoogleCalendarListEventsInput = {
  calendarId: string;
  timeMin?: string;
  timeMax?: string;
  privateExtendedProperty?: string;
  query?: string;
  maxResults?: number;
};

export type GoogleCalendarWriteEventInput = {
  calendarId: string;
  eventId?: string;
  title: string;
  description?: string;
  start: GoogleCalendarEventDateTime;
  end: GoogleCalendarEventDateTime;
  extendedProperties?: {
    private?: Record<string, string>;
  };
};

export interface GoogleCalendarAdapter {
  getCalendar(calendarId: string): Promise<GoogleCalendarSummary>;
  listEvents(input: GoogleCalendarListEventsInput): Promise<GoogleCalendarEvent[]>;
  getEvent(calendarId: string, eventId: string): Promise<GoogleCalendarEvent>;
  createEvent(input: GoogleCalendarWriteEventInput): Promise<GoogleCalendarEvent>;
  updateEvent(input: GoogleCalendarWriteEventInput & { eventId: string }): Promise<GoogleCalendarEvent>;
}
