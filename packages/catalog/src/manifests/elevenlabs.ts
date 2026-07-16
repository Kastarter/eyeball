import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const elevenLabsManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "elevenlabs",
    displayName: "ElevenLabs",
    source: "native",
    tier: "P0",
  },
  auth: {
    class: "api_key",
    fields: ["apiKey"],
  },
  endpoint: {
    baseUrl: "https://api.elevenlabs.io",
    baseUrlOverrideEnv: "EYEBALL_ELEVENLABS_BASE_URL",
  },
  implements: [
    {
      capability: "voice_telephony",
      canonicalTool: "synthesize_speech",
      canonicalVersion: "1.0.0",
      operationId: "textToSpeech.convert",
    },
  ],
} as const satisfies ProviderManifest);
