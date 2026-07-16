import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const resendManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "resend",
    displayName: "Resend",
    source: "activepieces-bridge",
    tier: "P1",
  },
  auth: {
    class: "api_key",
    fields: ["apiKey"],
  },
  endpoint: {
    baseUrl: "https://api.resend.com",
    baseUrlOverrideEnv: "EYEBALL_RESEND_BASE_URL",
  },
  implements: [
    {
      capability: "email",
      canonicalTool: "send_email",
      canonicalVersion: "1.0.0",
      operationId: "emails.send",
      inputExtensionSchema: {
        type: "object",
        additionalProperties: false,
        required: ["from"],
        properties: {
          from: {
            type: "string",
            description:
              "Verified Resend sender, optionally with a display name.",
            minLength: 1,
          },
        },
      },
    },
  ],
} as const satisfies ProviderManifest);
