import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

const operations = [
  "create_voice_agent",
  "get_voice_agent",
  "list_voice_agents",
  "update_voice_agent",
  "delete_voice_agent",
  "start_agent_call",
  "attach_agent_to_number",
  "get_agent_session",
  "list_agent_sessions",
  "get_session_transcript",
  "send_session_message",
] as const;

/** RFC 002 native management toolkit backed by Eyeball's Pipecat runtime. */
export const voiceAgentsManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.1",
  toolkit: {
    slug: "voice-agents",
    displayName: "Voice Agents",
    source: "native",
    tier: "P0",
  },
  auth: { class: "none" },
  endpoint: {
    baseUrl: "http://127.0.0.1:8080",
    baseUrlOverrideEnv: "EYEBALL_VOICE_AGENTS_BASE_URL",
  },
  implements: operations.map((operation) => ({
    capability: "voice_telephony",
    canonicalTool: operation,
    canonicalVersion: "1.0.0",
    operationId: `voiceAgents.${operation}`,
  })),
} as const satisfies ProviderManifest);
