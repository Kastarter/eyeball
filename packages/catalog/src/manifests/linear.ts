import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const linearManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "linear",
    displayName: "Linear",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: { class: "oauth2" },
  endpoint: {
    baseUrl: "https://api.linear.app",
    baseUrlOverrideEnv: "EYEBALL_LINEAR_BASE_URL",
  },
  implements: (
    [
      ["list_projects", "projects.teams"],
      ["create_issue", "issueCreate"],
      ["get_issue", "issue"],
      ["list_issues", "issues"],
      ["update_issue", "issueUpdate"],
      ["add_comment", "commentCreate"],
    ] as const
  ).map(([canonicalTool, operationId]) => ({
    capability: "project_management_dev_tools",
    canonicalTool,
    canonicalVersion: "1.0.0",
    operationId,
  })),
} as const satisfies ProviderManifest);
