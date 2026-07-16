import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const airtableManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "airtable",
    displayName: "Airtable",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: { class: "oauth2" },
  endpoint: {
    baseUrl: "https://api.airtable.com",
    baseUrlOverrideEnv: "EYEBALL_AIRTABLE_BASE_URL",
  },
  implements: (
    [
      ["list_rows", "records.list"],
      ["get_row", "records.get"],
      ["create_row", "records.create"],
      ["update_row", "records.update"],
      ["delete_row", "records.delete"],
      ["search_rows", "records.list.filterByFormula"],
    ] as const
  ).map(([canonicalTool, operationId]) => ({
    capability: "spreadsheets_databases",
    canonicalTool,
    canonicalVersion: "1.0.0",
    operationId,
  })),
} as const satisfies ProviderManifest);
