import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const googleSheetsManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "google-sheets",
    displayName: "Google Sheets",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: { class: "oauth2" },
  endpoint: {
    baseUrl: "https://sheets.googleapis.com",
    baseUrlOverrideEnv: "EYEBALL_GOOGLE_SHEETS_BASE_URL",
  },
  implements: (
    [
      ["list_rows", "spreadsheets.values.get.rows"],
      ["search_rows", "spreadsheets.values.get.search"],
      ["append_row", "spreadsheets.values.append"],
      ["get_range", "spreadsheets.values.get"],
      ["update_range", "spreadsheets.values.update"],
      ["list_tables", "spreadsheets.get"],
    ] as const
  ).map(([canonicalTool, operationId]) => ({
    capability: "spreadsheets_databases",
    canonicalTool,
    canonicalVersion: "1.0.0",
    operationId,
  })),
} as const satisfies ProviderManifest);
