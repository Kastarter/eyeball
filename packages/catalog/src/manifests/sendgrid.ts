import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const sendGridManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "sendgrid",
    displayName: "SendGrid",
    source: "activepieces-bridge",
    tier: "P1",
  },
  auth: {
    class: "api_key",
    fields: ["apiKey"],
  },
  endpoint: {
    baseUrl: "https://api.sendgrid.com",
    baseUrlOverrideEnv: "EYEBALL_SENDGRID_BASE_URL",
  },
  implements: [
    {
      capability: "email",
      canonicalTool: "send_email",
      canonicalVersion: "1.0.0",
      operationId: "mail.send",
      inputExtensionSchema: {
        type: "object",
        additionalProperties: false,
        required: ["from"],
        properties: {
          from: {
            type: "string",
            format: "email",
            description: "Verified SendGrid sender address.",
          },
          fromName: {
            type: "string",
            description: "Optional display name for the verified sender.",
            minLength: 1,
          },
        },
      },
    },
  ],
} as const satisfies ProviderManifest);
