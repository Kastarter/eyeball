import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  VoiceAgentDraft,
  VoiceAgentSession,
  VoiceAgentSessionEvent,
  VoiceWorkerStartSessionRequest,
} from "@eyeball/core";
import { MockCredentialProvider } from "@eyeball/core";
import {
  VOICE_WORKER_VERSION_HEADER,
  VOICE_WORKER_WIRE_VERSION,
} from "@eyeball/toolkits";
import { expect, it } from "vitest";
import {
  createExecutorRuntime,
  createPgliteStoreBundle,
  type ExecutorRuntime,
  type PgliteStoreBundle,
} from "../../src/index.js";

const PROJECT_ID = "project_voice_observer_restart";
const USER_ID = "user_voice_observer_restart";
const WORKER_ORIGIN = "https://voice-worker.restart.example.test";
const RECEIVER_ORIGIN = "https://voice-receiver.restart.example.test";
const CREATED_AT = "2026-07-21T12:00:00.000Z";

const agentDraft: VoiceAgentDraft = {
  name: "Restart-safe observer",
  systemPrompt: "Handle the call across an executor restart.",
  llm: { model: "model:fixture:restart-safe-observer" },
  voice: {
    tts: { provider: "elevenlabs", voiceId: "voice_restart_test" },
    stt: { provider: "deepgram", model: "nova-3" },
  },
  transport: "pstn:twilio",
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
    mode: "audio_and_transcript",
    consent: "agent_announcement",
    retentionDays: 7,
    redactDtmf: true,
  },
};

function workerResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      [VOICE_WORKER_VERSION_HEADER]: VOICE_WORKER_WIRE_VERSION,
    },
  });
}

class RestartVoiceWorker {
  readonly afterSequences: number[] = [];
  readonly deliveredEventIds: string[] = [];
  events: VoiceAgentSessionEvent[] = [];
  session: VoiceAgentSession | undefined;

  readonly fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === RECEIVER_ORIGIN) {
      const envelope = (await request.json()) as { id?: unknown };
      if (typeof envelope.id === "string") {
        this.deliveredEventIds.push(envelope.id);
      }
      return new Response(null, { status: 204 });
    }
    if (url.origin !== WORKER_ORIGIN) {
      throw new Error(`Unexpected fixture origin ${url.origin}.`);
    }
    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const started = (await request.json()) as VoiceWorkerStartSessionRequest;
      this.events = [
        {
          id: "voice_restart_event_1",
          sessionId: started.sessionId,
          sequence: 1,
          createdAt: CREATED_AT,
          data: { type: "session.lifecycle", to: "in-progress" },
        },
        {
          id: "voice_restart_event_2",
          sessionId: started.sessionId,
          sequence: 2,
          createdAt: "2026-07-21T12:00:01.000Z",
          data: {
            type: "turn.transcript",
            turnId: "turn_before_restart",
            speaker: "human",
            text: "Before the executor restart",
            final: true,
            startMs: 0,
            endMs: 400,
          },
        },
      ];
      this.session = {
        id: started.sessionId,
        projectId: started.scope.projectId,
        userId: started.scope.userId,
        agentId: started.agent.id,
        agentRevision: started.agent.revision,
        transport: "pstn:twilio",
        state: "in-progress",
        createdAt: CREATED_AT,
        startedAt: CREATED_AT,
        lastEventSequence: 2,
      };
      return workerResponse(
        {
          contractVersion: VOICE_WORKER_WIRE_VERSION,
          session: this.session,
        },
        201,
      );
    }
    const session = this.requireSession();
    if (
      request.method === "GET" &&
      url.pathname === `/v1/sessions/${session.id}`
    ) {
      return workerResponse({
        contractVersion: VOICE_WORKER_WIRE_VERSION,
        session,
      });
    }
    if (
      request.method === "GET" &&
      url.pathname === `/v1/sessions/${session.id}/events`
    ) {
      const afterSequence = Number(url.searchParams.get("afterSequence") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 200);
      this.afterSequences.push(afterSequence);
      const available = this.events.filter(
        (event) => event.sequence > afterSequence,
      );
      const selected = available.slice(0, limit);
      return workerResponse({
        contractVersion: VOICE_WORKER_WIRE_VERSION,
        events: selected,
        nextSequence: selected.at(-1)?.sequence ?? afterSequence,
        hasMore: selected.length < available.length,
      });
    }
    throw new Error(`Unexpected worker request ${request.method} ${url}.`);
  }) as typeof globalThis.fetch;

  complete(): void {
    const session = this.requireSession();
    this.events.push(
      {
        id: "voice_restart_event_3",
        sessionId: session.id,
        sequence: 3,
        createdAt: "2026-07-21T12:00:02.000Z",
        data: {
          type: "turn.transcript",
          turnId: "turn_after_restart",
          speaker: "agent",
          text: "After the executor restart",
          final: true,
          startMs: 400,
          endMs: 900,
        },
      },
      {
        id: "voice_restart_event_4",
        sessionId: session.id,
        sequence: 4,
        createdAt: "2026-07-21T12:00:03.000Z",
        data: {
          type: "session.lifecycle",
          from: "wrap-up",
          to: "completed",
        },
      },
    );
    this.session = {
      ...session,
      state: "completed",
      completedAt: "2026-07-21T12:00:03.000Z",
      lastEventSequence: 4,
    };
  }

  requireSession(): VoiceAgentSession {
    if (this.session === undefined) {
      throw new Error("The restart fixture session has not been created.");
    }
    return structuredClone(this.session);
  }
}

async function waitFor(
  assertion: () => Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function runtimeEnvironment(): Readonly<Record<string, string>> {
  return {
    EYEBALL_DATABASE_URL: "postgresql://restart.invalid/eyeball",
    EYEBALL_VOICE_WORKER_URL: WORKER_ORIGIN,
    EYEBALL_VOICE_WORKER_TOKEN:
      "worker-restart-control-token-at-least-32-bytes",
    EYEBALL_VOICE_SESSION_GRANT_SECRET: "g".repeat(32),
  };
}

function credentialProvider(): MockCredentialProvider {
  return new MockCredentialProvider([
    {
      match: {
        projectId: PROJECT_ID,
        userId: USER_ID,
        toolkitSlug: "voice-agents",
      },
      credential: { type: "none" },
    },
  ]);
}

async function closeRuntime(
  runtime: ExecutorRuntime | undefined,
  bundle: PgliteStoreBundle | undefined,
): Promise<void> {
  if (runtime !== undefined) {
    await runtime.close();
  } else {
    await bundle?.close();
  }
}

it("resumes a durable remote observer and terminal transcript across executor runtimes", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "eyeball-voice-observer-restart-"),
  );
  const worker = new RestartVoiceWorker();
  let bundleA: PgliteStoreBundle | undefined;
  let bundleB: PgliteStoreBundle | undefined;
  let runtimeA: ExecutorRuntime | undefined;
  let runtimeB: ExecutorRuntime | undefined;
  try {
    bundleA = await createPgliteStoreBundle({ dataDir: directory });
    const endpoint = await bundleA.webhookEndpointStore.create(PROJECT_ID, {
      url: `${RECEIVER_ORIGIN}/events`,
      events: [
        "voice.session.event",
        "voice.transcript.ready",
        "voice.observer.failed",
      ],
      active: true,
      createdAt: CREATED_AT,
    });
    const agent = await bundleA.agentStore.createAgent(
      PROJECT_ID,
      {
        ...agentDraft,
        webhooks: {
          ...agentDraft.webhooks,
          endpointIds: [endpoint.endpointId],
        },
      },
      CREATED_AT,
    );
    await bundleA.agentStore.attachNumber(
      {
        projectId: PROJECT_ID,
        userId: USER_ID,
        agentId: agent.id,
        revision: agent.revision,
        phoneNumber: "+12025550191",
        transportConnectionId: "conn_voice_restart",
      },
      CREATED_AT,
    );
    runtimeA = await createExecutorRuntime({
      env: runtimeEnvironment(),
      credentialProvider: credentialProvider(),
      fetchImpl: worker.fetch,
      persistenceFactory: async () => bundleA as PgliteStoreBundle,
    });

    const accepted = await runtimeA.engine.execute({
      projectId: PROJECT_ID,
      idempotencyKey: "start-voice-observer-restart",
      request: {
        tool: "voice-agents.start_agent_call",
        userId: USER_ID,
        mode: "async",
        input: {
          agentId: agent.id,
          revision: agent.revision,
          to: "+12025550192",
          from: "+12025550191",
          transportConnectionId: "conn_voice_restart",
        },
      },
    });
    await runtimeA.engine.queue.onIdle();
    const execution = await runtimeA.engine.getExecution(
      PROJECT_ID,
      accepted.response.executionId,
    );
    if (execution.status !== "succeeded") {
      throw new Error(`Remote start failed: ${JSON.stringify(execution)}`);
    }
    const sessionId = worker.requireSession().id;
    await waitFor(async () => {
      const observer = await bundleA?.voiceObserverStore.get(sessionId);
      return observer?.status === "observing" && observer.handledSequence === 2;
    }, "Runtime A did not durably acknowledge sequence 2.");
    for (const event of worker.events) {
      await expect(
        bundleA.voiceWebhookSourceStore.getSource(PROJECT_ID, event.id),
      ).resolves.toMatchObject({
        workerSequence: event.sequence,
        sourceKind: "session_event",
      });
      await expect(
        bundleA.webhookWorkStore.getEvent(PROJECT_ID, event.id),
      ).resolves.toMatchObject({ sourceKind: "voice-session-event" });
    }

    await runtimeA.close();
    runtimeA = undefined;
    bundleA = undefined;
    const runtimeBRequestStart = worker.afterSequences.length;
    worker.complete();

    bundleB = await createPgliteStoreBundle({ dataDir: directory });
    runtimeB = await createExecutorRuntime({
      env: runtimeEnvironment(),
      credentialProvider: credentialProvider(),
      fetchImpl: worker.fetch,
      persistenceFactory: async () => bundleB as PgliteStoreBundle,
    });
    await waitFor(async () => {
      const observer = await bundleB?.voiceObserverStore.get(sessionId);
      return observer?.status === "completed";
    }, "Runtime B did not complete the recovered observer.");
    await runtimeB.engine.queue.onIdle();

    expect(worker.afterSequences.slice(runtimeBRequestStart)).toEqual([2, 0]);
    const sourceEventIds = [
      ...worker.events.map((event) => event.id),
      `transcript_${sessionId}`,
    ];
    for (const eventId of sourceEventIds) {
      await expect(
        bundleB.voiceWebhookSourceStore.getSource(PROJECT_ID, eventId),
      ).resolves.toMatchObject({ eventId, sessionId });
      await expect(
        bundleB.webhookWorkStore.getEvent(PROJECT_ID, eventId),
      ).resolves.toMatchObject({ eventId });
      await expect(
        bundleB.webhookWorkStore.getMaterializedDeliveries(PROJECT_ID, eventId),
      ).resolves.toHaveLength(1);
    }
    const sourceCount = await bundleB.client.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM voice_webhook_sources WHERE project_id = $1 AND session_id = $2",
      [PROJECT_ID, sessionId],
    );
    expect(sourceCount.rows).toEqual([{ count: 5 }]);
    const workCount = await bundleB.client.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM webhook_events WHERE project_id = $1 AND source_kind IN ('voice-session-event', 'voice-transcript')",
      [PROJECT_ID],
    );
    expect(workCount.rows).toEqual([{ count: 5 }]);
    const deliveryCount = await bundleB.client.query<{
      event_id: string;
      count: number;
    }>(
      "SELECT event_id, count(*)::integer AS count FROM webhook_deliveries WHERE project_id = $1 GROUP BY event_id ORDER BY event_id",
      [PROJECT_ID],
    );
    expect(deliveryCount.rows).toHaveLength(5);
    expect(deliveryCount.rows.every((row) => row.count === 1)).toBe(true);
    await expect(
      bundleB.agentStore.getSession(PROJECT_ID, USER_ID, sessionId),
    ).resolves.toMatchObject({ grantRevokedAt: expect.any(String) });
    await expect(
      bundleB.voiceWebhookSourceStore.getSource(
        PROJECT_ID,
        `transcript_${sessionId}`,
      ),
    ).resolves.toMatchObject({
      envelope: {
        data: {
          turns: [
            expect.objectContaining({ text: "Before the executor restart" }),
            expect.objectContaining({ text: "After the executor restart" }),
          ],
        },
      },
    });
    expect(new Set(worker.deliveredEventIds)).toEqual(new Set(sourceEventIds));
    expect(worker.deliveredEventIds).toHaveLength(sourceEventIds.length);
  } finally {
    await closeRuntime(runtimeA, bundleA);
    await closeRuntime(runtimeB, bundleB);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
