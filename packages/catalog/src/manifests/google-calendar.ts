import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const googleCalendarManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "google-calendar",
    displayName: "Google Calendar",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: { class: "oauth2" },
  endpoint: {
    baseUrl: "https://www.googleapis.com",
    baseUrlOverrideEnv: "EYEBALL_GOOGLE_CALENDAR_BASE_URL",
  },
  implements: [
    {
      capability: "calendar_scheduling",
      canonicalTool: "list_calendars",
      canonicalVersion: "1.0.0",
      operationId: "calendarList.list",
    },
    {
      capability: "calendar_scheduling",
      canonicalTool: "list_events",
      canonicalVersion: "1.0.0",
      operationId: "events.list",
    },
    {
      capability: "calendar_scheduling",
      canonicalTool: "get_event",
      canonicalVersion: "1.0.0",
      operationId: "events.get",
    },
    {
      capability: "calendar_scheduling",
      canonicalTool: "create_event",
      canonicalVersion: "1.0.0",
      operationId: "events.insert",
    },
    {
      capability: "calendar_scheduling",
      canonicalTool: "update_event",
      canonicalVersion: "1.0.0",
      operationId: "events.patch",
    },
    {
      capability: "calendar_scheduling",
      canonicalTool: "delete_event",
      canonicalVersion: "1.0.0",
      operationId: "events.delete",
    },
    {
      capability: "calendar_scheduling",
      canonicalTool: "find_available_times",
      canonicalVersion: "1.0.0",
      operationId: "freebusy.query",
    },
    {
      capability: "calendar_scheduling",
      canonicalTool: "respond_to_event",
      canonicalVersion: "1.0.0",
      operationId: "events.attendees.respond",
    },
  ],
} as const satisfies ProviderManifest);
