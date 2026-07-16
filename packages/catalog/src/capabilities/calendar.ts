import type { CapabilityToolContract, JSONSchema202012 } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "calendar_scheduling" as const;
const VERSION = "1.0.0" as const;
const READ_ONLY = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  async: false,
} as const;
const CREATE = {
  readOnly: false,
  destructive: false,
  idempotent: false,
  async: false,
} as const;
const UPDATE = {
  readOnly: false,
  destructive: false,
  idempotent: true,
  async: false,
} as const;
const DELETE = {
  readOnly: false,
  destructive: true,
  idempotent: true,
  async: false,
} as const;

const id = (description: string): JSONSchema202012 => ({
  type: "string",
  description,
  minLength: 1,
});
const dateTime = (description: string): JSONSchema202012 => ({
  type: "string",
  format: "date-time",
  description,
});
const stringList = (description: string): JSONSchema202012 => ({
  type: "array",
  description,
  items: { type: "string", minLength: 1 },
});

const attendeeInput = (): JSONSchema202012 => ({
  type: "object",
  description: "An event attendee to invite.",
  additionalProperties: false,
  required: ["email"],
  properties: {
    email: {
      type: "string",
      format: "email",
      description: "Attendee email address.",
    },
    displayName: { type: "string", description: "Attendee display name." },
    optional: {
      type: "boolean",
      description: "Whether attendance is optional.",
      default: false,
    },
  },
});

const attendeeOutput = (): JSONSchema202012 => ({
  type: "object",
  description: "Normalized event attendee and response state.",
  additionalProperties: false,
  required: ["email", "response", "optional"],
  properties: {
    email: {
      type: "string",
      format: "email",
      description: "Attendee email address.",
    },
    displayName: { type: "string", description: "Attendee display name." },
    response: {
      type: "string",
      enum: ["needs_action", "declined", "tentative", "accepted"],
      description: "Current attendance response.",
    },
    optional: {
      type: "boolean",
      description: "Whether attendance is optional.",
    },
    organizer: {
      type: "boolean",
      description: "Whether this attendee is the organizer.",
    },
    self: {
      type: "boolean",
      description: "Whether this attendee represents the connected account.",
    },
  },
});

const calendarSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized calendar visible to the connected account.",
  additionalProperties: false,
  required: ["calendarId", "name", "timeZone", "accessRole", "primary"],
  properties: {
    calendarId: id("Provider identifier of the calendar."),
    name: id("Calendar display name."),
    description: { type: "string", description: "Calendar description." },
    timeZone: id("IANA time-zone name."),
    accessRole: {
      type: "string",
      enum: ["owner", "writer", "reader", "free_busy_reader"],
      description: "Connected account access role.",
    },
    primary: {
      type: "boolean",
      description: "Whether this is the account's primary calendar.",
    },
  },
});

const eventSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized calendar event.",
  additionalProperties: false,
  required: [
    "eventId",
    "calendarId",
    "title",
    "startTime",
    "endTime",
    "status",
    "attendees",
    "recurrence",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    eventId: id("Provider identifier of the event."),
    calendarId: id("Provider identifier of the containing calendar."),
    title: id("Event title."),
    description: { type: "string", description: "Event description." },
    location: { type: "string", description: "Event location." },
    startTime: dateTime("Event start timestamp."),
    endTime: dateTime("Event end timestamp."),
    timeZone: id("IANA time zone attached to the event."),
    attendees: {
      type: "array",
      description: "Event attendees.",
      items: attendeeOutput(),
    },
    recurrence: stringList("Provider recurrence rules."),
    status: {
      type: "string",
      enum: ["confirmed", "tentative", "cancelled"],
      description: "Event status.",
    },
    webUrl: {
      type: "string",
      format: "uri",
      description: "Provider web URL for the event.",
    },
    createdAt: dateTime("Event creation timestamp."),
    updatedAt: dateTime("Most recent event update timestamp."),
  },
});

const eventWriteProperties = {
  title: id("Event title."),
  description: { type: "string", description: "Event description." },
  location: { type: "string", description: "Event location." },
  startTime: dateTime("Event start timestamp."),
  endTime: dateTime("Event end timestamp."),
  timeZone: id("IANA time-zone name for the event."),
  attendees: {
    type: "array",
    description: "Attendees to invite.",
    items: attendeeInput(),
  },
  recurrence: stringList(
    "Provider recurrence rules, such as RFC 5545 RRULE values.",
  ),
} as const;

const listCalendars = defineContract({
  capability: CAPABILITY,
  name: "list_calendars",
  description: "List calendars visible to the connected account.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_calendars",
    direction: "input",
    description: "Calendar pagination selectors.",
    properties: {
      pageSize: pageSizeProperty("calendars"),
      pageToken: pageTokenProperty("calendar"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_calendars",
    direction: "output",
    description: "One page of visible calendars.",
    required: ["calendars"],
    properties: {
      calendars: {
        type: "array",
        description: "Visible calendars.",
        items: calendarSchema(),
      },
      nextPageToken: nextPageTokenProperty("calendars"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const listEvents = defineContract({
  capability: CAPABILITY,
  name: "list_events",
  description:
    "List events on one calendar, optionally restricted to an overlapping time range.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_events",
    direction: "input",
    description: "Calendar, time range, and pagination selectors.",
    required: ["calendarId"],
    properties: {
      calendarId: id("Provider identifier of the calendar."),
      startTime: dateTime("Earliest overlapping event time."),
      endTime: dateTime("Latest overlapping event time."),
      includeCancelled: {
        type: "boolean",
        default: false,
        description: "Whether cancelled events are included.",
      },
      pageSize: pageSizeProperty("events"),
      pageToken: pageTokenProperty("event"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_events",
    direction: "output",
    description: "One page of events.",
    required: ["events"],
    properties: {
      events: {
        type: "array",
        description: "Calendar events.",
        items: eventSchema(),
      },
      nextPageToken: nextPageTokenProperty("events"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getEvent = defineContract({
  capability: CAPABILITY,
  name: "get_event",
  description: "Retrieve one event and its attendance state.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_event",
    direction: "input",
    description: "Calendar and event identifiers.",
    required: ["calendarId", "eventId"],
    properties: {
      calendarId: id("Provider identifier of the calendar."),
      eventId: id("Provider identifier of the event."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_event",
    direction: "output",
    description: "Requested event.",
    required: ["event"],
    properties: { event: eventSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const createEvent = defineContract({
  capability: CAPABILITY,
  name: "create_event",
  description:
    "Create a calendar event with attendees and optional recurrence. This sends or exposes an external invitation where supported.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_event",
    direction: "input",
    description: "Calendar and new event fields.",
    required: ["calendarId", "title", "startTime", "endTime"],
    properties: {
      calendarId: id("Provider identifier of the calendar."),
      ...eventWriteProperties,
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_event",
    direction: "output",
    description: "Newly created event.",
    required: ["event"],
    properties: { event: eventSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const updateEvent = defineContract({
  capability: CAPABILITY,
  name: "update_event",
  description:
    "Update an existing event, attendee list, recurrence, or status. Repeating the same values has no additional effect.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "update_event",
      direction: "input",
      description: "Event identifiers and fields to update.",
      required: ["calendarId", "eventId"],
      properties: {
        calendarId: id("Provider identifier of the calendar."),
        eventId: id("Provider identifier of the event."),
        ...eventWriteProperties,
        status: {
          type: "string",
          enum: ["confirmed", "tentative", "cancelled"],
          description: "Replacement event status.",
        },
      },
    }),
    minProperties: 3,
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_event",
    direction: "output",
    description: "Updated event.",
    required: ["event"],
    properties: { event: eventSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const deleteEvent = defineContract({
  capability: CAPABILITY,
  name: "delete_event",
  description:
    "Delete or cancel an event. This is destructive and can notify or affect external attendees.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "delete_event",
    direction: "input",
    description: "Calendar and event identifiers.",
    required: ["calendarId", "eventId"],
    properties: {
      calendarId: id("Provider identifier of the calendar."),
      eventId: id("Provider identifier of the event."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "delete_event",
    direction: "output",
    description: "Deletion acknowledgement.",
    required: ["eventId", "deleted"],
    properties: {
      eventId: id("Provider identifier of the deleted event."),
      deleted: {
        type: "boolean",
        const: true,
        description: "Whether deletion completed.",
      },
    },
  }),
  annotations: DELETE,
  version: VERSION,
});

const findAvailableTimes = defineContract({
  capability: CAPABILITY,
  name: "find_available_times",
  description:
    "Compute free intervals shared across selected calendars from provider free/busy data.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "find_available_times",
    direction: "input",
    description: "Calendars and search window.",
    required: ["calendarIds", "startTime", "endTime"],
    properties: {
      calendarIds: {
        type: "array",
        minItems: 1,
        description: "Calendars that must all be free.",
        items: { type: "string", minLength: 1 },
      },
      startTime: dateTime("Search-window start."),
      endTime: dateTime("Search-window end."),
      durationMinutes: {
        type: "integer",
        minimum: 1,
        maximum: 1440,
        default: 30,
        description: "Minimum returned free interval duration.",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "find_available_times",
    direction: "output",
    description: "Free intervals satisfying the requested duration.",
    required: ["availableTimes", "busyTimes"],
    properties: {
      availableTimes: {
        type: "array",
        description: "Free intervals shared across all calendars.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["startTime", "endTime"],
          properties: {
            startTime: dateTime("Free interval start."),
            endTime: dateTime("Free interval end."),
          },
        },
      },
      busyTimes: {
        type: "array",
        description: "Merged busy intervals used in the calculation.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["startTime", "endTime"],
          properties: {
            startTime: dateTime("Busy interval start."),
            endTime: dateTime("Busy interval end."),
          },
        },
      },
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const createSchedulingLink = defineContract({
  capability: CAPABILITY,
  name: "create_scheduling_link",
  description:
    "Create or retrieve a bookable scheduling link for a calendar, event type, or availability window.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_scheduling_link",
    direction: "input",
    description: "Scheduling-link title, duration, calendar, and availability.",
    required: ["title", "durationMinutes"],
    properties: {
      title: id("Public scheduling-link title."),
      calendarId: id("Calendar receiving booked events."),
      durationMinutes: {
        type: "integer",
        minimum: 1,
        maximum: 1440,
        description: "Duration of each bookable event in minutes.",
      },
      startTime: dateTime("Beginning of the optional availability window."),
      endTime: dateTime("End of the optional availability window."),
      timeZone: id("IANA time-zone name used for availability."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_scheduling_link",
    direction: "output",
    description: "Created or resolved scheduling link.",
    required: ["schedulingLinkId", "url", "title", "durationMinutes"],
    properties: {
      schedulingLinkId: id("Provider identifier of the scheduling link."),
      url: {
        type: "string",
        format: "uri",
        description: "Public booking URL.",
      },
      title: id("Public scheduling-link title."),
      durationMinutes: {
        type: "integer",
        minimum: 1,
        description: "Duration of each bookable event in minutes.",
      },
      calendarId: id("Calendar receiving booked events."),
    },
  }),
  annotations: CREATE,
  version: VERSION,
});

const respondToEvent = defineContract({
  capability: CAPABILITY,
  name: "respond_to_event",
  description:
    "Accept, tentatively accept, or decline an event invitation for one attendee.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "respond_to_event",
    direction: "input",
    description: "Event, attendee, and response.",
    required: ["calendarId", "eventId", "attendeeEmail", "response"],
    properties: {
      calendarId: id("Provider identifier of the calendar."),
      eventId: id("Provider identifier of the event."),
      attendeeEmail: {
        type: "string",
        format: "email",
        description: "Attendee email whose response changes.",
      },
      response: {
        type: "string",
        enum: ["accepted", "tentative", "declined"],
        description: "New attendance response.",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "respond_to_event",
    direction: "output",
    description: "Updated event and attendance state.",
    required: ["event"],
    properties: { event: eventSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

export const calendarCapabilityContracts = deepFreeze([
  listCalendars,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  findAvailableTimes,
  createSchedulingLink,
  respondToEvent,
] as const satisfies readonly CapabilityToolContract[]);

type CalendarContract = (typeof calendarCapabilityContracts)[number];
type CalendarContractsByName = {
  readonly [Contract in CalendarContract as Contract["name"]]: Contract;
};
export const calendarContractsByName = deepFreeze(
  Object.fromEntries(
    calendarCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as CalendarContractsByName,
);
