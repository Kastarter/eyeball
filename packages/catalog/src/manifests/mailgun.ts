import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

const domainProperty = {
  type: "string",
  description: "Mailgun sending domain used in the API route.",
  minLength: 1,
} as const;

export const mailgunManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "mailgun",
    displayName: "Mailgun",
    source: "activepieces-bridge",
    tier: "P1",
  },
  auth: {
    class: "api_key",
    fields: ["apiKey"],
  },
  endpoint: {
    baseUrl: "https://api.mailgun.net",
    baseUrlOverrideEnv: "EYEBALL_MAILGUN_BASE_URL",
  },
  implements: [
    {
      capability: "email",
      canonicalTool: "send_email",
      canonicalVersion: "1.0.0",
      operationId: "messages.create",
      inputExtensionSchema: {
        type: "object",
        additionalProperties: false,
        required: ["domain", "from"],
        properties: {
          domain: domainProperty,
          from: {
            type: "string",
            description:
              "Verified Mailgun sender, optionally with a display name.",
            minLength: 1,
          },
        },
      },
    },
    {
      capability: "email",
      canonicalTool: "list_emails",
      canonicalVersion: "1.0.0",
      operationId: "events.list",
      inputExtensionSchema: {
        type: "object",
        additionalProperties: false,
        required: ["domain"],
        properties: {
          domain: domainProperty,
        },
      },
    },
  ],
} as const satisfies ProviderManifest);
