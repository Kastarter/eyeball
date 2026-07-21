import {
  isCanonicalToolName,
  isExecutionId,
  type NormalizedToolError,
  TOOL_ERROR_CODES,
  type TranscriptArtifact,
  type TranscriptTurn,
  VOICE_WORKER_CONTRACT_VERSION,
  type VoiceAgentSession,
  type VoiceAgentSessionEvent,
  type VoiceAgentSessionState,
  type VoiceWorkerChatTurnRequest,
  type VoiceWorkerChatTurnResponse,
  type VoiceWorkerEventPage,
  type VoiceWorkerStartSessionRequest,
  type VoiceWorkerStopSessionRequest,
} from "@eyeball/core";
import {
  type VoiceSessionDriver,
  VoiceSessionDriverError,
} from "./session-driver.js";

export const VOICE_WORKER_WIRE_VERSION = VOICE_WORKER_CONTRACT_VERSION;
export const VOICE_WORKER_VERSION_HEADER = "X-Eyeball-Voice-Worker-Version";

const TERMINAL_STATES = new Set(["completed", "failed", "abandoned"]);
const SESSION_STATES = new Set<VoiceAgentSessionState>([
  "created",
  "connecting",
  "in-progress",
  "wrap-up",
  "completed",
  "failed",
  "abandoned",
]);
const TOOL_ERROR_CODE_VALUES = new Set<string>(Object.values(TOOL_ERROR_CODES));

export type VoiceWorkerObservationRequest = Omit<
  VoiceWorkerStartSessionRequest,
  "executorGrant"
>;

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
    hostname === "[::1]"
  );
}

export interface RemoteVoiceSessionDriverOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** Shared control-plane token. Required by provider-backed worker mode. */
  token?: string;
  onEvent?: (input: {
    request: VoiceWorkerObservationRequest;
    event: VoiceAgentSessionEvent;
  }) => void | Promise<void>;
  onTranscript?: (input: {
    request: VoiceWorkerObservationRequest;
    transcript: TranscriptArtifact;
  }) => void | Promise<void>;
  onTerminal?: (input: {
    request: VoiceWorkerObservationRequest;
    event: VoiceAgentSessionEvent;
  }) => void | Promise<void>;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

export interface VoiceWorkerHealth {
  status: "ok" | "draining";
  service: "voice-worker";
  contractVersion: string;
  acceptingSessions: boolean;
  activeSessions: number;
  media: {
    mode: "fake" | "pipecat";
    pipecatInstalled: boolean;
    liveReady: boolean;
  };
}

export class VoiceWorkerProtocolError extends VoiceSessionDriverError {
  constructor(message: string) {
    super(message);
    this.name = "VoiceWorkerProtocolError";
  }
}

function normalizedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VoiceWorkerProtocolError(
      "The voice-worker base URL must be an absolute HTTP(S) URL.",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new VoiceWorkerProtocolError(
      "The voice-worker base URL must use HTTPS (or loopback HTTP) without credentials, a query, or a fragment.",
    );
  }
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return url.toString();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VoiceWorkerProtocolError(`${field} must be a positive integer.`);
  }
  return value;
}

function eventPageLimit(value: number): number {
  const limit = positiveInteger(value, "limit");
  if (limit > 200) {
    throw new VoiceWorkerProtocolError("limit must not exceed 200.");
  }
  return limit;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new VoiceWorkerProtocolError(
      `The voice worker returned an invalid ${field}.`,
    );
  }
  return Number(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VoiceWorkerProtocolError(
      `The voice worker returned an invalid ${field}.`,
    );
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const encoded = nonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(encoded))) {
    throw new VoiceWorkerProtocolError(
      `The voice worker returned an invalid ${field}.`,
    );
  }
  return encoded;
}

function sessionState(value: unknown, field: string): VoiceAgentSessionState {
  if (
    typeof value !== "string" ||
    !SESSION_STATES.has(value as VoiceAgentSessionState)
  ) {
    throw new VoiceWorkerProtocolError(
      `The voice worker returned an invalid ${field}.`,
    );
  }
  return value as VoiceAgentSessionState;
}

function normalizedError(value: unknown, field: string): NormalizedToolError {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    !TOOL_ERROR_CODE_VALUES.has(value.code) ||
    typeof value.message !== "string" ||
    typeof value.retryable !== "boolean" ||
    (value.retryAfter !== undefined &&
      (typeof value.retryAfter !== "number" ||
        !Number.isFinite(value.retryAfter) ||
        value.retryAfter < 0)) ||
    (value.provider !== undefined && !isRecord(value.provider))
  ) {
    throw new VoiceWorkerProtocolError(
      `The voice worker returned an invalid ${field}.`,
    );
  }
  return structuredClone(value) as unknown as NormalizedToolError;
}

function parseSession(value: unknown): VoiceAgentSession {
  if (!isRecord(value)) {
    throw new VoiceWorkerProtocolError(
      "The voice worker returned an invalid session.",
    );
  }
  nonEmptyString(value.id, "session id");
  nonEmptyString(value.projectId, "session projectId");
  nonEmptyString(value.userId, "session userId");
  nonEmptyString(value.agentId, "session agentId");
  if (
    !Number.isSafeInteger(value.agentRevision) ||
    Number(value.agentRevision) < 1
  ) {
    throw new VoiceWorkerProtocolError(
      "The voice worker returned an invalid session agentRevision.",
    );
  }
  if (
    value.transport !== "pstn:twilio" &&
    value.transport !== "webrtc:livekit" &&
    value.transport !== "chat"
  ) {
    throw new VoiceWorkerProtocolError(
      "The voice worker returned an invalid session transport.",
    );
  }
  sessionState(value.state, "session state");
  timestamp(value.createdAt, "session createdAt");
  if (value.startedAt !== undefined) {
    timestamp(value.startedAt, "session startedAt");
  }
  if (value.completedAt !== undefined) {
    timestamp(value.completedAt, "session completedAt");
  }
  nonNegativeInteger(value.lastEventSequence, "session lastEventSequence");
  if (value.error !== undefined) {
    normalizedError(value.error, "session error");
  }
  return structuredClone(value) as unknown as VoiceAgentSession;
}

function parseSessionForId(
  value: unknown,
  expectedSessionId: string,
): VoiceAgentSession {
  const session = parseSession(value);
  if (session.id !== expectedSessionId) {
    throw new VoiceWorkerProtocolError(
      "The voice worker returned a different session than requested.",
    );
  }
  return session;
}

function parseEvent(value: unknown): VoiceAgentSessionEvent {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new VoiceWorkerProtocolError(
      "The voice worker returned an invalid event.",
    );
  }
  nonEmptyString(value.id, "event id");
  nonEmptyString(value.sessionId, "event sessionId");
  const sequence = nonNegativeInteger(value.sequence, "event sequence");
  if (sequence < 1) {
    throw new VoiceWorkerProtocolError(
      "The voice worker returned an invalid event sequence.",
    );
  }
  timestamp(value.createdAt, "event createdAt");
  const data = value.data;
  const type = nonEmptyString(data.type, "event type");
  switch (type) {
    case "session.lifecycle":
      sessionState(data.to, "lifecycle target state");
      if (data.from !== undefined) {
        sessionState(data.from, "lifecycle source state");
      }
      break;
    case "turn.transcript": {
      nonEmptyString(data.turnId, "transcript turnId");
      if (
        (data.speaker !== "human" && data.speaker !== "agent") ||
        typeof data.text !== "string" ||
        typeof data.final !== "boolean"
      ) {
        throw new VoiceWorkerProtocolError(
          "The voice worker returned an invalid transcript event.",
        );
      }
      const startMs = nonNegativeInteger(data.startMs, "transcript startMs");
      const endMs = nonNegativeInteger(data.endMs, "transcript endMs");
      if (endMs < startMs) {
        throw new VoiceWorkerProtocolError(
          "The voice worker returned an invalid transcript time range.",
        );
      }
      break;
    }
    case "tool_call":
      nonEmptyString(data.turnId, "tool-call turnId");
      if (
        typeof data.executionId !== "string" ||
        !isExecutionId(data.executionId) ||
        typeof data.tool !== "string" ||
        !isCanonicalToolName(data.tool) ||
        !isRecord(data.input)
      ) {
        throw new VoiceWorkerProtocolError(
          "The voice worker returned an invalid tool-call event.",
        );
      }
      break;
    case "tool_result": {
      nonEmptyString(data.turnId, "tool-result turnId");
      const hasOutput = Object.hasOwn(data, "output");
      const hasError = Object.hasOwn(data, "error");
      if (
        typeof data.executionId !== "string" ||
        !isExecutionId(data.executionId) ||
        typeof data.tool !== "string" ||
        !isCanonicalToolName(data.tool) ||
        hasOutput === hasError ||
        (hasError && !isRecord(data.error))
      ) {
        throw new VoiceWorkerProtocolError(
          "The voice worker returned an invalid tool-result event.",
        );
      }
      if (hasError) normalizedError(data.error, "tool-result error");
      break;
    }
    case "handoff":
      if (
        typeof data.destination !== "string" ||
        data.destination.length === 0 ||
        typeof data.reason !== "string" ||
        data.reason.length === 0 ||
        (data.status !== "requested" &&
          data.status !== "completed" &&
          data.status !== "failed")
      ) {
        throw new VoiceWorkerProtocolError(
          "The voice worker returned an invalid handoff event.",
        );
      }
      break;
    case "dtmf":
      if (
        typeof data.digits !== "string" ||
        (data.direction !== "received" && data.direction !== "sent") ||
        typeof data.redacted !== "boolean"
      ) {
        throw new VoiceWorkerProtocolError(
          "The voice worker returned an invalid DTMF event.",
        );
      }
      break;
    default:
      throw new VoiceWorkerProtocolError(
        "The voice worker returned an unsupported event type.",
      );
  }
  return structuredClone(value) as unknown as VoiceAgentSessionEvent;
}

function transcriptTurn(
  event: VoiceAgentSessionEvent,
  previousEndMs: number,
): TranscriptTurn | undefined {
  const data = event.data;
  if (data.type === "turn.transcript") {
    return {
      id: data.turnId,
      speaker: data.speaker,
      startMs: data.startMs,
      endMs: data.endMs,
      text: data.text,
    };
  }
  if (data.type === "tool_call") {
    return {
      id: `tool_${event.id}`,
      speaker: "tool",
      startMs: previousEndMs,
      endMs: previousEndMs,
      text: JSON.stringify({ type: "tool_call", input: data.input }),
      executionId: data.executionId,
      tool: data.tool,
    };
  }
  if (data.type === "tool_result") {
    return {
      id: `tool_result_${event.id}`,
      speaker: "tool",
      startMs: previousEndMs,
      endMs: previousEndMs,
      text: JSON.stringify({
        type: "tool_result",
        ...(data.error === undefined
          ? { output: data.output }
          : { error: data.error }),
      }),
      executionId: data.executionId,
      tool: data.tool,
    };
  }
  return undefined;
}

function transcriptFromEvents(
  request: VoiceWorkerObservationRequest,
  session: VoiceAgentSession,
  events: readonly VoiceAgentSessionEvent[],
): TranscriptArtifact {
  const turns: TranscriptTurn[] = [];
  let previousEndMs = 0;
  for (const event of events) {
    const turn = transcriptTurn(event, previousEndMs);
    if (turn !== undefined) {
      turns.push(turn);
      previousEndMs = Math.max(previousEndMs, turn.endMs);
    }
  }
  return {
    id: `transcript_${session.id}`,
    sessionId: session.id,
    agentId: session.agentId,
    agentRevision: session.agentRevision,
    transport: session.transport,
    final: TERMINAL_STATES.has(session.state),
    ...(request.agent.voice.stt.language === undefined
      ? {}
      : { language: request.agent.voice.stt.language }),
    startedAt: session.startedAt ?? session.createdAt,
    ...(session.completedAt === undefined
      ? {}
      : { endedAt: session.completedAt }),
    turns,
  };
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Trusted TypeScript proxy for `eyeball.voice-worker.v2`. */
export class RemoteVoiceSessionDriver implements VoiceSessionDriver {
  readonly baseUrl: string;
  readonly expectedWireVersion = VOICE_WORKER_WIRE_VERSION;
  readonly #fetchImpl: typeof globalThis.fetch;
  readonly #token: string | undefined;
  readonly #onEvent: RemoteVoiceSessionDriverOptions["onEvent"];
  readonly #onTranscript: RemoteVoiceSessionDriverOptions["onTranscript"];
  readonly #onTerminal: RemoteVoiceSessionDriverOptions["onTerminal"];
  readonly #pollIntervalMs: number;
  readonly #requestTimeoutMs: number;
  readonly #streams = new Map<string, AbortController>();
  readonly #streamTasks = new Set<Promise<void>>();

  constructor(options: RemoteVoiceSessionDriverOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.#fetchImpl = options.fetch ?? globalThis.fetch;
    const token = options.token?.trim();
    if (token !== undefined && token.length > 0 && token.length < 32) {
      throw new VoiceWorkerProtocolError(
        "The voice-worker control token must be at least 32 characters.",
      );
    }
    this.#token = token === undefined || token.length === 0 ? undefined : token;
    this.#onEvent = options.onEvent;
    this.#onTranscript = options.onTranscript;
    this.#onTerminal = options.onTerminal;
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? 250,
      "pollIntervalMs",
    );
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 10_000,
      "requestTimeoutMs",
    );
  }

  async startSession(
    request: VoiceWorkerStartSessionRequest,
  ): Promise<VoiceAgentSession> {
    const body = this.#versionedObject(
      await this.#json("v1/sessions", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
    const created = parseSession(body.session);
    if (
      created.projectId !== request.scope.projectId ||
      created.userId !== request.scope.userId ||
      created.id !== request.sessionId ||
      created.agentId !== request.agent.id ||
      created.agentRevision !== request.agent.revision
    ) {
      throw new VoiceWorkerProtocolError(
        "The voice worker returned a session outside the pinned scope.",
      );
    }
    const { executorGrant: _executorGrant, ...observationRequest } =
      structuredClone(request);
    this.#observe(created.id, observationRequest);
    return created;
  }

  async stopSession(
    sessionId: string,
    request: VoiceWorkerStopSessionRequest,
  ): Promise<VoiceAgentSession> {
    const body = this.#versionedObject(
      await this.#json(`v1/sessions/${encodeURIComponent(sessionId)}/stop`, {
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
    return parseSessionForId(body.session, sessionId);
  }

  async getSession(sessionId: string): Promise<VoiceAgentSession> {
    return this.#getSession(sessionId);
  }

  async #getSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<VoiceAgentSession> {
    const body = this.#versionedObject(
      await this.#json(
        `v1/sessions/${encodeURIComponent(sessionId)}`,
        signal === undefined ? undefined : { signal },
      ),
    );
    return parseSessionForId(body.session, sessionId);
  }

  async getEvents(
    sessionId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<VoiceWorkerEventPage> {
    return this.#getEvents(sessionId, options);
  }

  async #getEvents(
    sessionId: string,
    options: { afterSequence?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<VoiceWorkerEventPage> {
    const afterSequence = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new VoiceWorkerProtocolError(
        "afterSequence must be a non-negative integer.",
      );
    }
    const query = new URLSearchParams({
      afterSequence: String(afterSequence),
      limit: String(eventPageLimit(options.limit ?? 50)),
    });
    const body = this.#versionedObject(
      await this.#json(
        `v1/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`,
        signal === undefined ? undefined : { signal },
      ),
    );
    if (!Array.isArray(body.events) || typeof body.hasMore !== "boolean") {
      throw new VoiceWorkerProtocolError(
        "The voice worker returned an invalid event page.",
      );
    }
    const events = body.events.map(parseEvent);
    if (body.hasMore && events.length === 0) {
      throw new VoiceWorkerProtocolError(
        "The voice worker returned an empty event page with hasMore set.",
      );
    }
    let expected = afterSequence + 1;
    for (const item of events) {
      if (item.sessionId !== sessionId || item.sequence !== expected) {
        throw new VoiceWorkerProtocolError(
          "The voice worker returned a non-contiguous event page.",
        );
      }
      expected += 1;
    }
    const nextSequence = events.at(-1)?.sequence ?? afterSequence;
    if (body.nextSequence !== nextSequence) {
      throw new VoiceWorkerProtocolError(
        "The voice worker returned an inconsistent event cursor.",
      );
    }
    return {
      contractVersion: VOICE_WORKER_CONTRACT_VERSION,
      events,
      nextSequence,
      hasMore: body.hasMore,
    };
  }

  async sendTurn(
    sessionId: string,
    request: VoiceWorkerChatTurnRequest,
  ): Promise<Omit<VoiceWorkerChatTurnResponse, "contractVersion">> {
    const body = this.#versionedObject(
      await this.#json(`v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
    if (
      typeof body.turnId !== "string" ||
      body.turnId.length === 0 ||
      typeof body.assistantMessage !== "string"
    ) {
      throw new VoiceWorkerProtocolError(
        "The voice worker returned an invalid turn response.",
      );
    }
    return {
      session: parseSessionForId(body.session, sessionId),
      turnId: body.turnId,
      assistantMessage: body.assistantMessage,
    };
  }

  async health(): Promise<VoiceWorkerHealth> {
    const body = this.#versionedObject(await this.#json("health"));
    if (
      (body.status !== "ok" && body.status !== "draining") ||
      body.service !== "voice-worker" ||
      typeof body.acceptingSessions !== "boolean" ||
      !Number.isSafeInteger(body.activeSessions) ||
      Number(body.activeSessions) < 0 ||
      !isRecord(body.media) ||
      (body.media.mode !== "fake" && body.media.mode !== "pipecat") ||
      typeof body.media.pipecatInstalled !== "boolean" ||
      typeof body.media.liveReady !== "boolean"
    ) {
      throw new VoiceWorkerProtocolError(
        "The voice-worker health response is invalid.",
      );
    }
    return body as unknown as VoiceWorkerHealth;
  }

  async close(): Promise<void> {
    for (const controller of this.#streams.values()) controller.abort();
    this.#streams.clear();
    await Promise.allSettled([...this.#streamTasks]);
  }

  #versionedObject(value: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
      throw new VoiceWorkerProtocolError(
        "The voice worker returned non-object JSON.",
      );
    }
    if (value.contractVersion !== this.expectedWireVersion) {
      throw new VoiceWorkerProtocolError(
        `Voice-worker contract ${String(value.contractVersion)} does not match ${this.expectedWireVersion}.`,
      );
    }
    return value;
  }

  async #json(path: string, init?: RequestInit): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const upstreamSignal = init?.signal;
    const signal =
      upstreamSignal === undefined || upstreamSignal === null
        ? timeoutSignal
        : AbortSignal.any([upstreamSignal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.#versionedFetch(new URL(path, this.baseUrl), {
        ...init,
        signal,
        headers: {
          ...(init?.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...init?.headers,
        },
      });
    } catch (error) {
      if (error instanceof VoiceWorkerProtocolError) throw error;
      throw new VoiceWorkerProtocolError(
        timeoutSignal.aborted
          ? `Voice-worker request timed out after ${this.#requestTimeoutMs}ms.`
          : "The voice worker could not be reached.",
      );
    }
    if (!response.ok) {
      throw new VoiceWorkerProtocolError(
        `Voice-worker request failed with HTTP ${response.status}.`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new VoiceWorkerProtocolError(
        "The voice worker returned non-JSON data.",
      );
    }
  }

  readonly #versionedFetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    headers.set(VOICE_WORKER_VERSION_HEADER, this.expectedWireVersion);
    if (this.#token !== undefined) {
      headers.set("Authorization", `Bearer ${this.#token}`);
    }
    const response = await this.#fetchImpl(input, {
      ...init,
      headers,
      redirect: "manual",
    });
    const actualVersion = response.headers.get(VOICE_WORKER_VERSION_HEADER);
    if (actualVersion !== this.expectedWireVersion) {
      throw new VoiceWorkerProtocolError(
        actualVersion === null
          ? `The voice worker omitted ${VOICE_WORKER_VERSION_HEADER}.`
          : `Voice-worker contract ${actualVersion} does not match ${this.expectedWireVersion}.`,
      );
    }
    return response;
  };

  #observe(sessionId: string, request: VoiceWorkerObservationRequest): void {
    if (
      this.#onEvent === undefined &&
      this.#onTranscript === undefined &&
      this.#onTerminal === undefined
    )
      return;
    this.#streams.get(sessionId)?.abort();
    const controller = new AbortController();
    this.#streams.set(sessionId, controller);
    const task = this.#consumeEvents(
      sessionId,
      request,
      controller.signal,
    ).finally(() => {
      if (this.#streams.get(sessionId) === controller) {
        this.#streams.delete(sessionId);
      }
      this.#streamTasks.delete(task);
    });
    this.#streamTasks.add(task);
  }

  async #consumeEvents(
    sessionId: string,
    request: VoiceWorkerObservationRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const events: VoiceAgentSessionEvent[] = [];
    let cursor = 0;
    let consecutiveFailures = 0;
    let terminalObserved = false;
    while (!signal.aborted) {
      try {
        let page = await this.#getEvents(
          sessionId,
          {
            afterSequence: cursor,
            limit: 200,
          },
          signal,
        );
        for (;;) {
          for (const event of page.events) {
            const terminal =
              event.data.type === "session.lifecycle" &&
              TERMINAL_STATES.has(event.data.to);
            if (terminal && !terminalObserved) {
              await this.#onTerminal?.({ request, event });
              terminalObserved = true;
            }
            await this.#onEvent?.({ request, event });
            cursor = event.sequence;
            events.push(event);
          }
          if (!page.hasMore) break;
          page = await this.#getEvents(
            sessionId,
            {
              afterSequence: cursor,
              limit: 200,
            },
            signal,
          );
        }
        consecutiveFailures = 0;
        const terminalEvent = events.findLast(
          (event) =>
            event.data.type === "session.lifecycle" &&
            TERMINAL_STATES.has(event.data.to),
        );
        if (terminalEvent !== undefined) {
          const session = await this.#getSession(sessionId, signal);
          await this.#onTranscript?.({
            request,
            transcript: transcriptFromEvents(request, session, events),
          });
          return;
        }
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 20) return;
      }
      await wait(this.#pollIntervalMs, signal);
    }
  }
}

/** Empty values disable the production worker and preserve the scripted driver. */
export function voiceWorkerUrlFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env.EYEBALL_VOICE_WORKER_URL?.trim();
  return value === undefined || value.length === 0
    ? undefined
    : normalizedBaseUrl(value);
}

/** Optional shared token sent only to the configured worker origin. */
export function voiceWorkerTokenFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env.EYEBALL_VOICE_WORKER_TOKEN?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (value.length < 32) {
    throw new VoiceWorkerProtocolError(
      "EYEBALL_VOICE_WORKER_TOKEN must be at least 32 characters.",
    );
  }
  return value;
}
