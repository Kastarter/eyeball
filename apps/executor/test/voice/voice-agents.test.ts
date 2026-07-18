import type { JsonValue } from "@eyeball/core";
import {
  InMemoryAgentStore,
  TwilioAdapter,
  VoiceAgentsAdapter,
} from "@eyeball/toolkits";
import { describe, expect, it } from "vitest";
import {
  createLiveKitMock,
  createPipecatMock,
  createTwilioMock,
} from "../../../../mocks/packages/mocks-voice/dist/index.js";
import { createVoiceMockHarness, output } from "./helpers.js";

const agentDraft = {
  name: "Reservation host",
  systemPrompt: "Help callers reserve a table and confirm every detail.",
  llm: { model: "model:fixture:concierge", temperature: 0.2 },
  voice: {
    tts: {
      provider: "elevenlabs",
      voiceId: "voice_fixture_aria",
      stability: 0.6,
    },
    stt: {
      provider: "deepgram",
      model: "nova-3",
      language: "en",
      smartFormat: true,
    },
  },
  transport: "pstn:twilio",
  tools: ["crm.search_contacts"],
  guardrails: {
    maxDurationSeconds: 300,
    handoffToHuman: { enabled: false },
  },
  webhooks: {
    endpointIds: [],
    transcript: true,
    events: ["session.lifecycle", "turn.transcript", "tool_call"],
  },
  recordingPolicy: {
    mode: "audio_and_transcript",
    consent: "agent_announcement",
    retentionDays: 30,
    redactDtmf: true,
  },
} as const;

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object, received ${JSON.stringify(value)}.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function objects(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected an array, received ${JSON.stringify(value)}.`);
  }
  return value.map(object);
}

describe("native voice-agents toolkit", () => {
  it("runs the full immutable-agent and Pipecat session lifecycle", async () => {
    const provider = createPipecatMock();
    const harness = createVoiceMockHarness(
      provider,
      { type: "none" },
      {
        toolkitSlug: "voice-agents",
        adapter: new VoiceAgentsAdapter(),
      },
    );

    const created = object(
      output(
        await harness.execute("voice-agents.create_voice_agent", {
          agent: agentDraft,
        }),
      ).agent,
    );
    expect(created).toMatchObject({
      id: expect.stringMatching(/^va_/u),
      revision: 1,
      name: "Reservation host",
      systemPrompt: agentDraft.systemPrompt,
    });
    const agentId = String(created.id);

    expect(
      object(
        output(
          await harness.execute("voice-agents.get_voice_agent", {
            agentId,
            revision: 1,
          }),
        ).agent,
      ),
    ).toEqual(created);

    const updatedDraft = {
      ...agentDraft,
      systemPrompt:
        "Help callers reserve a table, check availability, and confirm every detail.",
    };
    const updated = object(
      output(
        await harness.execute("voice-agents.update_voice_agent", {
          agentId,
          expectedRevision: 1,
          agent: updatedDraft,
        }),
      ).agent,
    );
    expect(updated).toMatchObject({
      id: agentId,
      revision: 2,
      systemPrompt: updatedDraft.systemPrompt,
    });

    const summaries = objects(
      output(await harness.execute("voice-agents.list_voice_agents", {}))
        .agents,
    );
    expect(summaries).toEqual([
      expect.objectContaining({
        id: agentId,
        activeRevision: 2,
        name: "Reservation host",
        transport: "pstn:twilio",
      }),
    ]);
    expect(summaries[0]).not.toHaveProperty("systemPrompt");
    expect(summaries[0]).not.toHaveProperty("llm");
    expect(summaries[0]).not.toHaveProperty("voice");

    expect(
      output(
        await harness.execute("voice-agents.attach_agent_to_number", {
          agentId,
          revision: 2,
          phoneNumber: "+15550002222",
          transportConnectionId: "conn_twilio_fixture",
        }),
      ),
    ).toMatchObject({
      bindingId: expect.stringMatching(/^binding_/u),
      agentId,
      revision: 2,
      phoneNumber: "+15550002222",
    });

    const started = await harness.execute(
      "voice-agents.start_agent_call",
      {
        agentId,
        revision: 2,
        to: "+15550001111",
        script: [
          { caller: "I need a table for two tonight." },
          {
            expect_tool_call: "crm.search_contacts",
            input: { phoneNumber: "+15550001111" },
            result: { contactId: "contact_fixture" },
          },
        ],
      },
      "async",
    );
    expect(started.initialStatus).toBe(202);
    expect(started.initial.status).toBe("pending");
    const allocated = output(started);
    const createdSession = object(allocated.session);
    expect(createdSession).toMatchObject({
      agentId,
      agentRevision: 2,
      projectId: "proj_voice_mocks",
      userId: "user_voice_mocks",
      transport: "pstn:twilio",
      state: "created",
    });
    expect(allocated.callId).toBe(`call_${String(createdSession.id)}`);
    const sessionId = String(createdSession.id);

    provider.advanceClock(2_000);
    const activePage = output(
      await harness.execute("voice-agents.get_agent_session", {
        sessionId,
      }),
    );
    expect(object(activePage.session)).toMatchObject({
      state: "in-progress",
      agentRevision: 2,
    });
    expect(
      objects(activePage.events).map((event) => object(event.data).type),
    ).toEqual([
      "session.lifecycle",
      "session.lifecycle",
      "session.lifecycle",
      "turn.transcript",
    ]);
    expect(
      objects(activePage.events)
        .map((event) => object(event.data))
        .find((data) => data.type === "turn.transcript"),
    ).toMatchObject({
      speaker: "human",
      text: "I need a table for two tonight.",
    });

    const messaged = await harness.execute(
      "voice-agents.send_session_message",
      {
        agentId,
        revision: 2,
        sessionId,
        message: "I’ll check your existing contact before searching tables.",
        clientMessageId: "client_message_001",
      },
      "async",
    );
    expect(messaged.initialStatus).toBe(202);
    expect(output(messaged)).toMatchObject({
      userMessageId: expect.stringMatching(/^turn_/u),
      assistantMessage:
        "I’ll check your existing contact before searching tables.",
      session: expect.objectContaining({ state: "in-progress" }),
    });

    const toolPage = output(
      await harness.execute("voice-agents.get_agent_session", {
        sessionId,
        afterSequence: Number(activePage.nextSequence),
      }),
    );
    expect(
      objects(toolPage.events).map((event) => object(event.data).type),
    ).toEqual(["turn.transcript", "tool_call"]);
    expect(object(objects(toolPage.events)[1]?.data)).toMatchObject({
      type: "tool_call",
      tool: "crm.search_contacts",
      input: { phoneNumber: "+15550001111" },
      executionId: expect.stringMatching(/^exe_/u),
    });

    const partialArtifact = object(
      output(
        await harness.execute("voice-agents.get_session_transcript", {
          sessionId,
          includePartial: true,
        }),
      ).artifact,
    );
    expect(partialArtifact).toMatchObject({ final: false, language: "en" });
    const partialTurns = objects(partialArtifact.turns);
    expect(partialTurns.map(({ speaker }) => speaker)).toEqual([
      "human",
      "agent",
      "tool",
    ]);
    expect(partialTurns[2]).toMatchObject({
      speaker: "tool",
      tool: "crm.search_contacts",
      executionId: expect.stringMatching(/^exe_/u),
      text: expect.stringContaining('"type":"tool_call"'),
    });

    const listedSessions = objects(
      output(
        await harness.execute("voice-agents.list_agent_sessions", {
          agentId,
        }),
      ).sessions,
    );
    expect(listedSessions).toEqual([
      expect.objectContaining({ id: sessionId, agentRevision: 2 }),
    ]);

    const stopping = output(
      await harness.execute("voice-agents.stop_agent_session", {
        sessionId,
        reason: "Reservation flow complete.",
      }),
    );
    expect(object(stopping.session)).toMatchObject({ state: "in-progress" });
    provider.advanceClock(2_000);

    const completed = output(
      await harness.execute("voice-agents.get_agent_session", { sessionId }),
    );
    expect(object(completed.session)).toMatchObject({
      state: "completed",
      completedAt: expect.any(String),
    });
    const finalArtifact = object(
      output(
        await harness.execute("voice-agents.get_session_transcript", {
          sessionId,
        }),
      ).artifact,
    );
    expect(finalArtifact).toMatchObject({
      id: `transcript_${sessionId}`,
      final: true,
      endedAt: expect.any(String),
    });
    expect(objects(finalArtifact.turns)).toEqual(partialTurns);

    const deleted = output(
      await harness.execute("voice-agents.delete_voice_agent", {
        agentId,
        expectedRevision: 2,
      }),
    );
    expect(deleted).toMatchObject({ agentId, deletedAt: expect.any(String) });
    expect(
      output(
        await harness.execute("voice-agents.delete_voice_agent", {
          agentId,
          expectedRevision: 2,
        }),
      ),
    ).toEqual(deleted);
    expect(
      object(
        output(
          await harness.execute("voice-agents.get_voice_agent", {
            agentId,
            revision: 1,
          }),
        ).agent,
      ),
    ).toEqual(created);
    expect(
      output(await harness.execute("voice-agents.list_voice_agents", {}))
        .agents,
    ).toEqual([]);
    expect(
      objects(
        output(
          await harness.execute("voice-agents.list_voice_agents", {
            includeDeleted: true,
          }),
        ).agents,
      )[0],
    ).toMatchObject({ id: agentId, deletedAt: deleted.deletedAt });
  });

  it("creates a LiveKit web session with an end-user-only join grant", async () => {
    const pipecat = createPipecatMock();
    const liveKit = createLiveKitMock();
    const liveKitHarness = createVoiceMockHarness(liveKit, {
      type: "api_key",
      values: {
        apiKey: "fixture:valid",
        apiSecret: "fixture:provider-secret",
      },
    });
    const harness = createVoiceMockHarness(
      pipecat,
      { type: "none" },
      {
        toolkitSlug: "voice-agents",
        adapter: new VoiceAgentsAdapter({
          executeProviderTool: async (request) =>
            output(
              await liveKitHarness.execute(request.tool, request.input),
            ) as JsonValue,
        }),
      },
    );
    const created = object(
      output(
        await harness.execute("voice-agents.create_voice_agent", {
          agent: {
            ...agentDraft,
            name: "Browser reservation host",
            transport: "webrtc:livekit",
          },
        }),
      ).agent,
    );
    const agentId = String(created.id);

    const started = await harness.execute(
      "voice-agents.create_web_session",
      {
        agentId,
        revision: 1,
        transportConnectionId: "conn_livekit_fixture",
        participantIdentity: "web-user-001",
        participantName: "Web User",
        metadata: { channel: "browser" },
        script: [{ caller: "I need a browser reservation." }],
      },
      "async",
    );
    expect(started.initialStatus).toBe(202);
    const allocated = output(started);
    const session = object(allocated.session);
    expect(session).toMatchObject({
      agentId,
      agentRevision: 1,
      transport: "webrtc:livekit",
      state: "created",
    });
    const joinGrant = object(allocated.joinGrant);
    expect(joinGrant).toEqual({
      roomUrl: expect.stringMatching(/^http:\/\/mocks\.local\/livekit\/?$/u),
      participantToken: expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/u),
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(joinGrant)).not.toContain("fixture:provider-secret");

    const tokenParts = String(joinGrant.participantToken).split(".");
    const tokenPayload = object(
      JSON.parse(
        Buffer.from(String(tokenParts[1]), "base64url").toString("utf8"),
      ) as unknown,
    );
    expect(tokenPayload).toMatchObject({
      sub: "web-user-001",
      video: expect.objectContaining({ roomJoin: true }),
    });
    expect(JSON.stringify(tokenPayload)).not.toContain("provider-secret");
    expect(Date.parse(String(joinGrant.expiresAt))).toBe(
      Number(tokenPayload.iat) * 1_000 + 3_600_000,
    );

    pipecat.advanceClock(2_000);
    const active = output(
      await harness.execute("voice-agents.get_agent_session", {
        sessionId: String(session.id),
      }),
    );
    expect(object(active.session)).toMatchObject({ state: "in-progress" });
    expect(
      objects(active.events).map((event) => object(event.data).type),
    ).toContain("turn.transcript");

    const stopping = output(
      await harness.execute("voice-agents.stop_agent_session", {
        sessionId: String(session.id),
        reason: "Web client disconnected.",
      }),
    );
    expect(object(stopping.session)).toMatchObject({ state: "in-progress" });
    pipecat.advanceClock(2_000);
    const transcript = object(
      output(
        await harness.execute("voice-agents.get_session_transcript", {
          sessionId: String(session.id),
        }),
      ).artifact,
    );
    expect(transcript).toMatchObject({
      final: true,
      transport: "webrtc:livekit",
      endedAt: expect.any(String),
    });
    expect(objects(transcript.turns)).toEqual([
      expect.objectContaining({
        speaker: "human",
        text: "I need a browser reservation.",
      }),
    ]);
  });

  it("enforces owned-number detach, reassign, and release lifecycle", async () => {
    const pipecat = createPipecatMock();
    const twilio = createTwilioMock();
    const store = new InMemoryAgentStore();
    const twilioHarness = createVoiceMockHarness(
      twilio,
      {
        type: "basic",
        username: "ACfixture",
        password: "fixture:valid",
      },
      {
        toolkitSlug: "twilio",
        adapter: new TwilioAdapter({ bindingLookup: store }),
      },
    );
    const harness = createVoiceMockHarness(
      pipecat,
      { type: "none" },
      {
        toolkitSlug: "voice-agents",
        adapter: new VoiceAgentsAdapter({
          store,
          executeProviderTool: async (request) =>
            output(
              await twilioHarness.execute(request.tool, request.input),
            ) as JsonValue,
        }),
      },
    );
    const phoneNumber = "+15550004444";
    const connectionId = "conn_twilio_fixture";

    const bought = object(
      output(
        await harness.execute("voice-agents.buy_number", {
          phoneNumber,
          friendlyName: "Lifecycle line",
          transportConnectionId: connectionId,
        }),
      ).number,
    );
    expect(bought).toMatchObject({
      phoneNumber,
      provider: "twilio",
      bindingStatus: "unbound",
    });

    const firstAgent = object(
      output(
        await harness.execute("voice-agents.create_voice_agent", {
          agent: { ...agentDraft, name: "First number owner" },
        }),
      ).agent,
    );
    const secondAgent = object(
      output(
        await harness.execute("voice-agents.create_voice_agent", {
          agent: { ...agentDraft, name: "Second number owner" },
        }),
      ).agent,
    );
    const attach = (agentId: string) =>
      harness.execute("voice-agents.attach_agent_to_number", {
        agentId,
        revision: 1,
        phoneNumber,
        transportConnectionId: connectionId,
      });
    output(await attach(String(firstAgent.id)));

    expect(
      object(
        objects(
          output(await twilioHarness.execute("twilio.list_numbers", {}))
            .numbers,
        )[0],
      ),
    ).toMatchObject({
      phoneNumber,
      bindingStatus: "bound",
      binding: { agentId: firstAgent.id },
    });
    const directBoundRelease = await twilioHarness.execute(
      "twilio.release_number",
      { phoneNumber },
    );
    expect(directBoundRelease.terminal).toMatchObject({
      status: "failed",
      error: {
        code: "invalid_input",
        message: expect.stringContaining("detach_number"),
      },
    });

    const conflict = await attach(String(secondAgent.id));
    expect(conflict.terminal).toMatchObject({
      status: "failed",
      error: {
        code: "invalid_input",
        message: expect.stringContaining("already has a different"),
      },
    });
    const boundRelease = await harness.execute("voice-agents.release_number", {
      phoneNumber,
      transportConnectionId: connectionId,
    });
    expect(boundRelease.terminal).toMatchObject({
      status: "failed",
      error: {
        code: "invalid_input",
        message: expect.stringContaining("detach_number"),
      },
    });

    expect(
      output(
        await harness.execute("voice-agents.detach_number", { phoneNumber }),
      ),
    ).toMatchObject({
      phoneNumber,
      bindingStatus: "unbound",
      detachedBindingId: expect.stringMatching(/^binding_/u),
    });
    output(await attach(String(secondAgent.id)));
    const rebound = object(
      objects(
        output(
          await harness.execute("voice-agents.list_numbers", {
            transportConnectionId: connectionId,
          }),
        ).numbers,
      )[0],
    );
    expect(rebound).toMatchObject({
      phoneNumber,
      bindingStatus: "bound",
      binding: {
        agentId: secondAgent.id,
        revision: 1,
        transportConnectionId: connectionId,
      },
    });

    output(
      await harness.execute("voice-agents.detach_number", { phoneNumber }),
    );
    expect(
      output(
        await harness.execute("voice-agents.release_number", {
          phoneNumber,
          transportConnectionId: connectionId,
        }),
      ),
    ).toMatchObject({
      numberId: bought.numberId,
      phoneNumber,
      releasedAt: expect.any(String),
    });
    expect(
      output(
        await harness.execute("voice-agents.list_numbers", {
          transportConnectionId: connectionId,
        }),
      ).numbers,
    ).toEqual([]);
  });
});
