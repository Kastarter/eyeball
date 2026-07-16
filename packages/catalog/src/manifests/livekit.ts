import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const liveKitManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "livekit",
    displayName: "LiveKit",
    source: "native",
    tier: "P0",
  },
  auth: {
    class: "api_key",
    fields: ["apiKey", "apiSecret"],
  },
  endpoint: {
    baseUrl: "https://api.livekit.io",
    baseUrlOverrideEnv: "EYEBALL_LIVEKIT_BASE_URL",
  },
  implements: [
    {
      capability: "voice_telephony",
      canonicalTool: "create_room",
      canonicalVersion: "1.0.0",
      operationId: "RoomService.CreateRoom",
    },
    {
      capability: "voice_telephony",
      canonicalTool: "join_room",
      canonicalVersion: "1.0.0",
      operationId: "RoomService.CreateTokenAndJoin",
    },
  ],
} as const satisfies ProviderManifest);
