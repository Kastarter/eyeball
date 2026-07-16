import { validateInput } from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  deepgramManifest,
  defaultCatalog,
  elevenLabsManifest,
  liveKitManifest,
  pipecatManifest,
  twilioManifest,
  voiceAgentCapabilityContracts,
  voiceAgentContractsByName,
  voiceAgentsManifest,
  voiceCapabilityContracts,
  voiceContractsByName,
} from "../src/index.js";

const canonicalVoiceTools = [
  "start_call",
  "get_call",
  "list_calls",
  "end_call",
  "transfer_call",
  "send_dtmf",
  "create_room",
  "join_room",
  "synthesize_speech",
  "transcribe_audio",
  "start_voice_pipeline",
  "get_voice_pipeline",
] as const;

const voiceAgentTools = [
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

describe("voice capability contracts and manifests", () => {
  it("publishes all 12 canonical and 11 native voice-agent contracts", () => {
    expect(voiceCapabilityContracts.map(({ name }) => name)).toEqual(
      canonicalVoiceTools,
    );
    expect(voiceAgentCapabilityContracts.map(({ name }) => name)).toEqual(
      voiceAgentTools,
    );
    expect(
      defaultCatalog.listContracts({ capability: "voice_telephony" }),
    ).toHaveLength(23);
  });

  it("marks only naturally asynchronous voice operations as async", () => {
    expect(
      voiceCapabilityContracts
        .filter(({ annotations }) => annotations.async)
        .map(({ name }) => name),
    ).toEqual(["start_call", "start_voice_pipeline"]);
    expect(
      voiceAgentCapabilityContracts
        .filter(({ annotations }) => annotations.async)
        .map(({ name }) => name),
    ).toEqual(["start_agent_call", "send_session_message"]);
  });

  it("enforces E.164 inputs and practical audio references", () => {
    expect(
      validateInput(voiceContractsByName.start_call, {
        to: "+15550001111",
        from: "+15550002222",
      }).ok,
    ).toBe(true);
    expect(
      validateInput(voiceContractsByName.start_call, {
        to: "555-000-1111",
        from: "+15550002222",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateInput(voiceContractsByName.transcribe_audio, {
        audioRef: "fixture:audio:hello",
      }).ok,
    ).toBe(true);
    expect(
      validateInput(voiceAgentContractsByName.start_agent_call, {
        agentId: "va_000001",
        to: "+15550001111",
      }).ok,
    ).toBe(true);
  });

  it("materializes the provider subsets with the declared auth classes", () => {
    expect(
      defaultCatalog
        .listTools({ capability: "voice_telephony" })
        .map(({ name }) => name),
    ).toHaveLength(23);
    expect(twilioManifest.auth).toEqual({
      class: "basic",
      fields: ["accountSid", "authToken"],
    });
    expect(liveKitManifest.auth.class).toBe("api_key");
    expect(elevenLabsManifest.auth.class).toBe("api_key");
    expect(deepgramManifest.auth.class).toBe("api_key");
    expect(pipecatManifest.auth.class).toBe("none");
    expect(voiceAgentsManifest.auth.class).toBe("none");
    expect(voiceAgentsManifest.toolkit.source).toBe("native");
  });

  it("declares a mock-overridable endpoint for every voice toolkit", () => {
    for (const manifest of [
      twilioManifest,
      liveKitManifest,
      elevenLabsManifest,
      deepgramManifest,
      pipecatManifest,
      voiceAgentsManifest,
    ]) {
      expect(manifest.endpoint.baseUrlOverrideEnv).toMatch(
        /^EYEBALL_[A-Z0-9_]+_BASE_URL$/u,
      );
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest.implements)).toBe(true);
    }
  });
});
