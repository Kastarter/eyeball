import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

const MAIL_READ_SCOPE = "https://graph.microsoft.com/Mail.Read";
const MAIL_READ_WRITE_SCOPE = "https://graph.microsoft.com/Mail.ReadWrite";
const MAIL_SEND_SCOPE = "https://graph.microsoft.com/Mail.Send";

export const microsoftOutlookManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "microsoft-outlook",
    displayName: "Microsoft Outlook / Graph Mail",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "oauth2",
    optionalScopes: [MAIL_READ_SCOPE, MAIL_READ_WRITE_SCOPE, MAIL_SEND_SCOPE],
  },
  endpoint: {
    baseUrl: "https://graph.microsoft.com",
    baseUrlOverrideEnv: "EYEBALL_MICROSOFT_OUTLOOK_BASE_URL",
  },
  implements: [
    {
      capability: "email",
      canonicalTool: "send_email",
      canonicalVersion: "1.0.0",
      operationId: "me.sendMail",
      requiredScopes: [MAIL_READ_SCOPE, MAIL_SEND_SCOPE],
    },
    {
      capability: "email",
      canonicalTool: "list_emails",
      canonicalVersion: "1.0.0",
      operationId: "me.messages.list",
      requiredScopes: [MAIL_READ_SCOPE],
    },
    {
      capability: "email",
      canonicalTool: "get_email",
      canonicalVersion: "1.0.0",
      operationId: "me.messages.get",
      requiredScopes: [MAIL_READ_SCOPE],
    },
    {
      capability: "email",
      canonicalTool: "reply_to_email",
      canonicalVersion: "1.0.0",
      operationId: "me.messages.reply",
      requiredScopes: [MAIL_READ_SCOPE, MAIL_SEND_SCOPE],
    },
    {
      capability: "email",
      canonicalTool: "create_draft",
      canonicalVersion: "1.0.0",
      operationId: "me.messages.create",
      requiredScopes: [MAIL_READ_WRITE_SCOPE],
    },
    {
      capability: "email",
      canonicalTool: "search_emails",
      canonicalVersion: "1.0.0",
      operationId: "me.messages.search",
      requiredScopes: [MAIL_READ_SCOPE],
    },
    {
      capability: "email",
      canonicalTool: "list_threads",
      canonicalVersion: "1.0.0",
      operationId: "me.messages.listConversations",
      requiredScopes: [MAIL_READ_SCOPE],
    },
    {
      capability: "email",
      canonicalTool: "add_email_label",
      canonicalVersion: "1.0.0",
      operationId: "me.messages.updateOrMove",
      requiredScopes: [MAIL_READ_WRITE_SCOPE],
    },
  ],
} as const satisfies ProviderManifest);
