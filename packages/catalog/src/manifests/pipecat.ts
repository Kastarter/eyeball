import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const pipecatManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "pipecat",
    displayName: "Pipecat",
    source: "native",
    tier: "P0",
  },
  auth: { class: "none" },
  endpoint: {
    baseUrl: "http://127.0.0.1:8080",
    baseUrlOverrideEnv: "EYEBALL_PIPECAT_BASE_URL",
  },
  implements: [
    {
      capability: "voice_telephony",
      canonicalTool: "start_voice_pipeline",
      canonicalVersion: "1.0.0",
      operationId: "sessions.create",
    },
    {
      capability: "voice_telephony",
      canonicalTool: "get_voice_pipeline",
      canonicalVersion: "1.0.0",
      operationId: "sessions.get",
    },
  ],
} as const satisfies ProviderManifest);
