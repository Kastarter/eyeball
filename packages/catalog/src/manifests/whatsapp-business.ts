import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const whatsAppBusinessManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "whatsapp-business",
    displayName: "WhatsApp Business Cloud",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "api_key",
    fields: ["apiKey", "phoneNumberId"],
  },
  endpoint: {
    baseUrl: "https://graph.facebook.com",
    baseUrlOverrideEnv: "EYEBALL_WHATSAPP_BUSINESS_BASE_URL",
  },
  implements: [
    {
      capability: "messaging_chat",
      canonicalTool: "send_message",
      canonicalVersion: "1.0.0",
      operationId: "messages.send",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "get_message",
      canonicalVersion: "1.0.0",
      operationId: "messages.get",
    },
  ],
} as const satisfies ProviderManifest);
