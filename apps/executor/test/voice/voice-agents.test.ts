import { defaultCatalog } from "@eyeball/catalog";
import type {
  JsonValue,
  VoiceAgentSession,
  VoiceWorkerEventPage,
  VoiceWorkerStartSessionRequest,
  VoiceWorkerStopSessionRequest,
} from "@eyeball/core";
import {
  InMemoryAgentStore,
  TwilioAdapter,
  VoiceAgentsAdapter,
  type VoiceSessionDriver,
} from "@eyeball/toolkits";
import { describe, expect, it, vi } from "vitest";
import {
  createLiveKitMock,
  createPipecatMock,
  createTwilioMock,
} from "../../../../mocks/packages/mocks-voice/dist/index.js";
import { createVoiceSessionGrantAuthority } from "../../src/index.js";
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

const remoteAgentDraft = {
  ...agentDraft,
  tools: ["hubspot.search_contacts"],
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

class RecordingRemoteDriver implements VoiceSessionDriver {
  readonly starts: VoiceWorkerStartSessionRequest[] = [];
  readonly stops: string[] = [];
  readonly sessions = new Map<string, VoiceAgentSession>();
  beforeStart?: (request: VoiceWorkerStartSessionRequest) => Promise<void>;
  beforeStop?: (sessionId: string) => Promise<void>;
  replaceSessionId = false;
  failStart = false;
  failGet = false;

  async startSession(
    request: VoiceWorkerStartSessionRequest,
  ): Promise<VoiceAgentSession> {
    this.starts.push(structuredClone(request));
    await this.beforeStart?.(request);
    if (this.failStart) throw new Error("worker start failed");
    const session: VoiceAgentSession = {
      id: this.replaceSessionId
        ? "session_ffffffffffffffffffffffffffffffff"
        : request.sessionId,
      projectId: request.scope.projectId,
      userId: request.scope.userId,
      agentId: request.agent.id,
      agentRevision: request.agent.revision,
      transport: request.transport.kind === "twilio" ? "pstn:twilio" : "chat",
      state: "created",
      createdAt: "2026-07-21T10:00:00.000Z",
      lastEventSequence: 1,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async stopSession(
    sessionId: string,
    _request: VoiceWorkerStopSessionRequest,
  ): Promise<VoiceAgentSession> {
    await this.beforeStop?.(sessionId);
    this.stops.push(sessionId);
    return this.requireSession(sessionId);
  }

  async getSession(sessionId: string): Promise<VoiceAgentSession> {
    if (this.failGet) throw new Error("worker get failed");
    return this.requireSession(sessionId);
  }

  async getEvents(): Promise<VoiceWorkerEventPage> {
    return { events: [], nextSequence: 0, hasMore: false };
  }

  private requireSession(sessionId: string): VoiceAgentSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error("session missing");
    return structuredClone(session);
  }
}

describe("native voice-agents toolkit", () => {
  it("reserves executor-owned grant scope before remote start and revokes before stop", async () => {
    const store = new InMemoryAgentStore();
    const driver = new RecordingRemoteDriver();
    const issue = vi.fn(async (input: { sessionId: string }) => ({
      token: "evg1.test-session-grant.signature",
      grantId: "vsg_voice_agents_test",
      expiresAt: "2026-07-21T10:06:00.000Z",
      sessionId: input.sessionId,
    }));
    driver.beforeStart = async (request) => {
      await expect(
        store.getSession(
          request.scope.projectId,
          request.scope.userId,
          request.sessionId,
        ),
      ).resolves.toMatchObject({
        sessionId: request.sessionId,
        grantId: "vsg_voice_agents_test",
        grantExpiresAt: "2026-07-21T10:06:00.000Z",
      });
    };
    const harness = createVoiceMockHarness(
      createPipecatMock(),
      { type: "none" },
      {
        toolkitSlug: "voice-agents",
        adapter: new VoiceAgentsAdapter({
          store,
          sessionDriver: driver,
          voiceSessionGrantIssuer: { issue },
          resolveTool: (name) => defaultCatalog.getTool(name),
        }),
      },
    );
    const agent = object(
      output(
        await harness.execute("voice-agents.create_voice_agent", {
          agent: remoteAgentDraft,
        }),
      ).agent,
    );
    const started = output(
      await harness.execute(
        "voice-agents.start_agent_call",
        {
          agentId: String(agent.id),
          revision: 1,
          to: "+15550001111",
          from: "+15550002222",
          transportConnectionId: "conn_voice_test",
        },
        "async",
      ),
    );
    const sessionId = String(object(started.session).id);
    expect(sessionId).toMatch(/^session_[0-9a-f]{32}$/u);
    expect(driver.starts[0]).toMatchObject({
      sessionId,
      executorGrant: {
        token: "evg1.test-session-grant.signature",
        expiresAt: "2026-07-21T10:06:00.000Z",
      },
    });
    expect(issue).toHaveBeenCalledWith({
      projectId: "proj_voice_mocks",
      userId: "user_voice_mocks",
      sessionId,
      maxDurationSeconds: 300,
      allowedTools: ["hubspot.search_contacts"],
    });
    driver.beforeStop = async () => {
      await expect(
        store.getSession("proj_voice_mocks", "user_voice_mocks", sessionId),
      ).resolves.toMatchObject({
        grantRevokedAt: expect.any(String),
      });
    };
    output(
      await harness.execute("voice-agents.stop_agent_session", { sessionId }),
    );
    expect(driver.stops).toEqual([sessionId]);
  });

  it("revokes the durable grant before a failing worker session read", async () => {
    const store = new InMemoryAgentStore();
    const driver = new RecordingRemoteDriver();
    const authority = createVoiceSessionGrantAuthority({
      secret: "g".repeat(32),
      store,
      clock: { now: () => new Date("2026-07-21T10:00:00.000Z") },
    });
    const harness = createVoiceMockHarness(
      createPipecatMock(),
      { type: "none" },
      {
        toolkitSlug: "voice-agents",
        adapter: new VoiceAgentsAdapter({
          store,
          sessionDriver: driver,
          voiceSessionGrantIssuer: authority.issuer,
          resolveTool: (name) => defaultCatalog.getTool(name),
        }),
      },
    );
    const agent = object(
      output(
        await harness.execute("voice-agents.create_voice_agent", {
          agent: remoteAgentDraft,
        }),
      ).agent,
    );
    const started = output(
      await harness.execute(
        "voice-agents.start_agent_call",
        {
          agentId: String(agent.id),
          revision: 1,
          to: "+15550001111",
          from: "+15550002222",
          transportConnectionId: "conn_voice_test",
        },
        "async",
      ),
    );
    const sessionId = String(object(started.session).id);
    const token = driver.starts[0]?.executorGrant?.token;
    if (token === undefined) throw new Error("Expected a session grant.");
    expect((await authority.verifier.verify(token)).status).toBe("valid");

    driver.failGet = true;
    const stopped = await harness.execute("voice-agents.stop_agent_session", {
      sessionId,
    });
    expect(stopped.terminal.status).toBe("failed");
    await expect(authority.verifier.verify(token)).resolves.toEqual({
      status: "expired",
    });
    await expect(
      store.getSession("proj_voice_mocks", "user_voice_mocks", sessionId),
    ).resolves.toMatchObject({ grantRevokedAt: expect.any(String) });
  });

  it("revokes a reserved grant when remote start fails and keeps static mode grantless", async () => {
    const failedStore = new InMemoryAgentStore();
    const failedDriver = new RecordingRemoteDriver();
    failedDriver.failStart = true;
    const failedHarness = createVoiceMockHarness(
      createPipecatMock(),
      { type: "none" },
      {
        toolkitSlug: "voice-agents",
        adapter: new VoiceAgentsAdapter({
          store: failedStore,
          sessionDriver: failedDriver,
          voiceSessionGrantIssuer: {
            issue: async () => ({
              token: `evg1.${"g".repeat(32)}.${"s".repeat(32)}`,
              grantId: "vsg_failed_voice_agents_test",
              expiresAt: "2026-07-21T10:06:00.000Z",
            }),
          },
          resolveTool: (name) => defaultCatalog.getTool(name),
        }),
      },
    );
    const failedAgent = object(
      output(
        await failedHarness.execute("voice-agents.create_voice_agent", {
          agent: remoteAgentDraft,
        }),
      ).agent,
    );
    const failed = await failedHarness.execute(
      "voice-agents.start_agent_call",
      {
        agentId: String(failedAgent.id),
        revision: 1,
        to: "+15550001111",
        from: "+15550002222",
        transportConnectionId: "conn_voice_test",
      },
      "async",
    );
    expect(failed.terminal.status).toBe("failed");
    const [failedPointer] = await failedStore.listSessions(
      "proj_voice_mocks",
      "user_voice_mocks",
    );
    expect(failedPointer).toMatchObject({
      grantId: "vsg_failed_voice_agents_test",
      grantRevokedAt: expect.any(String),
    });

    const staticStore = new InMemoryAgentStore();
    const staticDriver = new RecordingRemoteDriver();
    const staticHarness = createVoiceMockHarness(
      createPipecatMock(),
      { type: "none" },
      {
        toolkitSlug: "voice-agents",
        adapter: new VoiceAgentsAdapter({
          store: staticStore,
          sessionDriver: staticDriver,
          resolveTool: (name) => defaultCatalog.getTool(name),
        }),
      },
    );
    const staticAgent = object(
      output(
        await staticHarness.execute("voice-agents.create_voice_agent", {
          agent: remoteAgentDraft,
        }),
      ).agent,
    );
    output(
      await staticHarness.execute(
        "voice-agents.start_agent_call",
        {
          agentId: String(staticAgent.id),
          revision: 1,
          to: "+15550001111",
          from: "+15550002222",
          transportConnectionId: "conn_voice_test",
        },
        "async",
      ),
    );
    expect(staticDriver.starts[0]).not.toHaveProperty("executorGrant");
    const [staticPointer] = await staticStore.listSessions(
      "proj_voice_mocks",
      "user_voice_mocks",
    );
    expect(staticPointer).not.toHaveProperty("grantId");

    const failedStaticStore = new InMemoryAgentStore();
    const failedStaticDriver = new RecordingRemoteDriver();
    failedStaticDriver.failStart = true;
    const failedStaticHarness = createVoiceMockHarness(
      createPipecatMock(),
      { type: "none" },
      {
        toolkitSlug: "voice-agents",
        adapter: new VoiceAgentsAdapter({
          store: failedStaticStore,
          sessionDriver: failedStaticDriver,
          resolveTool: (name) => defaultCatalog.getTool(name),
        }),
      },
    );
    const failedStaticAgent = object(
      output(
        await failedStaticHarness.execute("voice-agents.create_voice_agent", {
          agent: remoteAgentDraft,
        }),
      ).agent,
    );
    const failedStatic = await failedStaticHarness.execute(
      "voice-agents.start_agent_call",
      {
        agentId: String(failedStaticAgent.id),
        revision: 1,
        to: "+15550001111",
        from: "+15550002222",
        transportConnectionId: "conn_voice_test",
      },
      "async",
    );
    expect(failedStatic.terminal.status).toBe("failed");
    await expect(
      failedStaticStore.listSessions("proj_voice_mocks", "user_voice_mocks"),
    ).resolves.toEqual([]);
  });

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
