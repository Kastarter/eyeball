import type {
  TranscriptArtifact,
  VoiceAgentSession,
  VoiceAgentSessionEvent,
  VoiceWorkerStartSessionRequest,
} from "@eyeball/core";
import { describe, expect, it, vi } from "vitest";
import {
  RemoteVoiceSessionDriver,
  VOICE_WORKER_VERSION_HEADER,
  VOICE_WORKER_WIRE_VERSION,
  VoiceWorkerProtocolError,
  voiceWorkerTokenFromEnv,
  voiceWorkerUrlFromEnv,
} from "../../src/voice/remote-session-driver.js";

const PROJECT_ID = "proj_remote_driver";
const USER_ID = "user_remote_driver";
const AGENT_ID = "va_remote_driver";
const SESSION_ID = "session_remote_driver";

const request = {
  contractVersion: VOICE_WORKER_WIRE_VERSION,
  scope: { projectId: PROJECT_ID, userId: USER_ID },
  agent: {
    id: AGENT_ID,
    revision: 4,
    systemPrompt: "Confirm the reservation.",
    llm: { provider: "anthropic", model: "claude-sonnet-4-6" },
    voice: {
      stt: { provider: "deepgram", model: "nova-3" },
      tts: { provider: "elevenlabs", voiceId: "voice_worker_test" },
    },
    allowedTools: [],
    guardrails: {
      maxDurationSeconds: 30,
      handoffToHuman: { enabled: false },
    },
    webhooks: {
      endpointIds: ["wh_voice_test"],
      transcript: true,
      events: ["session.lifecycle", "turn.transcript"],
    },
    recordingPolicy: {
      mode: "disabled",
      consent: "external",
      retentionDays: 0,
      redactDtmf: true,
    },
    bargeIn: { enabled: true },
  },
  transport: { kind: "fake", turns: [{ caller: "Hello." }] },
} as const satisfies VoiceWorkerStartSessionRequest;

const createdSession: VoiceAgentSession = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  userId: USER_ID,
  agentId: AGENT_ID,
  agentRevision: 4,
  transport: "chat",
  state: "created",
  createdAt: "2026-07-18T00:00:00.000Z",
  lastEventSequence: 1,
};

const events: readonly VoiceAgentSessionEvent[] = [
  {
    id: "event_1",
    sessionId: SESSION_ID,
    sequence: 1,
    createdAt: "2026-07-18T00:00:00.000Z",
    data: { type: "session.lifecycle", to: "created" },
  },
  {
    id: "event_2",
    sessionId: SESSION_ID,
    sequence: 2,
    createdAt: "2026-07-18T00:00:01.000Z",
    data: { type: "session.lifecycle", from: "created", to: "in-progress" },
  },
  {
    id: "event_3",
    sessionId: SESSION_ID,
    sequence: 3,
    createdAt: "2026-07-18T00:00:02.000Z",
    data: {
      type: "turn.transcript",
      turnId: "turn_1",
      speaker: "human",
      text: "Hello.",
      final: true,
      startMs: 0,
      endMs: 500,
    },
  },
  {
    id: "event_4",
    sessionId: SESSION_ID,
    sequence: 4,
    createdAt: "2026-07-18T00:00:03.000Z",
    data: {
      type: "turn.transcript",
      turnId: "turn_1",
      speaker: "agent",
      text: "Welcome.",
      final: true,
      startMs: 500,
      endMs: 1_000,
    },
  },
  {
    id: "event_5",
    sessionId: SESSION_ID,
    sequence: 5,
    createdAt: "2026-07-18T00:00:04.000Z",
    data: {
      type: "session.lifecycle",
      from: "in-progress",
      to: "wrap-up",
    },
  },
  {
    id: "event_6",
    sessionId: SESSION_ID,
    sequence: 6,
    createdAt: "2026-07-18T00:00:05.000Z",
    data: {
      type: "session.lifecycle",
      from: "wrap-up",
      to: "completed",
    },
  },
];

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { [VOICE_WORKER_VERSION_HEADER]: VOICE_WORKER_WIRE_VERSION },
  });
}

function workerFetch(requests: Request[]): typeof globalThis.fetch {
  return (async (input, init) => {
    const incoming = new Request(input, init);
    requests.push(incoming.clone());
    const url = new URL(incoming.url);
    if (incoming.method === "POST" && url.pathname === "/v1/sessions") {
      return response(
        {
          contractVersion: VOICE_WORKER_WIRE_VERSION,
          session: createdSession,
        },
        201,
      );
    }
    if (
      incoming.method === "POST" &&
      url.pathname === `/v1/sessions/${SESSION_ID}/turns`
    ) {
      return response({
        contractVersion: VOICE_WORKER_WIRE_VERSION,
        session: {
          ...createdSession,
          state: "in-progress",
          startedAt: "2026-07-18T00:00:01.000Z",
          lastEventSequence: 4,
        },
        turnId: "turn_chat_1",
        assistantMessage: "The reservation is confirmed.",
      });
    }
    if (
      incoming.method === "GET" &&
      url.pathname === `/v1/sessions/${SESSION_ID}/events`
    ) {
      const afterSequence = Number(url.searchParams.get("afterSequence") ?? 0);
      const selected = events.filter((event) => event.sequence > afterSequence);
      return response({
        contractVersion: VOICE_WORKER_WIRE_VERSION,
        events: selected,
        nextSequence: selected.at(-1)?.sequence ?? afterSequence,
        hasMore: false,
      });
    }
    if (
      incoming.method === "GET" &&
      url.pathname === `/v1/sessions/${SESSION_ID}`
    ) {
      return response({
        contractVersion: VOICE_WORKER_WIRE_VERSION,
        session: {
          ...createdSession,
          state: "completed",
          startedAt: "2026-07-18T00:00:01.000Z",
          completedAt: "2026-07-18T00:00:05.000Z",
          lastEventSequence: 6,
        },
      });
    }
    throw new Error(`Unexpected worker request: ${incoming.method} ${url}`);
  }) as typeof globalThis.fetch;
}

describe("remote voice-session driver", () => {
  it("starts a pinned session and consumes its durable ordered events", async () => {
    const requests: Request[] = [];
    const onEvent = vi.fn();
    let transcript: TranscriptArtifact | undefined;
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "http://voice-worker.test",
      token: "worker-token",
      fetch: workerFetch(requests),
      pollIntervalMs: 1,
      onEvent,
      onTranscript: (input) => {
        transcript = input.transcript;
      },
    });

    await expect(driver.startSession(request)).resolves.toEqual(createdSession);
    await vi.waitFor(() => {
      expect(transcript).toMatchObject({
        id: `transcript_${SESSION_ID}`,
        sessionId: SESSION_ID,
        final: true,
        turns: [
          expect.objectContaining({ speaker: "human", text: "Hello." }),
          expect.objectContaining({ speaker: "agent", text: "Welcome." }),
        ],
      });
    });

    expect(onEvent.mock.calls.map(([input]) => input.event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(
      requests.every(
        (item) =>
          item.headers.get(VOICE_WORKER_VERSION_HEADER) ===
            VOICE_WORKER_WIRE_VERSION &&
          item.headers.get("Authorization") === "Bearer worker-token",
      ),
    ).toBe(true);
    await driver.close();
  });

  it("rejects an absent or incompatible worker version before using data", async () => {
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
      fetch: vi.fn(async () =>
        Response.json({ status: "ok" }, { status: 200 }),
      ),
    });

    await expect(driver.health()).rejects.toThrow(
      new VoiceWorkerProtocolError(
        `The voice worker omitted ${VOICE_WORKER_VERSION_HEADER}.`,
      ),
    );
  });

  it("sends the complete versioned chat-turn contract", async () => {
    const requests: Request[] = [];
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "http://voice-worker.test",
      fetch: workerFetch(requests),
    });
    const turnRequest = {
      contractVersion: VOICE_WORKER_WIRE_VERSION,
      text: "Is the reservation confirmed?",
      idempotencyKey: "turn_client_1",
    } as const;

    await expect(driver.sendTurn(SESSION_ID, turnRequest)).resolves.toEqual({
      session: expect.objectContaining({
        id: SESSION_ID,
        state: "in-progress",
      }),
      turnId: "turn_chat_1",
      assistantMessage: "The reservation is confirmed.",
    });
    const sent = requests.at(-1);
    if (sent === undefined) throw new Error("The chat turn was not sent.");
    await expect(sent.json()).resolves.toEqual(turnRequest);
  });

  it("retries an event when the delivery callback fails", async () => {
    const attempts: number[] = [];
    let failedOnce = false;
    let transcript: TranscriptArtifact | undefined;
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "http://voice-worker.test",
      fetch: workerFetch([]),
      pollIntervalMs: 1,
      onEvent: ({ event }) => {
        attempts.push(event.sequence);
        if (event.sequence === 3 && !failedOnce) {
          failedOnce = true;
          throw new Error("transient webhook failure");
        }
      },
      onTranscript: (input) => {
        transcript = input.transcript;
      },
    });

    await driver.startSession(request);
    await vi.waitFor(() => expect(transcript?.final).toBe(true));
    expect(attempts).toEqual([1, 2, 3, 3, 4, 5, 6]);
    expect(transcript?.turns).toHaveLength(2);
    await driver.close();
  });

  it("rejects malformed event payloads at the trust boundary", async () => {
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
      fetch: vi.fn(async () =>
        response({
          contractVersion: VOICE_WORKER_WIRE_VERSION,
          events: [
            {
              ...events[0],
              createdAt: "not-a-timestamp",
            },
          ],
          nextSequence: 1,
          hasMore: false,
        }),
      ),
    });

    await expect(driver.getEvents(SESSION_ID)).rejects.toThrow(
      "The voice worker returned an invalid event createdAt.",
    );
  });

  it("rejects cross-session responses and unsupported page sizes", async () => {
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
      fetch: vi.fn(async () =>
        response({
          contractVersion: VOICE_WORKER_WIRE_VERSION,
          session: { ...createdSession, id: "session_wrong" },
        }),
      ),
    });

    await expect(driver.getSession(SESSION_ID)).rejects.toThrow(
      "The voice worker returned a different session than requested.",
    );
    await expect(
      driver.getEvents(SESSION_ID, { limit: 201 }),
    ).rejects.toThrow("limit must not exceed 200.");
  });

  it("bounds worker requests with an explicit protocol timeout", async () => {
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
      requestTimeoutMs: 5,
      fetch: vi.fn(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      ) as typeof globalThis.fetch,
    });

    await expect(driver.health()).rejects.toThrow(
      "Voice-worker request timed out after 5ms.",
    );
  });

  it("resolves only non-empty environment overrides", () => {
    expect(voiceWorkerUrlFromEnv({})).toBeUndefined();
    expect(
      voiceWorkerUrlFromEnv({ EYEBALL_VOICE_WORKER_URL: "  " }),
    ).toBeUndefined();
    expect(
      voiceWorkerUrlFromEnv({
        EYEBALL_VOICE_WORKER_URL: "https://worker.example.test/api",
      }),
    ).toBe("https://worker.example.test/api/");
    expect(voiceWorkerTokenFromEnv({})).toBeUndefined();
    expect(
      voiceWorkerTokenFromEnv({ EYEBALL_VOICE_WORKER_TOKEN: " secret " }),
    ).toBe("secret");
  });
});
