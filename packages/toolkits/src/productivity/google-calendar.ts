import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import {
  asJson,
  booleanValue,
  inputArray,
  inputString,
  isRecord,
  jsonObject,
  jsonRequest,
  numberValue,
  page,
  parseOffsetToken,
  queryPath,
  records,
  recordValue,
  requiredId,
  requiredString,
  responseVoid,
  stringArray,
  stringValue,
  unsupported,
} from "./common.js";

type Interval = { startTime: string; endTime: string };

function calendar(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const accessRole = requiredString(context, value, "accessRole");
  return {
    calendarId: requiredId(context, value.id, "calendar"),
    name: requiredString(context, value, "summary"),
    ...(stringValue(value, "description") === undefined
      ? {}
      : { description: stringValue(value, "description") }),
    timeZone: requiredString(context, value, "timeZone"),
    accessRole:
      accessRole === "freeBusyReader" ? "free_busy_reader" : accessRole,
    primary: booleanValue(value, "primary") ?? false,
  };
}

function attendee(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const response = stringValue(value, "responseStatus") ?? "needsAction";
  return {
    email: requiredString(context, value, "email"),
    ...(stringValue(value, "displayName") === undefined
      ? {}
      : { displayName: stringValue(value, "displayName") }),
    response: response === "needsAction" ? "needs_action" : response,
    optional: booleanValue(value, "optional") ?? false,
    organizer: booleanValue(value, "organizer") ?? false,
    self: booleanValue(value, "self") ?? false,
  };
}

function event(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
  calendarId: string,
): Readonly<Record<string, unknown>> {
  const start = recordValue(value, "start") ?? {};
  const end = recordValue(value, "end") ?? {};
  return {
    eventId: requiredId(context, value.id, "event"),
    calendarId,
    title: requiredString(context, value, "summary"),
    ...(stringValue(value, "description") === undefined
      ? {}
      : { description: stringValue(value, "description") }),
    ...(stringValue(value, "location") === undefined
      ? {}
      : { location: stringValue(value, "location") }),
    startTime: requiredString(context, start, "dateTime"),
    endTime: requiredString(context, end, "dateTime"),
    ...(stringValue(start, "timeZone") === undefined
      ? {}
      : { timeZone: stringValue(start, "timeZone") }),
    attendees: records(value.attendees).map((item) => attendee(context, item)),
    recurrence: stringArray(value.recurrence),
    status: requiredString(context, value, "status"),
    ...(stringValue(value, "htmlLink") === undefined
      ? {}
      : { webUrl: stringValue(value, "htmlLink") }),
    createdAt: requiredString(context, value, "created"),
    updatedAt: requiredString(context, value, "updated"),
  };
}

function dateTime(value: string, timeZone: string | undefined) {
  return { dateTime: value, ...(timeZone === undefined ? {} : { timeZone }) };
}

function eventInput(
  context: AdapterContext,
): Readonly<Record<string, unknown>> {
  const input = context.canonicalInput;
  const timeZone = stringValue(input, "timeZone");
  const attendees = Array.isArray(input.attendees)
    ? input.attendees.filter(isRecord).map((value) => ({
        email: value.email,
        ...(value.displayName === undefined
          ? {}
          : { displayName: value.displayName }),
        optional: value.optional === true,
      }))
    : undefined;
  return {
    ...(input.title === undefined ? {} : { summary: input.title }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(typeof input.startTime !== "string"
      ? {}
      : { start: dateTime(input.startTime, timeZone) }),
    ...(typeof input.endTime !== "string"
      ? {}
      : { end: dateTime(input.endTime, timeZone) }),
    ...(attendees === undefined ? {} : { attendees }),
    ...(input.recurrence === undefined ? {} : { recurrence: input.recurrence }),
    ...(input.status === undefined ? {} : { status: input.status }),
  };
}

function timestamp(value: string): number {
  return new Date(value).valueOf();
}

function mergedBusy(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((left, right) =>
    left.startTime.localeCompare(right.startTime),
  );
  const merged: Interval[] = [];
  for (const current of sorted) {
    const previous = merged.at(-1);
    if (
      previous === undefined ||
      timestamp(current.startTime) > timestamp(previous.endTime)
    ) {
      merged.push({ ...current });
      continue;
    }
    if (timestamp(current.endTime) > timestamp(previous.endTime)) {
      previous.endTime = current.endTime;
    }
  }
  return merged;
}

function availableIntervals(
  startTime: string,
  endTime: string,
  busy: readonly Interval[],
  durationMinutes: number,
): Interval[] {
  const result: Interval[] = [];
  let cursor = timestamp(startTime);
  const end = timestamp(endTime);
  const minimum = durationMinutes * 60_000;
  for (const interval of busy) {
    const busyStart = Math.max(cursor, timestamp(interval.startTime));
    if (busyStart - cursor >= minimum) {
      result.push({
        startTime: new Date(cursor).toISOString(),
        endTime: new Date(busyStart).toISOString(),
      });
    }
    cursor = Math.max(cursor, timestamp(interval.endTime));
  }
  if (end - cursor >= minimum) {
    result.push({
      startTime: new Date(cursor).toISOString(),
      endTime: new Date(end).toISOString(),
    });
  }
  return result;
}

export class GoogleCalendarAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "google-calendar";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "google-calendar.list_calendars":
        return this.listCalendars(context);
      case "google-calendar.list_events":
        return this.listEvents(context);
      case "google-calendar.get_event":
        return this.getEvent(context);
      case "google-calendar.create_event":
        return this.createEvent(context);
      case "google-calendar.update_event":
        return this.updateEvent(context);
      case "google-calendar.delete_event":
        return this.deleteEvent(context);
      case "google-calendar.find_available_times":
        return this.findAvailableTimes(context);
      case "google-calendar.respond_to_event":
        return this.respondToEvent(context);
      default:
        return unsupported(context);
    }
  }

  private async listCalendars(context: AdapterContext): Promise<JsonValue> {
    const body = await jsonObject(context, "calendar/v3/users/me/calendarList");
    const offset = parseOffsetToken(
      context,
      stringValue(context.canonicalInput, "pageToken"),
    );
    const selected = page(
      records(body.items),
      offset,
      numberValue(context.canonicalInput, "pageSize") ?? 50,
    );
    return asJson({
      calendars: selected.values.map((value) => calendar(context, value)),
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }

  private async listEvents(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const calendarId = inputString(context, "calendarId");
    const body = await jsonObject(
      context,
      queryPath(
        `calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          timeMin: stringValue(input, "startTime"),
          timeMax: stringValue(input, "endTime"),
          showDeleted: booleanValue(input, "includeCancelled") ?? false,
        },
      ),
    );
    const selected = page(
      records(body.items),
      parseOffsetToken(context, stringValue(input, "pageToken")),
      numberValue(input, "pageSize") ?? 50,
    );
    return asJson({
      events: selected.values.map((value) => event(context, value, calendarId)),
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }

  private async getEvent(context: AdapterContext): Promise<JsonValue> {
    const calendarId = inputString(context, "calendarId");
    const eventId = inputString(context, "eventId");
    const body = await jsonObject(
      context,
      `calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
    return asJson({ event: event(context, body, calendarId) });
  }

  private async createEvent(context: AdapterContext): Promise<JsonValue> {
    const calendarId = inputString(context, "calendarId");
    const body = await jsonObject(
      context,
      `calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      jsonRequest(eventInput(context)),
    );
    return asJson({ event: event(context, body, calendarId) });
  }

  private async updateEvent(context: AdapterContext): Promise<JsonValue> {
    const calendarId = inputString(context, "calendarId");
    const eventId = inputString(context, "eventId");
    const body = await jsonObject(
      context,
      `calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      jsonRequest(eventInput(context), "PATCH"),
    );
    return asJson({ event: event(context, body, calendarId) });
  }

  private async deleteEvent(context: AdapterContext): Promise<JsonValue> {
    const calendarId = inputString(context, "calendarId");
    const eventId = inputString(context, "eventId");
    await responseVoid(
      context,
      `calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE" },
    );
    return asJson({ eventId, deleted: true });
  }

  private async findAvailableTimes(
    context: AdapterContext,
  ): Promise<JsonValue> {
    const startTime = inputString(context, "startTime");
    const endTime = inputString(context, "endTime");
    const calendarIds = inputArray(context, "calendarIds").filter(
      (value): value is string => typeof value === "string",
    );
    const body = await jsonObject(
      context,
      "calendar/v3/freeBusy",
      jsonRequest({
        timeMin: startTime,
        timeMax: endTime,
        items: calendarIds.map((id) => ({ id })),
      }),
    );
    const calendars = recordValue(body, "calendars") ?? {};
    const busy = mergedBusy(
      Object.values(calendars)
        .filter(isRecord)
        .flatMap((value) =>
          records(value.busy).flatMap((interval) => {
            const start = stringValue(interval, "start");
            const end = stringValue(interval, "end");
            return start === undefined || end === undefined
              ? []
              : [{ startTime: start, endTime: end }];
          }),
        ),
    );
    return asJson({
      availableTimes: availableIntervals(
        startTime,
        endTime,
        busy,
        numberValue(context.canonicalInput, "durationMinutes") ?? 30,
      ),
      busyTimes: busy,
    });
  }

  private async respondToEvent(context: AdapterContext): Promise<JsonValue> {
    const calendarId = inputString(context, "calendarId");
    const eventId = inputString(context, "eventId");
    const body = await jsonObject(
      context,
      `calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}/attendees/respond`,
      jsonRequest({
        email: inputString(context, "attendeeEmail"),
        responseStatus: inputString(context, "response"),
      }),
    );
    return asJson({ event: event(context, body, calendarId) });
  }
}

export const googleCalendarAdapter = new GoogleCalendarAdapter();
