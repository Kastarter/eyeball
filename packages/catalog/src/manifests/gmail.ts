import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

/** Gmail tools from catalog 1.0 plus the additive catalog 1.1 reaction surface. */
export const gmailManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.1",
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
      canonicalVersion: "1.1.0",
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
      canonicalVersion: "1.1.0",
      operationId: "users.messages.sendReply",
    },
    {
      capability: "email",
      canonicalTool: "create_draft",
      canonicalVersion: "1.1.0",
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
  triggers: [
    {
      capability: "email",
      canonicalTrigger: "email_received",
      canonicalVersion: "1.0.0",
      operationId: "users.messages.list.poll",
      delivery: {
        mode: "polling",
        defaultIntervalSeconds: 60,
        minimumIntervalSeconds: 30,
      },
      payloadExtensionSchema: {
        type: "object",
        additionalProperties: false,
        required: ["historyId", "labelIds"],
        properties: {
          historyId: { type: "string", minLength: 1 },
          labelIds: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
  ],
} as const satisfies ProviderManifest);
