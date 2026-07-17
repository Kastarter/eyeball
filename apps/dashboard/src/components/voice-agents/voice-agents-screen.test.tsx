import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type VoiceAgentDefinition,
  type VoiceAgentSummary,
  VoiceAgentsScreen,
} from "./voice-agents-screen";

const summary = {
  activeRevision: 3,
  createdAt: "2026-07-17T09:00:00.000Z",
  id: "vag_table_host",
  name: "Table Host",
  transport: "pstn:twilio",
  updatedAt: "2026-07-17T11:00:00.000Z",
} as const satisfies VoiceAgentSummary;

const definition = {
  createdAt: "2026-07-17T11:00:00.000Z",
  guardrails: {
    handoffToHuman: { enabled: false },
    maxDurationSeconds: 900,
  },
  id: summary.id,
  llm: { model: "model:fixture:restaurant-concierge" },
  name: summary.name,
  recordingPolicy: {
    consent: "agent_announcement",
    mode: "audio_and_transcript",
    redactDtmf: true,
    retentionDays: 7,
  },
  revision: summary.activeRevision,
  systemPrompt: "Confirm the reservation details, then use the allowed tools.",
  tools: ["google-calendar.create_event", "gmail.send_email"],
  transport: summary.transport,
  voice: {
    stt: { model: "nova-3", provider: "deepgram" },
    tts: { provider: "elevenlabs", voiceId: "voice_fixture_warm_host" },
  },
  webhooks: { endpointIds: [], events: [], transcript: true },
} as const satisfies VoiceAgentDefinition;

const catalogTools = [
  {
    capability: "Create event",
    name: "google-calendar.create_event",
    toolkit: "google-calendar",
  },
  { capability: "Send email", name: "gmail.send_email", toolkit: "gmail" },
  {
    capability: "List agents",
    name: "voice-agents.list_voice_agents",
    toolkit: "voice-agents",
  },
] as const;

describe("VoiceAgentsScreen server rendering", () => {
  it("renders the registry, immutable revisions, builder, and live test panel", () => {
    const markup = renderToStaticMarkup(
      <VoiceAgentsScreen
        initialAgents={[summary]}
        initialDefinitions={{
          [`${summary.id}:${summary.activeRevision}`]: definition,
        }}
        initialRevision={summary.activeRevision}
        initialSelectedAgent={summary.id}
        project="restaurant-demo"
        tools={catalogTools}
      />,
    );

    expect(markup).toContain("Voice Agents");
    expect(markup).toContain("Agent registry");
    expect(markup).toContain("PSTN · Twilio");
    expect(markup).toContain("Edit as new revision");
    expect(markup).toContain("Revision history");
    expect(markup).toContain("r1");
    expect(markup).toContain("r2");
    expect(markup).toContain("r3");
    expect(markup).toContain("Canonical tool allowlist");
    expect(markup).toContain("google-calendar.create_event");
    expect(markup).toContain("gmail.send_email");
    expect(markup).not.toContain("voice-agents.list_voice_agents");
    expect(markup).toContain("Live test panel");
    expect(markup).toContain("Start test call");
  });

  it("renders the create-state reservation fixture without an executor response", () => {
    const markup = renderToStaticMarkup(
      <VoiceAgentsScreen
        initialAgents={[]}
        project="restaurant-demo"
        tools={catalogTools}
      />,
    );

    expect(markup).toContain("Create your first agent");
    expect(markup).toContain("Create voice agent");
    expect(markup).toContain("model:fixture:restaurant-concierge");
    expect(markup).toContain("Maximum duration (seconds)");
    expect(markup).toContain("Ready for a test session");
  });
});
