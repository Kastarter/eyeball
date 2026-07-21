import type { VoiceAgentDraft } from "@eyeball/core";
import { expect, it } from "vitest";
import {
  createPgliteStoreBundle,
  PostgresVoiceSessionObserverStore,
  PostgresVoiceWebhookSourceStore,
} from "../src/index.js";

const draft: VoiceAgentDraft = {
  name: "Observer race agent",
  systemPrompt: "Keep observer ownership fenced.",
  llm: { model: "model:observer-race" },
  voice: {
    tts: { provider: "elevenlabs", voiceId: "voice_observer_race" },
    stt: { provider: "deepgram" },
  },
  transport: "chat",
  tools: [],
  guardrails: {
    maxDurationSeconds: 300,
    handoffToHuman: { enabled: false },
  },
  webhooks: { endpointIds: [], transcript: true, events: [] },
  recordingPolicy: {
    mode: "disabled",
    consent: "external",
    retentionDays: 0,
    redactDtmf: true,
  },
};

it("fences concurrent observer owners and source admissions", async () => {
  const bundle = await createPgliteStoreBundle();
  try {
    const projectId = "project_observer_race";
    const userId = "user_observer_race";
    const sessionId = "session_observer_race";
    const now = "2026-07-21T12:00:00.000Z";
    const agent = await bundle.agentStore.createAgent(projectId, draft, now);
    const pointer = {
      sessionId,
      projectId,
      userId,
      agentId: agent.id,
      agentRevision: agent.revision,
      callId: `call_${sessionId}`,
      createdAt: now,
    };
    await bundle.agentStore.rememberSession(pointer);
    const firstObserver = new PostgresVoiceSessionObserverStore(
      bundle.database,
    );
    const secondObserver = new PostgresVoiceSessionObserverStore(
      bundle.database,
    );
    await firstObserver.ensurePrepared(pointer, now);
    await firstObserver.activatePrepared(sessionId, now);

    const [firstClaims, secondClaims] = await Promise.all([
      firstObserver.claim({
        leaseOwner: "observer-a",
        now,
        leaseExpiresAt: "2026-07-21T12:01:00.000Z",
        limit: 1,
      }),
      secondObserver.claim({
        leaseOwner: "observer-b",
        now,
        leaseExpiresAt: "2026-07-21T12:01:00.000Z",
        limit: 1,
      }),
    ]);
    expect(firstClaims.length + secondClaims.length).toBe(1);
    const original = firstClaims[0] ?? secondClaims[0];
    if (original === undefined) throw new Error("Expected one observer owner.");
    await expect(
      secondObserver.claim({
        leaseOwner: "observer-healthy-steal",
        now: "2026-07-21T12:00:30.000Z",
        leaseExpiresAt: "2026-07-21T12:01:30.000Z",
        limit: 1,
      }),
    ).resolves.toEqual([]);
    const [replacement] = await secondObserver.claim({
      leaseOwner: "observer-replacement",
      now: "2026-07-21T12:01:01.000Z",
      leaseExpiresAt: "2026-07-21T12:02:01.000Z",
      limit: 1,
    });
    if (replacement === undefined) throw new Error("Expected lease takeover.");
    await expect(
      firstObserver.advanceSequence({
        sessionId,
        leaseOwner: original.leaseOwner,
        leaseToken: original.leaseToken,
        now: "2026-07-21T12:01:02.000Z",
        expectedSequence: 0,
        handledSequence: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      secondObserver.advanceSequence({
        sessionId,
        leaseOwner: replacement.leaseOwner,
        leaseToken: replacement.leaseToken,
        now: "2026-07-21T12:01:02.000Z",
        expectedSequence: 0,
        handledSequence: 1,
      }),
    ).resolves.toBe(true);

    const event = {
      id: "voice_event_observer_race_1",
      type: "voice.session.event" as const,
      createdAt: now,
      projectId,
      data: {
        id: "voice_event_observer_race_1",
        sessionId,
        sequence: 1,
        createdAt: now,
        data: { type: "session.lifecycle" as const, to: "created" as const },
      },
    };
    const admission = {
      projectId,
      eventId: event.id,
      sessionId,
      eventType: event.type,
      sourceKind: "session_event" as const,
      workerSequence: 1,
      envelope: event,
      createdAt: now,
    };
    const firstSource = new PostgresVoiceWebhookSourceStore(bundle.database);
    const secondSource = new PostgresVoiceWebhookSourceStore(bundle.database);
    const outcomes = await Promise.all([
      firstSource.ensureSource(admission),
      secondSource.ensureSource(admission),
    ]);
    expect(outcomes.sort()).toEqual(["existing", "inserted"]);
    const conflicts = await Promise.allSettled([
      firstSource.ensureSource({
        ...admission,
        eventId: "voice_event_observer_race_conflict",
        workerSequence: 2,
        envelope: {
          ...event,
          id: "voice_event_observer_race_conflict",
          createdAt: "2026-07-21T12:00:01.000Z",
        },
      }),
      secondSource.ensureSource({
        ...admission,
        eventId: "voice_event_observer_race_conflict",
        workerSequence: 2,
        envelope: {
          ...event,
          id: "voice_event_observer_race_conflict",
          createdAt: "2026-07-21T12:00:02.000Z",
        },
      }),
    ]);
    expect(
      conflicts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      conflicts.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
  } finally {
    await bundle.close();
  }
});
