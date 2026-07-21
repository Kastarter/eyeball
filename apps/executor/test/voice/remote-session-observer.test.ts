import type {
  Clock,
  ExecutorLogger,
  VoiceAgentDraft,
  VoiceAgentSession,
  VoiceAgentSessionEvent,
  VoiceWorkerEventPage,
  VoiceWorkerStartSessionRequest,
  VoiceWorkerStopSessionRequest,
} from "@eyeball/core";
import {
  InMemoryAgentStore,
  type VoiceAgentSessionPointer,
  type VoiceSessionDriver,
  VoiceSessionDriverError,
} from "@eyeball/toolkits";
import { describe, expect, it, vi } from "vitest";
import { InMemoryVoiceSessionObserverStore } from "../../src/voice/memory-observer-store.js";
import { RemoteVoiceSessionObserver } from "../../src/voice/remote-session-observer.js";
import { WebhookDeliverer } from "../../src/webhooks/deliverer.js";
import { InMemoryVoiceWebhookSourceStore } from "../../src/webhooks/memory-voice-source-store.js";
import type {
  VoiceWebhookSourceAdmission,
  VoiceWebhookSourceRecord,
  VoiceWebhookSourceStore,
} from "../../src/webhooks/voice-source-store.js";

const PROJECT_ID = "proj_voice_observer";
const USER_ID = "user_voice_observer";
const SESSION_ID = "session_voice_observer";
const STARTED_AT = "2026-07-21T10:00:00.000Z";

const draft: VoiceAgentDraft = {
  name: "Durable observer",
  systemPrompt: "Help the caller.",
  llm: { model: "model:test" },
  voice: {
    tts: { provider: "elevenlabs", voiceId: "voice_test" },
    stt: { provider: "deepgram", language: "en" },
  },
  transport: "chat",
  tools: [],
  guardrails: {
    maxDurationSeconds: 300,
    handoffToHuman: { enabled: false },
  },
  webhooks: {
    endpointIds: [],
    transcript: true,
    events: ["session.lifecycle", "turn.transcript"],
  },
  recordingPolicy: {
    mode: "disabled",
    consent: "external",
    retentionDays: 0,
    redactDtmf: true,
  },
};

const history: readonly VoiceAgentSessionEvent[] = [
  {
    id: "voice_event_1",
    sessionId: SESSION_ID,
    sequence: 1,
    createdAt: STARTED_AT,
    data: {
      type: "turn.transcript",
      turnId: "turn_1",
      speaker: "human",
      text: "Hello",
      final: true,
      startMs: 0,
      endMs: 200,
    },
  },
  {
    id: "voice_event_2",
    sessionId: SESSION_ID,
    sequence: 2,
    createdAt: "2026-07-21T10:00:01.000Z",
    data: {
      type: "turn.transcript",
      turnId: "turn_2",
      speaker: "agent",
      text: "Welcome",
      final: true,
      startMs: 200,
      endMs: 500,
    },
  },
  {
    id: "voice_event_3",
    sessionId: SESSION_ID,
    sequence: 3,
    createdAt: "2026-07-21T10:00:02.000Z",
    data: {
      type: "session.lifecycle",
      from: "wrap-up",
      to: "completed",
    },
  },
];

function historyEvent(index: number): VoiceAgentSessionEvent {
  const event = history[index];
  if (event === undefined) throw new Error(`Missing fixture event ${index}.`);
  return event;
}

class MutableClock implements Clock {
  milliseconds = Date.parse(STARTED_AT);

  now(): Date {
    return new Date(this.milliseconds);
  }

  advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }
}

class FakeDriver implements VoiceSessionDriver {
  readonly afterSequences: number[] = [];
  session: VoiceAgentSession;
  events: readonly VoiceAgentSessionEvent[];
  getSessionError?: () => unknown;

  constructor(
    session: VoiceAgentSession,
    events: readonly VoiceAgentSessionEvent[] = history,
  ) {
    this.session = structuredClone(session);
    this.events = structuredClone(events);
  }

  async startSession(
    _request: VoiceWorkerStartSessionRequest,
  ): Promise<VoiceAgentSession> {
    return structuredClone(this.session);
  }

  async stopSession(
    _sessionId: string,
    _request: VoiceWorkerStopSessionRequest,
  ): Promise<VoiceAgentSession> {
    return structuredClone(this.session);
  }

  async getSession(
    _sessionId: string,
    _options?: { signal?: AbortSignal },
  ): Promise<VoiceAgentSession> {
    const error = this.getSessionError?.();
    if (error !== undefined) throw error;
    return structuredClone(this.session);
  }

  async getEvents(
    _sessionId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<VoiceWorkerEventPage> {
    const afterSequence = options.afterSequence ?? 0;
    this.afterSequences.push(afterSequence);
    const available = this.events.filter(
      (event) => event.sequence > afterSequence,
    );
    const selected = available.slice(0, options.limit ?? 200);
    return {
      events: structuredClone(selected),
      nextSequence: selected.at(-1)?.sequence ?? afterSequence,
      hasMore: selected.length < available.length,
    };
  }
}

class FailingVoiceSourceStore implements VoiceWebhookSourceStore {
  readonly inner = new InMemoryVoiceWebhookSourceStore();
  failuresRemaining: number;
  readonly failedKinds: string[] = [];
  readonly #sourceKind: VoiceWebhookSourceAdmission["sourceKind"] | undefined;

  constructor(
    failuresRemaining = Number.POSITIVE_INFINITY,
    sourceKind?: VoiceWebhookSourceAdmission["sourceKind"],
  ) {
    this.failuresRemaining = failuresRemaining;
    this.#sourceKind = sourceKind;
  }

  async ensureSource(
    input: VoiceWebhookSourceAdmission,
  ): Promise<"inserted" | "existing"> {
    if (
      this.failuresRemaining > 0 &&
      (this.#sourceKind === undefined || this.#sourceKind === input.sourceKind)
    ) {
      this.failuresRemaining -= 1;
      this.failedKinds.push(input.sourceKind);
      throw new Error("source unavailable");
    }
    return this.inner.ensureSource(input);
  }

  getSource(
    projectId: string,
    eventId: string,
  ): Promise<VoiceWebhookSourceRecord | undefined> {
    return this.inner.getSource(projectId, eventId);
  }
}

async function fixture(input: {
  driverFactory?: (session: VoiceAgentSession) => FakeDriver;
  sourceStore?: VoiceWebhookSourceStore;
  transcript?: boolean;
  retryLimit?: number;
  logger?: ExecutorLogger;
}) {
  const clock = new MutableClock();
  const agentStore = new InMemoryAgentStore();
  const agent = await agentStore.createAgent(
    PROJECT_ID,
    {
      ...draft,
      webhooks: {
        ...draft.webhooks,
        transcript: input.transcript ?? true,
      },
    },
    clock.now().toISOString(),
  );
  const pointer: VoiceAgentSessionPointer = {
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    agentId: agent.id,
    agentRevision: agent.revision,
    callId: `call_${SESSION_ID}`,
    createdAt: STARTED_AT,
    grantId: "vsg_voice_observer",
    grantExpiresAt: "2026-07-21T10:10:00.000Z",
  };
  await agentStore.rememberSession(pointer);
  const session: VoiceAgentSession = {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    agentId: agent.id,
    agentRevision: agent.revision,
    transport: "chat",
    state: "completed",
    createdAt: STARTED_AT,
    startedAt: STARTED_AT,
    completedAt: "2026-07-21T10:00:02.000Z",
    lastEventSequence: 3,
  };
  const driver = input.driverFactory?.(session) ?? new FakeDriver(session);
  const observerStore = new InMemoryVoiceSessionObserverStore();
  const sourceStore =
    input.sourceStore ?? new InMemoryVoiceWebhookSourceStore();
  const webhookDeliverer = new WebhookDeliverer({
    voiceSourceStore: sourceStore,
    clock,
  });
  const observer = new RemoteVoiceSessionObserver({
    store: observerStore,
    agentStore,
    driver,
    webhookDeliverer,
    clock,
    logger: input.logger,
    retryLimit: input.retryLimit ?? 20,
    retryBaseDelayMs: 1,
    retryMaximumDelayMs: 10,
    automaticScheduling: false,
  });
  await observer.prepare(pointer);
  await observerStore.activatePrepared(SESSION_ID, clock.now().toISOString());
  return {
    agentStore,
    clock,
    driver,
    observer,
    observerStore,
    pointer,
    sourceStore,
    webhookDeliverer,
  };
}

async function checkpoint(
  store: InMemoryVoiceSessionObserverStore,
  pointer: VoiceAgentSessionPointer,
  clock: MutableClock,
  sequence: number,
): Promise<void> {
  const now = clock.now().toISOString();
  const [claim] = await store.claim({
    leaseOwner: "checkpoint-owner",
    now,
    leaseExpiresAt: new Date(clock.milliseconds + 60_000).toISOString(),
    limit: 1,
  });
  if (claim === undefined) throw new Error("Expected checkpoint claim.");
  let current = claim.handledSequence;
  while (current < sequence) {
    await store.advanceSequence({
      sessionId: pointer.sessionId,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      now,
      expectedSequence: current,
      handledSequence: current + 1,
    });
    current += 1;
  }
  await store.release({
    sessionId: pointer.sessionId,
    leaseOwner: claim.leaseOwner,
    leaseToken: claim.leaseToken,
    now,
  });
}

describe("RemoteVoiceSessionObserver", () => {
  it("resumes after the durable cursor and finalizes from complete history", async () => {
    const current = await fixture({});
    await current.webhookDeliverer.enqueueVoiceSessionEvent({
      projectId: PROJECT_ID,
      endpointIds: [],
      event: historyEvent(0),
    });
    await current.webhookDeliverer.enqueueVoiceSessionEvent({
      projectId: PROJECT_ID,
      endpointIds: [],
      event: historyEvent(1),
    });
    await checkpoint(current.observerStore, current.pointer, current.clock, 2);

    await current.observer.runOnce();

    expect(current.driver.afterSequences).toEqual([2, 0]);
    await expect(current.observerStore.get(SESSION_ID)).resolves.toMatchObject({
      status: "completed",
      handledSequence: 3,
      terminalSequence: 3,
      terminalHandledAt: expect.any(String),
      transcriptStatus: "admitted",
    });
    await expect(
      current.agentStore.getSession(PROJECT_ID, USER_ID, SESSION_ID),
    ).resolves.toMatchObject({ grantRevokedAt: expect.any(String) });
    await expect(
      current.sourceStore.getSource(PROJECT_ID, `transcript_${SESSION_ID}`),
    ).resolves.toMatchObject({
      sourceKind: "transcript",
      envelope: {
        data: {
          turns: [
            expect.objectContaining({ text: "Hello" }),
            expect.objectContaining({ text: "Welcome" }),
          ],
        },
      },
    });
    await current.observer.close();
  });

  it("re-drains a terminal event that appears between the event and session reads", async () => {
    class TerminalRaceDriver extends FakeDriver {
      getSessionCalls = 0;

      override async getSession(
        sessionId: string,
        options?: { signal?: AbortSignal },
      ): Promise<VoiceAgentSession> {
        this.getSessionCalls += 1;
        if (this.getSessionCalls === 1) {
          return {
            ...structuredClone(this.session),
            state: "in-progress",
            completedAt: undefined,
            lastEventSequence: 0,
          };
        }
        this.events = structuredClone(history);
        return super.getSession(sessionId, options);
      }
    }
    const current = await fixture({
      driverFactory: (session) => new TerminalRaceDriver(session, []),
    });

    await current.observer.runOnce();

    expect(current.driver.afterSequences).toEqual([0, 0, 0]);
    await expect(current.observerStore.get(SESSION_ID)).resolves.toMatchObject({
      status: "completed",
      handledSequence: 3,
      terminalSequence: 3,
      transcriptStatus: "admitted",
    });
    await current.observer.close();
  });

  it("revokes the terminal grant before advancing its worker cursor", async () => {
    const current = await fixture({});
    const revoke = vi.spyOn(current.agentStore, "revokeSessionGrant");
    const advance = vi.spyOn(current.observerStore, "advanceSequence");

    await current.observer.runOnce();

    expect(revoke).toHaveBeenCalledOnce();
    expect(advance).toHaveBeenCalledTimes(3);
    const terminalAdvance = advance.mock.invocationCallOrder.at(-1);
    const revokeOrder = revoke.mock.invocationCallOrder[0];
    if (terminalAdvance === undefined || revokeOrder === undefined) {
      throw new Error("Expected terminal cursor and grant-revocation calls.");
    }
    expect(revokeOrder).toBeLessThan(terminalAdvance);
    await expect(
      current.agentStore.getSession(PROJECT_ID, USER_ID, SESSION_ID),
    ).resolves.toMatchObject({ grantRevokedAt: expect.any(String) });
    await current.observer.close();
  });

  it("does not advance the cursor when source-first admission fails", async () => {
    const sourceStore = new FailingVoiceSourceStore();
    const current = await fixture({ sourceStore });

    await current.observer.runOnce();

    await expect(current.observerStore.get(SESSION_ID)).resolves.toMatchObject({
      status: "observing",
      handledSequence: 0,
      consecutiveFailures: 1,
      lastFailureKind: "publication_error",
      lastFailureOperation: "publish_event",
    });
    expect(sourceStore.failedKinds).toEqual(["session_event"]);
    await current.observer.close();
  });

  it("skips disabled transcript publication and completes durably", async () => {
    const current = await fixture({ transcript: false });

    await current.observer.runOnce();

    await expect(current.observerStore.get(SESSION_ID)).resolves.toMatchObject({
      status: "completed",
      transcriptStatus: "skipped",
      transcriptHandledAt: expect.any(String),
    });
    await expect(
      current.sourceStore.getSource(PROJECT_ID, `transcript_${SESSION_ID}`),
    ).resolves.toBeUndefined();
    await current.observer.close();
  });

  it("charges transcript publication failures to the finalization retry budget", async () => {
    const sourceStore = new FailingVoiceSourceStore(
      Number.POSITIVE_INFINITY,
      "transcript",
    );
    const current = await fixture({ sourceStore, retryLimit: 3 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await current.observer.runOnce();
      current.clock.advance(60_000);
    }

    await expect(current.observerStore.get(SESSION_ID)).resolves.toMatchObject({
      status: "exhausted",
      handledSequence: 3,
      consecutiveFailures: 3,
      lastFailureKind: "publication_error",
      lastFailureOperation: "publish_transcript",
      transcriptStatus: "pending",
    });
    expect(sourceStore.failedKinds).toEqual([
      "transcript",
      "transcript",
      "transcript",
    ]);

    await current.observer.runOnce();
    await expect(
      current.sourceStore.getSource(
        PROJECT_ID,
        `voice_observer_failed_${SESSION_ID}`,
      ),
    ).resolves.toMatchObject({
      envelope: {
        data: { reason: "retry_exhausted", attempts: 3 },
      },
    });
    await current.observer.close();
  });

  it("exhausts invalid responses immediately and admits one failure signal", async () => {
    const current = await fixture({ retryLimit: 20 });
    current.driver.getSessionError = () =>
      new VoiceSessionDriverError({
        message: "invalid worker payload",
        kind: "invalid_response",
        operation: "get_session",
      });

    await current.observer.runOnce();
    const exhausted = await current.observerStore.get(SESSION_ID);
    expect(exhausted).toMatchObject({
      status: "exhausted",
      consecutiveFailures: 1,
      lastFailureKind: "invalid_response",
    });
    expect(exhausted).not.toHaveProperty("exhaustionSignaledAt");
    await current.observer.runOnce();
    await expect(current.observerStore.get(SESSION_ID)).resolves.toMatchObject({
      status: "exhausted",
      exhaustionSignaledAt: expect.any(String),
    });
    await expect(
      current.sourceStore.getSource(
        PROJECT_ID,
        `voice_observer_failed_${SESSION_ID}`,
      ),
    ).resolves.toMatchObject({
      sourceKind: "observer_failure",
      envelope: {
        type: "voice.observer.failed",
        data: {
          reason: "non_retryable",
          error: { code: "provider_error", retryable: false },
        },
      },
    });
    await current.observer.close();
  });

  it("persists twenty transient failures and logs exhaustion exactly once", async () => {
    const logEvents: string[] = [];
    const logger: ExecutorLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message) => logEvents.push(message),
    };
    const current = await fixture({ logger, retryLimit: 20 });
    current.driver.getSessionError = () =>
      new VoiceSessionDriverError({
        message: "unavailable",
        kind: "provider_unavailable",
        operation: "get_session",
      });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await current.observer.runOnce();
      current.clock.advance(60_000);
    }

    await expect(current.observerStore.get(SESSION_ID)).resolves.toMatchObject({
      status: "exhausted",
      consecutiveFailures: 20,
      lastFailureKind: "provider_unavailable",
    });
    expect(logEvents).toEqual(["voice.observer_exhausted"]);
    current.driver.getSessionError = undefined;
    await current.observer.runOnce();
    await expect(
      current.sourceStore.getSource(
        PROJECT_ID,
        `voice_observer_failed_${SESSION_ID}`,
      ),
    ).resolves.toMatchObject({
      envelope: { data: { reason: "retry_exhausted", attempts: 20 } },
    });
    expect(logEvents).toEqual(["voice.observer_exhausted"]);
    await current.observer.close();
  });

  it("keeps boot reconciliation armed for a retry due after startup", async () => {
    const current = await fixture({});
    current.driver.getSessionError = () =>
      new VoiceSessionDriverError({
        message: "unavailable",
        kind: "provider_unavailable",
        operation: "get_session",
      });
    await current.observer.runOnce();
    await current.observer.close();
    await expect(current.observerStore.get(SESSION_ID)).resolves.toMatchObject({
      status: "observing",
      consecutiveFailures: 1,
      nextAttemptAt: expect.any(String),
    });

    current.driver.getSessionError = undefined;
    const resumed = new RemoteVoiceSessionObserver({
      store: current.observerStore,
      agentStore: current.agentStore,
      driver: current.driver,
      webhookDeliverer: current.webhookDeliverer,
      clock: current.clock,
      pollIntervalMs: 1,
      retryBaseDelayMs: 1,
      retryMaximumDelayMs: 10,
    });
    await resumed.reconcileAtBoot();
    current.clock.advance(60_000);
    await vi.waitFor(
      async () =>
        expect(await current.observerStore.get(SESSION_ID)).toMatchObject({
          status: "completed",
          handledSequence: 3,
        }),
      { timeout: 1_000 },
    );
    await resumed.close();
  });

  it("leaves an exhausted row recoverable until failure publication succeeds", async () => {
    const sourceStore = new FailingVoiceSourceStore(1);
    const current = await fixture({ sourceStore });
    current.driver.getSessionError = () =>
      new VoiceSessionDriverError({
        message: "invalid",
        kind: "invalid_response",
        operation: "get_session",
      });
    await current.observer.runOnce();

    await current.observer.runOnce();
    const unsignaled = await current.observerStore.get(SESSION_ID);
    expect(unsignaled).toMatchObject({
      status: "exhausted",
    });
    expect(unsignaled).not.toHaveProperty("exhaustionSignaledAt");
    sourceStore.failuresRemaining = 0;
    await current.observer.runOnce();
    await expect(current.observerStore.get(SESSION_ID)).resolves.toMatchObject({
      exhaustionSignaledAt: expect.any(String),
    });
    expect(sourceStore.failedKinds).toEqual(["observer_failure"]);
    await current.observer.close();
  });

  it("treats shutdown cancellation as control flow without a failure", async () => {
    const current = await fixture({});
    current.driver.getSession = vi.fn(
      async (_sessionId: string, options?: { signal?: AbortSignal }) =>
        new Promise<VoiceAgentSession>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );

    const running = current.observer.runOnce();
    await vi.waitFor(() =>
      expect(current.driver.getSession).toHaveBeenCalled(),
    );
    await current.observer.close();
    await running;

    await expect(current.observerStore.get(SESSION_ID)).resolves.toMatchObject({
      consecutiveFailures: 0,
    });
  });
});
