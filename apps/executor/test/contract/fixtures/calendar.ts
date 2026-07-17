import { defineCapabilityFixtures } from "../fixtures.js";

const CALENDAR = "primary";
const EVENT = "event_launch_000001";

export const calendarFixtures = defineCapabilityFixtures(
  "calendar_scheduling",
  {
    create_event: {
      input: {
        calendarId: CALENDAR,
        title: "Contract fixture event",
        startTime: "2026-01-15T09:00:00.000Z",
        endTime: "2026-01-15T09:30:00.000Z",
      },
    },
    create_scheduling_link: {
      input: { title: "Contract fixture slot", durationMinutes: 30 },
    },
    delete_event: {
      input: (context) => ({
        calendarId: context.value("CALENDAR_ID", CALENDAR),
        eventId: context.value("EVENT_ID", EVENT),
      }),
    },
    find_available_times: {
      input: (context) => ({
        calendarIds: [context.value("CALENDAR_ID", CALENDAR)],
        startTime: "2026-01-15T08:00:00.000Z",
        endTime: "2026-01-15T12:00:00.000Z",
        durationMinutes: 30,
      }),
    },
    get_event: {
      input: (context) => ({
        calendarId: context.value("CALENDAR_ID", CALENDAR),
        eventId: context.value("EVENT_ID", EVENT),
      }),
    },
    list_calendars: { input: { pageSize: 10 } },
    list_events: {
      input: (context) => ({
        calendarId: context.value("CALENDAR_ID", CALENDAR),
        pageSize: 10,
      }),
    },
    respond_to_event: {
      input: (context) => ({
        calendarId: context.value("CALENDAR_ID", CALENDAR),
        eventId: context.value("EVENT_ID", EVENT),
        attendeeEmail: context.value("ATTENDEE_EMAIL", "jordan@acme.example"),
        response: "accepted",
      }),
    },
    update_event: {
      input: (context) => ({
        calendarId: context.value("CALENDAR_ID", CALENDAR),
        eventId: context.value("EVENT_ID", EVENT),
        title: "Contract fixture event updated",
      }),
    },
  },
);
