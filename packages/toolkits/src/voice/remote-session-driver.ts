import {
  isCanonicalToolName,
  isExecutionId,
  type NormalizedToolError,
  TOOL_ERROR_CODES,
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
  type VoiceSessionDriverOperation,
  VoiceSessionDriverTimeoutError,
} from "./session-driver.js";

export const VOICE_WORKER_WIRE_VERSION = VOICE_WORKER_CONTRACT_VERSION;
export const VOICE_WORKER_VERSION_HEADER = "X-Eyeball-Voice-Worker-Version";

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
  constructor(
    message: string,
    context: {
      operation?: VoiceSessionDriverOperation;
      status?: number;
      sessionId?: string;
      afterSequence?: number;
      cause?: unknown;
    } = {},
  ) {
    super({
      message,
      kind: "invalid_response",
      operation: context.operation ?? "local_driver",
      retryable: false,
      ...(context.status === undefined ? {} : { status: context.status }),
      ...(context.sessionId === undefined
        ? {}
        : { sessionId: context.sessionId }),
      ...(context.afterSequence === undefined
        ? {}
        : { afterSequence: context.afterSequence }),
      ...(context.cause === undefined ? {} : { cause: context.cause }),
    });
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

interface RequestContext {
  readonly operation: VoiceSessionDriverOperation;
  readonly sessionId?: string;
  readonly afterSequence?: number;
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? undefined
    : Math.max(0, Math.ceil((date - Date.now()) / 1_000));
}

/** Trusted typed HTTP client for `eyeball.voice-worker.v2`. */
export class RemoteVoiceSessionDriver implements VoiceSessionDriver {
  readonly baseUrl: string;
  readonly expectedWireVersion = VOICE_WORKER_WIRE_VERSION;
  readonly #fetchImpl: typeof globalThis.fetch;
  readonly #token: string | undefined;
  readonly #requestTimeoutMs: number;

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
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 10_000,
      "requestTimeoutMs",
    );
  }

  async startSession(
    request: VoiceWorkerStartSessionRequest,
  ): Promise<VoiceAgentSession> {
    const context = {
      operation: "start_session",
      sessionId: request.sessionId,
    } as const;
    const body = this.#object(
      await this.#json("v1/sessions", context, {
        method: "POST",
        body: JSON.stringify(request),
      }),
      context,
    );
    const created = this.#validated(context, () => parseSession(body.session));
    if (
      created.projectId !== request.scope.projectId ||
      created.userId !== request.scope.userId ||
      created.id !== request.sessionId ||
      created.agentId !== request.agent.id ||
      created.agentRevision !== request.agent.revision
    ) {
      throw this.#protocol(
        "The voice worker returned a session outside the pinned scope.",
        context,
      );
    }
    return created;
  }

  async stopSession(
    sessionId: string,
    request: VoiceWorkerStopSessionRequest,
  ): Promise<VoiceAgentSession> {
    const context = { operation: "stop_session", sessionId } as const;
    const body = this.#object(
      await this.#json(
        `v1/sessions/${encodeURIComponent(sessionId)}/stop`,
        context,
        { method: "POST", body: JSON.stringify(request) },
      ),
      context,
    );
    return this.#validated(context, () =>
      parseSessionForId(body.session, sessionId),
    );
  }

  async getSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<VoiceAgentSession> {
    const context = { operation: "get_session", sessionId } as const;
    const body = this.#object(
      await this.#json(
        `v1/sessions/${encodeURIComponent(sessionId)}`,
        context,
        options.signal === undefined ? undefined : { signal: options.signal },
      ),
      context,
    );
    return this.#validated(context, () =>
      parseSessionForId(body.session, sessionId),
    );
  }

  async getEvents(
    sessionId: string,
    options: {
      afterSequence?: number;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<VoiceWorkerEventPage> {
    const afterSequence = options.afterSequence ?? 0;
    const context = {
      operation: "get_events",
      sessionId,
      afterSequence,
    } as const;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw this.#protocol(
        "afterSequence must be a non-negative integer.",
        context,
      );
    }
    let limit: number;
    try {
      limit = eventPageLimit(options.limit ?? 50);
    } catch (error) {
      throw this.#contextualize(error, context);
    }
    const query = new URLSearchParams({
      afterSequence: String(afterSequence),
      limit: String(limit),
    });
    const body = this.#object(
      await this.#json(
        `v1/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`,
        context,
        options.signal === undefined ? undefined : { signal: options.signal },
      ),
      context,
    );
    return this.#validated(context, () => {
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
    });
  }

  async sendTurn(
    sessionId: string,
    request: VoiceWorkerChatTurnRequest,
  ): Promise<Omit<VoiceWorkerChatTurnResponse, "contractVersion">> {
    const context = { operation: "send_turn", sessionId } as const;
    const body = this.#object(
      await this.#json(
        `v1/sessions/${encodeURIComponent(sessionId)}/turns`,
        context,
        { method: "POST", body: JSON.stringify(request) },
      ),
      context,
    );
    return this.#validated(context, () => {
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
    });
  }

  async health(): Promise<VoiceWorkerHealth> {
    const context = { operation: "health" } as const;
    const body = this.#object(await this.#json("health", context), context);
    return this.#validated(context, () => {
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
    });
  }

  async close(): Promise<void> {}

  #object(
    value: unknown,
    context: RequestContext,
  ): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
      throw this.#protocol(
        "The voice worker returned non-object JSON.",
        context,
      );
    }
    if (value.contractVersion !== this.expectedWireVersion) {
      throw this.#protocol(
        "The voice-worker response contract is incompatible.",
        context,
      );
    }
    return value;
  }

  #validated<T>(context: RequestContext, parse: () => T): T {
    try {
      return parse();
    } catch (error) {
      throw this.#contextualize(error, context);
    }
  }

  #contextualize(
    error: unknown,
    context: RequestContext,
  ): VoiceSessionDriverError {
    if (error instanceof VoiceSessionDriverError) {
      return this.#protocol(error.message, context, error);
    }
    return this.#protocol(
      "The voice worker returned an invalid response.",
      context,
      error,
    );
  }

  #protocol(
    message: string,
    context: RequestContext,
    cause?: unknown,
  ): VoiceWorkerProtocolError {
    return new VoiceWorkerProtocolError(message, {
      operation: context.operation,
      ...(context.sessionId === undefined
        ? {}
        : { sessionId: context.sessionId }),
      ...(context.afterSequence === undefined
        ? {}
        : { afterSequence: context.afterSequence }),
      ...(cause === undefined ? {} : { cause }),
    });
  }

  #throwTransportFailure(
    error: unknown,
    context: RequestContext,
    upstreamSignal: AbortSignal | null | undefined,
    timeoutSignal: AbortSignal,
  ): never {
    if (upstreamSignal?.aborted === true) throw error;
    if (timeoutSignal.aborted) {
      throw new VoiceSessionDriverTimeoutError(
        context.sessionId ?? "voice-worker",
        context.afterSequence ?? 0,
        {
          operation: context.operation,
          retryable: true,
          message: "The voice-worker request timed out.",
          cause: error,
        },
      );
    }
    throw new VoiceSessionDriverError({
      kind: "provider_unavailable",
      operation: context.operation,
      message: "The voice-worker request could not be completed.",
      retryable: true,
      ...(context.sessionId === undefined
        ? {}
        : { sessionId: context.sessionId }),
      ...(context.afterSequence === undefined
        ? {}
        : { afterSequence: context.afterSequence }),
      cause: error,
    });
  }

  async #json(
    path: string,
    context: RequestContext,
    init?: RequestInit,
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const upstreamSignal = init?.signal;
    const signal =
      upstreamSignal === undefined || upstreamSignal === null
        ? timeoutSignal
        : AbortSignal.any([upstreamSignal, timeoutSignal]);
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    headers.set(VOICE_WORKER_VERSION_HEADER, this.expectedWireVersion);
    if (init?.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (this.#token !== undefined) {
      headers.set("Authorization", `Bearer ${this.#token}`);
    }
    let response: Response;
    try {
      response = await this.#fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        signal,
        headers,
        redirect: "manual",
      });
    } catch (error) {
      this.#throwTransportFailure(
        error,
        context,
        upstreamSignal,
        timeoutSignal,
      );
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 408) {
        throw new VoiceSessionDriverError({
          kind: "timeout",
          operation: context.operation,
          message: "The voice-worker request timed out.",
          retryable: true,
          status,
          ...(context.sessionId === undefined
            ? {}
            : { sessionId: context.sessionId }),
          ...(context.afterSequence === undefined
            ? {}
            : { afterSequence: context.afterSequence }),
        });
      }
      if (status === 429 || status >= 500) {
        const retryAfter = retryAfterSeconds(response);
        throw new VoiceSessionDriverError({
          kind: "provider_unavailable",
          operation: context.operation,
          message: "The voice worker is temporarily unavailable.",
          retryable: true,
          status,
          ...(retryAfter === undefined ? {} : { retryAfter }),
          ...(context.sessionId === undefined
            ? {}
            : { sessionId: context.sessionId }),
          ...(context.afterSequence === undefined
            ? {}
            : { afterSequence: context.afterSequence }),
        });
      }
      throw new VoiceWorkerProtocolError(
        "The voice worker rejected the request.",
        {
          operation: context.operation,
          status,
          ...(context.sessionId === undefined
            ? {}
            : { sessionId: context.sessionId }),
          ...(context.afterSequence === undefined
            ? {}
            : { afterSequence: context.afterSequence }),
        },
      );
    }
    const actualVersion = response.headers.get(VOICE_WORKER_VERSION_HEADER);
    if (actualVersion !== this.expectedWireVersion) {
      throw this.#protocol(
        actualVersion === null
          ? `The voice worker omitted ${VOICE_WORKER_VERSION_HEADER}.`
          : "The voice-worker response contract is incompatible.",
        context,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      if (
        upstreamSignal?.aborted === true ||
        timeoutSignal.aborted ||
        !(error instanceof SyntaxError)
      ) {
        this.#throwTransportFailure(
          error,
          context,
          upstreamSignal,
          timeoutSignal,
        );
      }
      throw this.#protocol(
        "The voice worker returned non-JSON data.",
        context,
        error,
      );
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
