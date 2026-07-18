import { VoiceAgentsAdapter } from "@eyeball/toolkits";
import { describe, expect, it } from "vitest";
import { createPipecatMock } from "../../../../mocks/packages/mocks-voice/dist/index.js";
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
        from: "+15550002222",
        transportConnectionId: "conn_twilio_fixture",
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

    const endResponse = await provider.app.request(
      `/sessions/${encodeURIComponent(sessionId)}/end`,
      {
        method: "POST",
        headers: { Authorization: "Bearer fixture:valid" },
      },
    );
    expect(endResponse.status).toBe(200);
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
});
