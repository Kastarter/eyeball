import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const twilioManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "twilio",
    displayName: "Twilio",
    source: "native",
    tier: "P0",
  },
  auth: {
    class: "basic",
    fields: ["accountSid", "authToken"],
  },
  endpoint: {
    baseUrl: "https://api.twilio.com",
    baseUrlOverrideEnv: "EYEBALL_TWILIO_BASE_URL",
  },
  implements: [
    {
      capability: "voice_telephony",
      canonicalTool: "start_call",
      canonicalVersion: "1.0.0",
      operationId: "Calls.create",
    },
    {
      capability: "voice_telephony",
      canonicalTool: "get_call",
      canonicalVersion: "1.0.0",
      operationId: "Calls.fetch",
    },
    {
      capability: "voice_telephony",
      canonicalTool: "list_calls",
      canonicalVersion: "1.0.0",
      operationId: "Calls.list",
    },
    {
      capability: "voice_telephony",
      canonicalTool: "end_call",
      canonicalVersion: "1.0.0",
      operationId: "Calls.update.completed",
    },
    {
      capability: "voice_telephony",
      canonicalTool: "transfer_call",
      canonicalVersion: "1.0.0",
      operationId: "Calls.update.transfer",
    },
    {
      capability: "voice_telephony",
      canonicalTool: "send_dtmf",
      canonicalVersion: "1.0.0",
      operationId: "Calls.update.dtmf",
    },
  ],
} as const satisfies ProviderManifest);
