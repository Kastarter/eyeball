import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

/** The catalog 1.0 Gmail manifest defined normatively by RFC 001 section 2.2. */
export const gmailManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "gmail",
    displayName: "Gmail",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "oauth2",
    requiredScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    optionalScopes: ["https://www.googleapis.com/auth/gmail.send"],
  },
  endpoint: {
    baseUrl: "https://gmail.googleapis.com",
    baseUrlOverrideEnv: "EYEBALL_GMAIL_BASE_URL",
  },
  implements: [
    {
      capability: "email",
      canonicalTool: "send_email",
      canonicalVersion: "1.0.0",
      operationId: "users.messages.send",
      inputExtensionSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sendAs: {
            type: "string",
            format: "email",
            description: "A verified Gmail send-as identity.",
          },
        },
      },
    },
    {
      capability: "email",
      canonicalTool: "list_emails",
      canonicalVersion: "1.0.0",
      operationId: "users.messages.list",
    },
    {
      capability: "email",
      canonicalTool: "get_email",
      canonicalVersion: "1.0.0",
      operationId: "users.messages.get",
    },
    {
      capability: "email",
      canonicalTool: "reply_to_email",
      canonicalVersion: "1.0.0",
      operationId: "users.messages.sendReply",
    },
    {
      capability: "email",
      canonicalTool: "create_draft",
      canonicalVersion: "1.0.0",
      operationId: "users.drafts.create",
    },
    {
      capability: "email",
      canonicalTool: "search_emails",
      canonicalVersion: "1.0.0",
      operationId: "users.messages.search",
    },
    {
      capability: "email",
      canonicalTool: "list_threads",
      canonicalVersion: "1.0.0",
      operationId: "users.threads.list",
    },
    {
      capability: "email",
      canonicalTool: "add_email_label",
      canonicalVersion: "1.0.0",
      operationId: "users.messages.modify",
    },
  ],
} as const satisfies ProviderManifest);
