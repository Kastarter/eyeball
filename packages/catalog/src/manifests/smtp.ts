import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const smtpManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "smtp",
    displayName: "Generic SMTP",
    source: "activepieces-bridge",
    tier: "P1",
  },
  auth: {
    class: "basic",
    fields: ["username", "password"],
  },
  endpoint: {
    baseUrl: "https://smtp.invalid",
    baseUrlOverrideEnv: "EYEBALL_SMTP_BASE_URL",
  },
  implements: [
    {
      capability: "email",
      canonicalTool: "send_email",
      canonicalVersion: "1.0.0",
      operationId: "smtp.send",
      inputExtensionSchema: {
        type: "object",
        additionalProperties: false,
        required: ["from"],
        properties: {
          from: {
            type: "string",
            format: "email",
            description: "Envelope and message sender address.",
          },
        },
      },
    },
  ],
} as const satisfies ProviderManifest);
