import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const notionManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "notion",
    displayName: "Notion",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: { class: "oauth2" },
  endpoint: {
    baseUrl: "https://api.notion.com",
    baseUrlOverrideEnv: "EYEBALL_NOTION_BASE_URL",
  },
  implements: (
    [
      ["list_rows", "databases.query"],
      ["get_row", "pages.retrieve"],
      ["create_row", "pages.create"],
      ["update_row", "pages.update"],
      ["delete_row", "pages.archive"],
      ["search_rows", "databases.query.filtered"],
      ["list_tables", "search.databases"],
    ] as const
  ).map(([canonicalTool, operationId]) => ({
    capability: "spreadsheets_databases",
    canonicalTool,
    canonicalVersion: "1.0.0",
    operationId,
  })),
} as const satisfies ProviderManifest);
