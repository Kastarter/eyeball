import { describe, expect, it } from "vitest";
import {
  VOICE_AGENT_MAX_DURATION_SECONDS,
  type VoiceAgentDraft,
  validateVoiceAgentDraft,
} from "../src/index.js";

const draft = {
  name: "Bounded session",
  systemPrompt: "Keep the call concise.",
  llm: { model: "model:test" },
  voice: {
    tts: { provider: "elevenlabs", voiceId: "voice_test" },
    stt: { provider: "deepgram" },
  },
  transport: "chat",
  tools: [],
  guardrails: {
    maxDurationSeconds: VOICE_AGENT_MAX_DURATION_SECONDS,
    handoffToHuman: { enabled: false },
  },
  webhooks: { endpointIds: [], transcript: false, events: [] },
  recordingPolicy: {
    mode: "disabled",
    consent: "external",
    retentionDays: 0,
    redactDtmf: true,
  },
} as const satisfies VoiceAgentDraft;

describe("voice-agent schemas", () => {
  it("accepts the session-duration ceiling and rejects one second above it", () => {
    expect(validateVoiceAgentDraft(draft).ok).toBe(true);
    expect(
      validateVoiceAgentDraft({
        ...draft,
        guardrails: {
          ...draft.guardrails,
          maxDurationSeconds: VOICE_AGENT_MAX_DURATION_SECONDS + 1,
        },
      }),
    ).toMatchObject({
      ok: false,
      errors: [
        {
          instancePath: "/guardrails/maxDurationSeconds",
          keyword: "maximum",
        },
      ],
    });
  });
});
