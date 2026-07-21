import type {
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
import { VoiceSessionDriverError } from "../../src/voice/session-driver.js";

const PROJECT_ID = "proj_remote_driver";
const USER_ID = "user_remote_driver";
const AGENT_ID = "va_remote_driver";
const SESSION_ID = "session_0123456789abcdef0123456789abcdef";
const WORKER_TOKEN = "worker-token-fixture-at-least-32-bytes";
const GRANT_TOKEN = "grant-token-must-not-leave-the-start-request";

const request = {
  contractVersion: VOICE_WORKER_WIRE_VERSION,
  sessionId: SESSION_ID,
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
  executorGrant: {
    token: GRANT_TOKEN,
    expiresAt: "2026-07-18T00:01:30.000Z",
  },
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

function stalledResponse(signal: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener(
          "abort",
          () => controller.error(signal.reason),
          { once: true },
        );
      },
    }),
    {
      status: 200,
      headers: { [VOICE_WORKER_VERSION_HEADER]: VOICE_WORKER_WIRE_VERSION },
    },
  );
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
  it("acts as a pinned typed client without starting process-local observation", async () => {
    const requests: Request[] = [];
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.test",
      token: WORKER_TOKEN,
      fetch: workerFetch(requests),
    });

    await expect(driver.startSession(request)).resolves.toEqual(createdSession);
    await expect(
      driver.getEvents(SESSION_ID, { afterSequence: 0 }),
    ).resolves.toEqual(
      expect.objectContaining({
        nextSequence: 6,
        hasMore: false,
        events,
      }),
    );
    await expect(driver.getSession(SESSION_ID)).resolves.toEqual(
      expect.objectContaining({ id: SESSION_ID, state: "completed" }),
    );
    const startBody = await requests[0]?.clone().json();
    expect(startBody).toEqual(request);
    expect(
      requests.every(
        (item) =>
          item.headers.get(VOICE_WORKER_VERSION_HEADER) ===
            VOICE_WORKER_WIRE_VERSION &&
          item.headers.get("Authorization") === `Bearer ${WORKER_TOKEN}` &&
          item.redirect === "manual",
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

    const error = await driver.health().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceWorkerProtocolError);
    expect(error).toMatchObject({
      kind: "invalid_response",
      code: "provider_error",
      retryable: false,
      operation: "health",
    });
    expect((error as Error).message).toContain(VOICE_WORKER_VERSION_HEADER);
  });

  it("sends the complete versioned chat-turn contract", async () => {
    const requests: Request[] = [];
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.test",
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

  it("classifies reachability failures without leaking transport details", async () => {
    const secretDetail = "https://secret.example/token/raw-provider-body";
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
      token: WORKER_TOKEN,
      fetch: vi.fn(async () => {
        throw new TypeError(secretDetail);
      }),
    });

    const error = await driver
      .getSession(SESSION_ID)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceSessionDriverError);
    expect(error).toMatchObject({
      kind: "provider_unavailable",
      code: "provider_unavailable",
      retryable: true,
      operation: "get_session",
      sessionId: SESSION_ID,
    });
    expect((error as Error).message).not.toContain(secretDetail);
    expect(JSON.stringify(error)).not.toContain(WORKER_TOKEN);
    expect(JSON.stringify(error)).not.toContain(secretDetail);
  });

  it.each([
    [503, "provider_unavailable", "provider_unavailable", true],
    [429, "provider_unavailable", "provider_unavailable", true],
    [408, "timeout", "timeout", true],
    [400, "invalid_response", "provider_error", false],
  ] as const)("classifies HTTP %i as %s", async (status, kind, code, retryable) => {
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
      fetch: vi.fn(async () => new Response("private-body", { status })),
    });

    const error = await driver
      .getEvents(SESSION_ID, { afterSequence: 7 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceSessionDriverError);
    expect(error).toMatchObject({
      kind,
      code,
      retryable,
      operation: "get_events",
      status,
      sessionId: SESSION_ID,
      afterSequence: 7,
    });
    expect((error as Error).message).not.toContain("private-body");
  });

  it("classifies malformed JSON as a non-retryable invalid response", async () => {
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
      fetch: vi.fn(
        async () =>
          new Response("private raw response", {
            status: 200,
            headers: {
              [VOICE_WORKER_VERSION_HEADER]: VOICE_WORKER_WIRE_VERSION,
            },
          }),
      ),
    });

    const error = await driver
      .getSession(SESSION_ID)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: "invalid_response",
      code: "provider_error",
      retryable: false,
      operation: "get_session",
    });
    expect((error as Error).message).not.toContain("private raw response");
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
    await expect(driver.getEvents(SESSION_ID, { limit: 201 })).rejects.toThrow(
      "limit must not exceed 200.",
    );
  });

  it("rejects a worker that replaces the executor-owned session ID", async () => {
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
      fetch: vi.fn(async () =>
        response(
          {
            contractVersion: VOICE_WORKER_WIRE_VERSION,
            session: {
              ...createdSession,
              id: "session_ffffffffffffffffffffffffffffffff",
            },
          },
          201,
        ),
      ),
    });

    await expect(driver.startSession(request)).rejects.toThrow(
      "The voice worker returned a session outside the pinned scope.",
    );
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

    const error = await driver.health().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: "timeout",
      code: "timeout",
      retryable: true,
      operation: "health",
    });
  });

  it("classifies a post-headers stalled body as a retryable timeout", async () => {
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
      requestTimeoutMs: 5,
      fetch: vi.fn(async (_input, init) => {
        if (init?.signal === undefined || init.signal === null) {
          throw new Error("Expected a request signal.");
        }
        return stalledResponse(init.signal);
      }) as typeof globalThis.fetch,
    });

    const error = await driver
      .getSession(SESSION_ID)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: "timeout",
      code: "timeout",
      retryable: true,
      operation: "get_session",
      sessionId: SESSION_ID,
    });
  });

  it("classifies a post-headers body transport failure as unavailable", async () => {
    const secretDetail = "private response stream failure";
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
      fetch: vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new TypeError(secretDetail));
              },
            }),
            {
              status: 200,
              headers: {
                [VOICE_WORKER_VERSION_HEADER]: VOICE_WORKER_WIRE_VERSION,
              },
            },
          ),
      ),
    });

    const error = await driver
      .getSession(SESSION_ID)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: "provider_unavailable",
      code: "provider_unavailable",
      retryable: true,
      operation: "get_session",
      sessionId: SESSION_ID,
    });
    expect((error as Error).message).not.toContain(secretDetail);
  });

  it("propagates caller cancellation without classifying an outage", async () => {
    const controller = new AbortController();
    const shutdown = new Error("caller shutdown");
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
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

    const pending = driver.getSession(SESSION_ID, {
      signal: controller.signal,
    });
    controller.abort(shutdown);
    await expect(pending).rejects.toBe(shutdown);
  });

  it("propagates caller cancellation while reading a response body", async () => {
    const controller = new AbortController();
    const shutdown = new Error("caller shutdown after headers");
    const driver = new RemoteVoiceSessionDriver({
      baseUrl: "https://voice-worker.example.test",
      fetch: vi.fn(async (_input, init) => {
        if (init?.signal === undefined || init.signal === null) {
          throw new Error("Expected a request signal.");
        }
        return stalledResponse(init.signal);
      }) as typeof globalThis.fetch,
    });

    const pending = driver.getSession(SESSION_ID, {
      signal: controller.signal,
    });
    controller.abort(shutdown);
    await expect(pending).rejects.toBe(shutdown);
  });

  it("requires secure worker URLs and strong non-empty tokens", () => {
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
    expect(() =>
      voiceWorkerTokenFromEnv({ EYEBALL_VOICE_WORKER_TOKEN: " secret " }),
    ).toThrow("at least 32 characters");
    expect(
      voiceWorkerTokenFromEnv({ EYEBALL_VOICE_WORKER_TOKEN: WORKER_TOKEN }),
    ).toBe(WORKER_TOKEN);
    expect(() =>
      voiceWorkerUrlFromEnv({
        EYEBALL_VOICE_WORKER_URL: "http://voice-worker.example.test",
      }),
    ).toThrow("HTTPS (or loopback HTTP)");
    expect(
      voiceWorkerUrlFromEnv({
        EYEBALL_VOICE_WORKER_URL: "http://127.0.0.1:8080",
      }),
    ).toBe("http://127.0.0.1:8080/");
    expect(() =>
      voiceWorkerUrlFromEnv({
        EYEBALL_VOICE_WORKER_URL:
          "https://worker.example.test/?token=must-not-be-in-a-url",
      }),
    ).toThrow("without credentials, a query, or a fragment");
  });
});
