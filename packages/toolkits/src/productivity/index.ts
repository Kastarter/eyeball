import type { ToolkitAdapter } from "@eyeball/core";
import { airtableAdapter } from "./airtable.js";
import { gitHubAdapter } from "./github.js";
import { googleCalendarAdapter } from "./google-calendar.js";
import { googleDriveAdapter } from "./google-drive.js";
import { googleSheetsAdapter } from "./google-sheets.js";
import { linearAdapter } from "./linear.js";
import { notionAdapter } from "./notion.js";

export * from "./airtable.js";
export * from "./github.js";
export * from "./google-calendar.js";
export * from "./google-drive.js";
export * from "./google-sheets.js";
export * from "./linear.js";
export * from "./notion.js";

export const productivityToolkitAdapters = Object.freeze([
  notionAdapter,
  airtableAdapter,
  googleSheetsAdapter,
  googleDriveAdapter,
  googleCalendarAdapter,
  gitHubAdapter,
  linearAdapter,
] as const satisfies readonly ToolkitAdapter[]);
