import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const gitHubManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "github",
    displayName: "GitHub",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: { class: "oauth2" },
  endpoint: {
    baseUrl: "https://api.github.com",
    baseUrlOverrideEnv: "EYEBALL_GITHUB_BASE_URL",
  },
  implements: (
    [
      ["list_projects", "repos.listForAuthenticatedUser"],
      ["create_issue", "issues.create"],
      ["get_issue", "issues.get"],
      ["list_issues", "issues.listForRepo"],
      ["update_issue", "issues.update"],
      ["add_comment", "issues.createComment"],
      ["get_pull_request", "pulls.get"],
      ["list_commits", "repos.listCommits"],
    ] as const
  ).map(([canonicalTool, operationId]) => ({
    capability: "project_management_dev_tools",
    canonicalTool,
    canonicalVersion: "1.0.0",
    operationId,
  })),
} as const satisfies ProviderManifest);
