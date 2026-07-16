import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const deepgramManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "deepgram",
    displayName: "Deepgram",
    source: "native",
    tier: "P0",
  },
  auth: {
    class: "api_key",
    fields: ["apiKey"],
  },
  endpoint: {
    baseUrl: "https://api.deepgram.com",
    baseUrlOverrideEnv: "EYEBALL_DEEPGRAM_BASE_URL",
  },
  implements: [
    {
      capability: "voice_telephony",
      canonicalTool: "transcribe_audio",
      canonicalVersion: "1.0.0",
      operationId: "listen.prerecorded",
    },
  ],
} as const satisfies ProviderManifest);
