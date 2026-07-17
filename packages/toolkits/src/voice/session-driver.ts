import {
  type ExecutionId,
  EyeballError,
  isCanonicalToolName,
  isExecutionId,
  type JsonValue,
  type NormalizedToolError,
  type QualifiedToolName,
  TOOL_ERROR_CODES,
  type VoiceAgentDefinition,
  type VoiceAgentSessionEvent,
  type VoiceAgentSessionState,
} from "@eyeball/core";

const TERMINAL_SESSION_STATES = new Set<VoiceAgentSessionState>([
  "completed",
  "failed",
  "abandoned",
]);

export interface VoiceSessionRef {
  sessionId: string;
  /** Last durably handled event. The next poll begins after this sequence. */
  afterSequence?: number;
}

/** Immutable scope copied onto the session job when a call starts. */
export interface VoiceSessionAgentRevision
  extends Pick<VoiceAgentDefinition, "id" | "revision" | "tools"> {
  projectId: string;
  userId: string;
}

export interface VoiceSessionDriverClock {
  now(): Date;
  /** Advances simulated time and runs any transitions due in that interval. */
  advance(milliseconds: number): void | Promise<void>;
}

export type VoiceSessionExecutionResponse =
  | {
      executionId: ExecutionId;
      tool: QualifiedToolName;
      status: "succeeded";
      output: JsonValue;
    }
  | {
      executionId: ExecutionId;
      tool: QualifiedToolName;
      status: "failed";
      error: NormalizedToolError;
    }
  | {
      executionId: ExecutionId;
      tool: QualifiedToolName;
      status: "pending" | "running";
    };

export interface VoiceSessionExecutionEngine {
  execute(command: {
    projectId: string;
    executionId: ExecutionId;
    request: {
      tool: QualifiedToolName;
      userId: string;
      input: Readonly<Record<string, JsonValue>>;
      mode: "sync";
    };
    idempotencyKey: string;
  }): Promise<{ response: VoiceSessionExecutionResponse }>;
}

export interface VoiceSessionExecutorClient {
  execute(request: {
    projectId: string;
    executionId: ExecutionId;
    userId: string;
    tool: QualifiedToolName;
    input: Readonly<Record<string, JsonValue>>;
    idempotencyKey: string;
  }): Promise<VoiceSessionExecutionResponse>;
}

export interface VoiceSessionToolCall {
  sessionId: string;
  sequence: number;
  eventExecutionId: ExecutionId;
  tool: QualifiedToolName;
  input: Readonly<Record<string, JsonValue>>;
}

export type VoiceSessionToolDispatchResult =
  | {
      status: "succeeded";
      executionId: ExecutionId;
      output: JsonValue;
    }
  | {
      status: "failed";
      executionId?: ExecutionId;
      error: NormalizedToolError;
    };

interface VoiceSessionExecutionTargetOptions {
  executionEngine?: VoiceSessionExecutionEngine;
  executorClient?: VoiceSessionExecutorClient;
}

export interface DispatchVoiceSessionToolCallOptions
  extends VoiceSessionExecutionTargetOptions {
  agentRevision: VoiceSessionAgentRevision;
  toolCall: VoiceSessionToolCall;
}

export interface VoiceSessionDriverOptions
  extends VoiceSessionExecutionTargetOptions {
  sessionRef: VoiceSessionRef;
  agentRevision: VoiceSessionAgentRevision;
  pipecatBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  clock: VoiceSessionDriverClock;
  turnHandler?: VoiceSessionTurnHandler;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface VoiceSessionDriverTickOptions
  extends VoiceSessionExecutionTargetOptions {
  sessionRef: VoiceSessionRef;
  agentRevision: VoiceSessionAgentRevision;
  pipecatBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  turnHandler?: VoiceSessionTurnHandler;
}

export interface VoiceSessionHumanTurn {
  sessionId: string;
  eventSequence: number;
  turnId: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface VoiceSessionAgentTurn {
  text: string;
  toolCall?: {
    tool: QualifiedToolName;
    input: Readonly<Record<string, JsonValue>>;
  };
}

export interface VoiceSessionTurnHandler {
  respond(input: {
    agentRevision: VoiceSessionAgentRevision;
    humanTurn: VoiceSessionHumanTurn;
  }): Promise<VoiceSessionAgentTurn>;
}

export interface VoiceSessionDispatchRecord {
  eventSequence: number;
  eventExecutionId: ExecutionId;
  tool: QualifiedToolName;
  result: VoiceSessionToolDispatchResult;
}

export interface VoiceSessionDriverResult {
  sessionId: string;
  state: Extract<VoiceAgentSessionState, "completed" | "failed" | "abandoned">;
  lastSequence: number;
  events: readonly VoiceAgentSessionEvent[];
  dispatches: readonly VoiceSessionDispatchRecord[];
  agentTurns: readonly VoiceSessionAgentTurn[];
}

/** One bounded worker pass for request-driven development harnesses. */
export interface VoiceSessionDriverTickResult {
  sessionId: string;
  state: VoiceAgentSessionState;
  lastSequence: number;
  terminal: boolean;
  events: readonly VoiceAgentSessionEvent[];
  dispatches: readonly VoiceSessionDispatchRecord[];
  agentTurns: readonly VoiceSessionAgentTurn[];
}

interface PipecatSessionSnapshot {
  id: string;
  projectId: string;
  userId: string;
  agentId: string;
  agentRevision: number;
  state: VoiceAgentSessionState;
  lastEventSequence: number;
  awaitingAgentTurn: boolean;
  pendingToolCall?: {
    executionId: ExecutionId;
    tool: QualifiedToolName;
  };
}

interface PipecatEventPage {
  events: readonly VoiceAgentSessionEvent[];
  nextSequence: number;
  hasMore: boolean;
}

export class VoiceSessionDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceSessionDriverError";
  }
}

export class VoiceSessionDriverTimeoutError extends VoiceSessionDriverError {
  readonly sessionId: string;
  readonly afterSequence: number;

  constructor(sessionId: string, afterSequence: number) {
    super(
      `Voice session ${sessionId} did not reach a terminal state before the driver timeout.`,
    );
    this.name = "VoiceSessionDriverTimeoutError";
    this.sessionId = sessionId;
    this.afterSequence = afterSequence;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new VoiceSessionDriverError(
      `Pipecat returned an invalid ${field} field.`,
    );
  }
  return candidate;
}

function requiredInteger(
  value: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const candidate = value[field];
  if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) {
    throw new VoiceSessionDriverError(
      `Pipecat returned an invalid ${field} field.`,
    );
  }
  return Number(candidate);
}

function sessionState(value: unknown): VoiceAgentSessionState {
  if (
    value === "created" ||
    value === "connecting" ||
    value === "in-progress" ||
    value === "wrap-up" ||
    value === "completed" ||
    value === "failed" ||
    value === "abandoned"
  ) {
    return value;
  }
  throw new VoiceSessionDriverError(
    "Pipecat returned an invalid session state.",
  );
}

function qualifiedToolName(value: string): QualifiedToolName {
  if (!isCanonicalToolName(value)) {
    throw new VoiceSessionDriverError(
      "Pipecat returned an invalid qualified tool name.",
    );
  }
  return value;
}

function parseSession(value: unknown): PipecatSessionSnapshot {
  if (!isRecord(value)) {
    throw new VoiceSessionDriverError("Pipecat returned an invalid session.");
  }
  if (typeof value.awaitingAgentTurn !== "boolean") {
    throw new VoiceSessionDriverError(
      "Pipecat returned an invalid awaitingAgentTurn field.",
    );
  }
  let pendingToolCall: PipecatSessionSnapshot["pendingToolCall"];
  if (value.pendingToolCall !== undefined) {
    if (!isRecord(value.pendingToolCall)) {
      throw new VoiceSessionDriverError(
        "Pipecat returned an invalid pending tool call.",
      );
    }
    const executionId = requiredString(value.pendingToolCall, "executionId");
    if (!isExecutionId(executionId)) {
      throw new VoiceSessionDriverError(
        "Pipecat returned an invalid pending execution ID.",
      );
    }
    pendingToolCall = {
      executionId,
      tool: qualifiedToolName(requiredString(value.pendingToolCall, "tool")),
    };
  }
  return {
    id: requiredString(value, "id"),
    projectId: requiredString(value, "projectId"),
    userId: requiredString(value, "userId"),
    agentId: requiredString(value, "agentId"),
    agentRevision: requiredInteger(value, "agentRevision"),
    state: sessionState(value.state),
    lastEventSequence: requiredInteger(value, "lastEventSequence"),
    awaitingAgentTurn: value.awaitingAgentTurn,
    ...(pendingToolCall === undefined ? {} : { pendingToolCall }),
  };
}

function parseEvent(value: unknown): VoiceAgentSessionEvent {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new VoiceSessionDriverError(
      "Pipecat returned an invalid session event.",
    );
  }
  const sequence = requiredInteger(value, "sequence");
  if (sequence < 1) {
    throw new VoiceSessionDriverError(
      "Pipecat returned an invalid event sequence.",
    );
  }
  requiredString(value, "id");
  requiredString(value, "sessionId");
  const createdAt = requiredString(value, "createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new VoiceSessionDriverError(
      "Pipecat returned an invalid event timestamp.",
    );
  }
  const type = requiredString(value.data, "type");
  switch (type) {
    case "session.lifecycle":
      sessionState(value.data.to);
      if (value.data.from !== undefined) {
        sessionState(value.data.from);
      }
      break;
    case "turn.transcript": {
      requiredString(value.data, "turnId");
      if (typeof value.data.text !== "string") {
        throw new VoiceSessionDriverError(
          "Pipecat returned invalid transcript text.",
        );
      }
      if (value.data.speaker !== "human" && value.data.speaker !== "agent") {
        throw new VoiceSessionDriverError(
          "Pipecat returned an invalid transcript speaker.",
        );
      }
      if (typeof value.data.final !== "boolean") {
        throw new VoiceSessionDriverError(
          "Pipecat returned an invalid transcript final flag.",
        );
      }
      const startMs = requiredInteger(value.data, "startMs");
      const endMs = requiredInteger(value.data, "endMs");
      if (endMs < startMs) {
        throw new VoiceSessionDriverError(
          "Pipecat returned an invalid transcript time range.",
        );
      }
      break;
    }
    case "tool_call": {
      requiredString(value.data, "turnId");
      if (!isRecord(value.data.input)) {
        throw new VoiceSessionDriverError(
          "Pipecat returned an invalid tool-call input.",
        );
      }
      qualifiedToolName(requiredString(value.data, "tool"));
      const executionId = requiredString(value.data, "executionId");
      if (!isExecutionId(executionId)) {
        throw new VoiceSessionDriverError(
          "Pipecat returned an invalid tool-call execution ID.",
        );
      }
      break;
    }
    case "tool_result": {
      requiredString(value.data, "turnId");
      qualifiedToolName(requiredString(value.data, "tool"));
      const executionId = requiredString(value.data, "executionId");
      if (!isExecutionId(executionId)) {
        throw new VoiceSessionDriverError(
          "Pipecat returned an invalid tool-result execution ID.",
        );
      }
      const hasOutput = Object.hasOwn(value.data, "output");
      const hasError = Object.hasOwn(value.data, "error");
      if (hasOutput === hasError || (hasError && !isRecord(value.data.error))) {
        throw new VoiceSessionDriverError(
          "Pipecat returned an invalid tool result.",
        );
      }
      break;
    }
    case "handoff":
      requiredString(value.data, "destination");
      requiredString(value.data, "reason");
      if (
        value.data.status !== "requested" &&
        value.data.status !== "completed" &&
        value.data.status !== "failed"
      ) {
        throw new VoiceSessionDriverError(
          "Pipecat returned an invalid handoff status.",
        );
      }
      break;
    case "dtmf":
      if (
        typeof value.data.digits !== "string" ||
        (value.data.direction !== "received" &&
          value.data.direction !== "sent") ||
        typeof value.data.redacted !== "boolean"
      ) {
        throw new VoiceSessionDriverError(
          "Pipecat returned an invalid DTMF event.",
        );
      }
      break;
    default:
      throw new VoiceSessionDriverError(
        "Pipecat returned an unsupported session event type.",
      );
  }
  return value as unknown as VoiceAgentSessionEvent;
}

function parseEventPage(value: unknown): PipecatEventPage {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new VoiceSessionDriverError(
      "Pipecat returned an invalid session event page.",
    );
  }
  if (typeof value.hasMore !== "boolean") {
    throw new VoiceSessionDriverError(
      "Pipecat returned an invalid event-page continuation flag.",
    );
  }
  return {
    events: value.events.map(parseEvent),
    nextSequence: requiredInteger(value, "nextSequence"),
    hasMore: value.hasMore,
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VoiceSessionDriverError(`${field} must be a positive integer.`);
  }
  return value;
}

function clockMilliseconds(clock: VoiceSessionDriverClock): number {
  const milliseconds = clock.now().valueOf();
  if (!Number.isFinite(milliseconds)) {
    throw new VoiceSessionDriverError(
      "The voice-session driver clock returned an invalid date.",
    );
  }
  return milliseconds;
}

function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  try {
    return new URL(path, base).toString();
  } catch (cause) {
    throw new VoiceSessionDriverError(
      `The Pipecat base URL is invalid: ${
        cause instanceof Error ? cause.message : "unknown URL error"
      }`,
    );
  }
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    throw new VoiceSessionDriverError(
      `Pipecat request failed: ${
        cause instanceof Error ? cause.message : "unknown fetch error"
      }`,
    );
  }
  if (!response.ok) {
    throw new VoiceSessionDriverError(
      `Pipecat request failed with HTTP ${response.status}.`,
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new VoiceSessionDriverError("Pipecat returned a non-JSON response.");
  }
}

function assertSessionScope(
  session: PipecatSessionSnapshot,
  sessionRef: VoiceSessionRef,
  revision: VoiceSessionAgentRevision,
): void {
  if (
    session.id !== sessionRef.sessionId ||
    session.projectId !== revision.projectId ||
    session.userId !== revision.userId ||
    session.agentId !== revision.id ||
    session.agentRevision !== revision.revision
  ) {
    throw new VoiceSessionDriverError(
      "Pipecat returned a session outside the pinned agent revision scope.",
    );
  }
}

function unexpectedExecutionError(): NormalizedToolError {
  return {
    code: TOOL_ERROR_CODES.PROVIDER_ERROR,
    message: "Tool execution failed unexpectedly.",
    retryable: false,
  };
}

function normalizedExecutionError(error: unknown): NormalizedToolError {
  return error instanceof EyeballError
    ? error.toJSON()
    : unexpectedExecutionError();
}

export function voiceSessionToolNotAllowedError(
  tool: QualifiedToolName,
): NormalizedToolError {
  return {
    code: TOOL_ERROR_CODES.NOT_SUPPORTED,
    message: `Tool ${tool} is not allowed by this voice-agent revision.`,
    retryable: false,
  };
}

export function voiceSessionIdempotencyKey(
  sessionId: string,
  eventSequence: number,
): string {
  return `voice-session:${sessionId}:event:${eventSequence}`;
}

function executionTarget(
  options: VoiceSessionExecutionTargetOptions,
): "engine" | "client" {
  if (
    (options.executionEngine === undefined) ===
    (options.executorClient === undefined)
  ) {
    throw new VoiceSessionDriverError(
      "Configure exactly one of executionEngine or executorClient.",
    );
  }
  return options.executionEngine === undefined ? "client" : "engine";
}

/**
 * Stable worker dispatch seam. A streaming production worker can call this directly
 * after receiving a durable tool_call event; polling is deliberately kept separate.
 */
export async function dispatchVoiceSessionToolCall(
  options: DispatchVoiceSessionToolCallOptions,
): Promise<VoiceSessionToolDispatchResult> {
  const { agentRevision, toolCall } = options;
  if (!agentRevision.tools.includes(toolCall.tool)) {
    return {
      status: "failed",
      error: voiceSessionToolNotAllowedError(toolCall.tool),
    };
  }

  const request = {
    projectId: agentRevision.projectId,
    userId: agentRevision.userId,
    executionId: toolCall.eventExecutionId,
    tool: toolCall.tool,
    input: toolCall.input,
    idempotencyKey: voiceSessionIdempotencyKey(
      toolCall.sessionId,
      toolCall.sequence,
    ),
  };

  let execution: VoiceSessionExecutionResponse;
  try {
    if (executionTarget(options) === "engine") {
      const outcome = await options.executionEngine?.execute({
        projectId: request.projectId,
        executionId: request.executionId,
        request: {
          tool: request.tool,
          userId: request.userId,
          input: request.input,
          mode: "sync",
        },
        idempotencyKey: request.idempotencyKey,
      });
      if (outcome === undefined) {
        throw new Error("Execution engine was not configured.");
      }
      execution = outcome.response;
    } else {
      const outcome = await options.executorClient?.execute(request);
      if (outcome === undefined) {
        throw new Error("Executor client was not configured.");
      }
      execution = outcome;
    }
  } catch (error) {
    return { status: "failed", error: normalizedExecutionError(error) };
  }

  if (
    execution.executionId !== toolCall.eventExecutionId ||
    execution.tool !== toolCall.tool
  ) {
    return {
      status: "failed",
      error: {
        code: TOOL_ERROR_CODES.PROVIDER_ERROR,
        message: "Voice-session tool execution returned mismatched identity.",
        retryable: false,
      },
    };
  }

  if (execution.status === "succeeded") {
    return {
      status: "succeeded",
      executionId: execution.executionId,
      output: execution.output,
    };
  }
  if (execution.status === "failed") {
    return {
      status: "failed",
      executionId: execution.executionId,
      error: execution.error,
    };
  }
  return {
    status: "failed",
    executionId: execution.executionId,
    error: {
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: "Voice-session tool execution did not return a terminal result.",
      retryable: false,
    },
  };
}

async function sessionSnapshot(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  sessionId: string,
): Promise<PipecatSessionSnapshot> {
  return parseSession(
    await requestJson(
      fetchImpl,
      endpoint(baseUrl, `sessions/${encodeURIComponent(sessionId)}`),
    ),
  );
}

async function eventPage(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  sessionId: string,
  afterSequence: number,
): Promise<PipecatEventPage> {
  const query = new URLSearchParams({
    afterSequence: String(afterSequence),
    limit: "200",
  });
  return parseEventPage(
    await requestJson(
      fetchImpl,
      endpoint(
        baseUrl,
        `sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`,
      ),
    ),
  );
}

async function postToolResult(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  toolCall: VoiceSessionToolCall,
  result: VoiceSessionToolDispatchResult,
): Promise<void> {
  await requestJson(
    fetchImpl,
    endpoint(
      baseUrl,
      `sessions/${encodeURIComponent(toolCall.sessionId)}/tool-results`,
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        executionId: toolCall.eventExecutionId,
        tool: toolCall.tool,
        ...(result.status === "succeeded"
          ? { output: result.output }
          : { error: result.error }),
      }),
    },
  );
}

function toolCallFromEvent(
  event: VoiceAgentSessionEvent,
): VoiceSessionToolCall | undefined {
  if (event.data.type !== "tool_call") {
    return undefined;
  }
  if (!isExecutionId(event.data.executionId)) {
    throw new VoiceSessionDriverError(
      "Pipecat returned an invalid tool-call execution ID.",
    );
  }
  return {
    sessionId: event.sessionId,
    sequence: event.sequence,
    eventExecutionId: event.data.executionId,
    tool: qualifiedToolName(event.data.tool),
    input: event.data.input,
  };
}

function humanTurnFromEvent(
  event: VoiceAgentSessionEvent,
): VoiceSessionHumanTurn | undefined {
  if (event.data.type !== "turn.transcript" || event.data.speaker !== "human") {
    return undefined;
  }
  return {
    sessionId: event.sessionId,
    eventSequence: event.sequence,
    turnId: event.data.turnId,
    text: event.data.text,
    startMs: event.data.startMs,
    endMs: event.data.endMs,
  };
}

async function eventHistory(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  sessionId: string,
): Promise<readonly VoiceAgentSessionEvent[]> {
  const events: VoiceAgentSessionEvent[] = [];
  let cursor = 0;
  for (;;) {
    const page = await eventPage(fetchImpl, baseUrl, sessionId, cursor);
    for (const event of page.events) {
      if (event.sessionId !== sessionId || event.sequence !== cursor + 1) {
        throw new VoiceSessionDriverError(
          "Pipecat returned events outside the requested gap-free session sequence.",
        );
      }
      events.push(event);
      cursor = event.sequence;
    }
    if (page.nextSequence !== cursor) {
      throw new VoiceSessionDriverError(
        "Pipecat returned an inconsistent event cursor.",
      );
    }
    if (!page.hasMore) {
      return events;
    }
    if (page.events.length === 0) {
      throw new VoiceSessionDriverError(
        "Pipecat returned an event page that cannot make progress.",
      );
    }
  }
}

async function postAgentTurn(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  sessionId: string,
  turn: VoiceSessionAgentTurn,
): Promise<void> {
  if (turn.text.trim().length === 0) {
    throw new VoiceSessionDriverError(
      "The voice-session turn handler returned empty agent text.",
    );
  }
  await requestJson(
    fetchImpl,
    endpoint(baseUrl, `sessions/${encodeURIComponent(sessionId)}/turns`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: turn.text,
        ...(turn.toolCall === undefined
          ? {}
          : {
              toolCall: {
                tool: turn.toolCall.tool,
                input: turn.toolCall.input,
              },
            }),
      }),
    },
  );
}

function terminalState(
  state: VoiceAgentSessionState,
): state is VoiceSessionDriverResult["state"] {
  return TERMINAL_SESSION_STATES.has(state);
}

/**
 * Processes the currently durable Pipecat events and performs at most one
 * external action (a tool dispatch or an agent turn). It never sleeps or
 * advances time; callers own scheduling and persist the returned cursor.
 */
export async function runVoiceSessionDriverTick(
  options: VoiceSessionDriverTickOptions,
): Promise<VoiceSessionDriverTickResult> {
  executionTarget(options);
  const initialSequence = options.sessionRef.afterSequence ?? 0;
  if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
    throw new VoiceSessionDriverError(
      "sessionRef.afterSequence must be a non-negative integer.",
    );
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const before = await sessionSnapshot(
    fetchImpl,
    options.pipecatBaseUrl,
    options.sessionRef.sessionId,
  );
  assertSessionScope(before, options.sessionRef, options.agentRevision);
  if (initialSequence > before.lastEventSequence) {
    throw new VoiceSessionDriverError(
      "The voice-session event cursor is ahead of Pipecat's durable sequence.",
    );
  }

  const observedEvents = new Map<number, VoiceAgentSessionEvent>();
  const dispatches: VoiceSessionDispatchRecord[] = [];
  const agentTurns: VoiceSessionAgentTurn[] = [];
  let cursor = initialSequence;
  for (;;) {
    const page = await eventPage(
      fetchImpl,
      options.pipecatBaseUrl,
      options.sessionRef.sessionId,
      cursor,
    );
    for (const event of page.events) {
      if (
        event.sessionId !== options.sessionRef.sessionId ||
        event.sequence !== cursor + 1
      ) {
        throw new VoiceSessionDriverError(
          "Pipecat returned events outside the requested gap-free session sequence.",
        );
      }
      observedEvents.set(event.sequence, event);
      cursor = event.sequence;
    }
    if (page.nextSequence !== cursor) {
      throw new VoiceSessionDriverError(
        "Pipecat returned an inconsistent event cursor.",
      );
    }
    if (!page.hasMore) {
      break;
    }
    if (page.events.length === 0) {
      throw new VoiceSessionDriverError(
        "Pipecat returned an event page that cannot make progress.",
      );
    }
  }

  async function loadHistory(): Promise<void> {
    for (const event of await eventHistory(
      fetchImpl,
      options.pipecatBaseUrl,
      options.sessionRef.sessionId,
    )) {
      observedEvents.set(event.sequence, event);
    }
  }

  let pendingEvent = [...observedEvents.values()].find((event) => {
    const call = toolCallFromEvent(event);
    return call?.eventExecutionId === before.pendingToolCall?.executionId;
  });
  if (before.pendingToolCall !== undefined && pendingEvent === undefined) {
    await loadHistory();
    pendingEvent = [...observedEvents.values()].find((event) => {
      const call = toolCallFromEvent(event);
      return call?.eventExecutionId === before.pendingToolCall?.executionId;
    });
  }

  const pendingToolCall =
    pendingEvent === undefined ? undefined : toolCallFromEvent(pendingEvent);
  if (before.pendingToolCall !== undefined) {
    if (pendingToolCall === undefined) {
      throw new VoiceSessionDriverError(
        "Pipecat's pending tool call has no matching durable event.",
      );
    }
    const result =
      options.executionEngine === undefined
        ? await dispatchVoiceSessionToolCall({
            agentRevision: options.agentRevision,
            toolCall: pendingToolCall,
            executorClient:
              options.executorClient as VoiceSessionExecutorClient,
          })
        : await dispatchVoiceSessionToolCall({
            agentRevision: options.agentRevision,
            toolCall: pendingToolCall,
            executionEngine: options.executionEngine,
          });
    await postToolResult(
      fetchImpl,
      options.pipecatBaseUrl,
      pendingToolCall,
      result,
    );
    dispatches.push({
      eventSequence: pendingToolCall.sequence,
      eventExecutionId: pendingToolCall.eventExecutionId,
      tool: pendingToolCall.tool,
      result,
    });
  } else if (before.awaitingAgentTurn && options.turnHandler !== undefined) {
    let humanTurn = [...observedEvents.values()]
      .map(humanTurnFromEvent)
      .filter((turn): turn is VoiceSessionHumanTurn => turn !== undefined)
      .sort((left, right) => right.eventSequence - left.eventSequence)[0];
    if (humanTurn === undefined) {
      await loadHistory();
      humanTurn = [...observedEvents.values()]
        .map(humanTurnFromEvent)
        .filter((turn): turn is VoiceSessionHumanTurn => turn !== undefined)
        .sort((left, right) => right.eventSequence - left.eventSequence)[0];
    }
    if (humanTurn === undefined) {
      throw new VoiceSessionDriverError(
        "Pipecat is awaiting an agent turn without a durable human transcript.",
      );
    }
    let turn: VoiceSessionAgentTurn;
    try {
      turn = await options.turnHandler.respond({
        agentRevision: options.agentRevision,
        humanTurn,
      });
    } catch {
      throw new VoiceSessionDriverError(
        "The voice-session turn handler failed unexpectedly.",
      );
    }
    if (turn.toolCall !== undefined) {
      qualifiedToolName(turn.toolCall.tool);
      if (!isRecord(turn.toolCall.input)) {
        throw new VoiceSessionDriverError(
          "The voice-session turn handler returned invalid tool input.",
        );
      }
    }
    await postAgentTurn(
      fetchImpl,
      options.pipecatBaseUrl,
      options.sessionRef.sessionId,
      turn,
    );
    agentTurns.push(turn);
  }

  const after = await sessionSnapshot(
    fetchImpl,
    options.pipecatBaseUrl,
    options.sessionRef.sessionId,
  );
  assertSessionScope(after, options.sessionRef, options.agentRevision);
  if (terminalState(after.state) && cursor < after.lastEventSequence) {
    for (;;) {
      const page = await eventPage(
        fetchImpl,
        options.pipecatBaseUrl,
        options.sessionRef.sessionId,
        cursor,
      );
      for (const event of page.events) {
        if (
          event.sessionId !== options.sessionRef.sessionId ||
          event.sequence !== cursor + 1
        ) {
          throw new VoiceSessionDriverError(
            "Pipecat returned terminal events outside the requested gap-free session sequence.",
          );
        }
        observedEvents.set(event.sequence, event);
        cursor = event.sequence;
      }
      if (page.nextSequence !== cursor) {
        throw new VoiceSessionDriverError(
          "Pipecat returned an inconsistent terminal event cursor.",
        );
      }
      if (!page.hasMore) break;
      if (page.events.length === 0) {
        throw new VoiceSessionDriverError(
          "Pipecat returned a terminal event page that cannot make progress.",
        );
      }
    }
  }
  return {
    sessionId: after.id,
    state: after.state,
    lastSequence: cursor,
    terminal: terminalState(after.state),
    events: [...observedEvents.values()]
      .filter(
        (event) => event.sequence > initialSequence && event.sequence <= cursor,
      )
      .sort((left, right) => left.sequence - right.sequence),
    dispatches,
    agentTurns,
  };
}

/** Polls Pipecat's mock event stream and dispatches every durable tool call exactly once. */
export async function runVoiceSessionDriver(
  options: VoiceSessionDriverOptions,
): Promise<VoiceSessionDriverResult> {
  executionTarget(options);
  const timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "timeoutMs");
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs ?? 100,
    "pollIntervalMs",
  );
  const initialSequence = options.sessionRef.afterSequence ?? 0;
  if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
    throw new VoiceSessionDriverError(
      "sessionRef.afterSequence must be a non-negative integer.",
    );
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const startedAt = clockMilliseconds(options.clock);
  let cursor = initialSequence;
  const dispatches: VoiceSessionDispatchRecord[] = [];
  const agentTurns: VoiceSessionAgentTurn[] = [];
  const observedEvents = new Map<number, VoiceAgentSessionEvent>();

  async function dispatchAndPost(
    toolCall: VoiceSessionToolCall,
  ): Promise<void> {
    const result =
      options.executionEngine === undefined
        ? await dispatchVoiceSessionToolCall({
            agentRevision: options.agentRevision,
            toolCall,
            executorClient:
              options.executorClient as VoiceSessionExecutorClient,
          })
        : await dispatchVoiceSessionToolCall({
            agentRevision: options.agentRevision,
            toolCall,
            executionEngine: options.executionEngine,
          });
    await postToolResult(fetchImpl, options.pipecatBaseUrl, toolCall, result);
    dispatches.push({
      eventSequence: toolCall.sequence,
      eventExecutionId: toolCall.eventExecutionId,
      tool: toolCall.tool,
      result,
    });
  }

  async function loadHistory(): Promise<void> {
    for (const event of await eventHistory(
      fetchImpl,
      options.pipecatBaseUrl,
      options.sessionRef.sessionId,
    )) {
      observedEvents.set(event.sequence, event);
    }
  }

  for (;;) {
    const before = await sessionSnapshot(
      fetchImpl,
      options.pipecatBaseUrl,
      options.sessionRef.sessionId,
    );
    assertSessionScope(before, options.sessionRef, options.agentRevision);
    if (cursor > before.lastEventSequence) {
      throw new VoiceSessionDriverError(
        "The voice-session event cursor is ahead of Pipecat's durable sequence.",
      );
    }

    const page = await eventPage(
      fetchImpl,
      options.pipecatBaseUrl,
      options.sessionRef.sessionId,
      cursor,
    );
    let dispatchedPendingCall = false;
    for (const event of page.events) {
      if (
        event.sessionId !== options.sessionRef.sessionId ||
        event.sequence !== cursor + 1
      ) {
        throw new VoiceSessionDriverError(
          "Pipecat returned events outside the requested gap-free session sequence.",
        );
      }
      observedEvents.set(event.sequence, event);
      const toolCall = toolCallFromEvent(event);
      if (
        toolCall !== undefined &&
        before.pendingToolCall?.executionId === toolCall.eventExecutionId
      ) {
        await dispatchAndPost(toolCall);
        dispatchedPendingCall = true;
      }
      cursor = event.sequence;
    }
    if (page.nextSequence !== cursor) {
      throw new VoiceSessionDriverError(
        "Pipecat returned an inconsistent event cursor.",
      );
    }
    if (page.hasMore) {
      continue;
    }

    if (before.pendingToolCall !== undefined && !dispatchedPendingCall) {
      let pendingEvent = [...observedEvents.values()].find((event) => {
        const toolCall = toolCallFromEvent(event);
        return (
          toolCall?.eventExecutionId === before.pendingToolCall?.executionId
        );
      });
      if (pendingEvent === undefined) {
        await loadHistory();
        pendingEvent = [...observedEvents.values()].find((event) => {
          const toolCall = toolCallFromEvent(event);
          return (
            toolCall?.eventExecutionId === before.pendingToolCall?.executionId
          );
        });
      }
      const pendingToolCall =
        pendingEvent === undefined
          ? undefined
          : toolCallFromEvent(pendingEvent);
      if (pendingToolCall === undefined) {
        throw new VoiceSessionDriverError(
          "Pipecat's pending tool call has no matching durable event.",
        );
      }
      await dispatchAndPost(pendingToolCall);
      continue;
    }
    if (dispatchedPendingCall) {
      continue;
    }

    if (before.awaitingAgentTurn && options.turnHandler !== undefined) {
      let humanTurn = [...observedEvents.values()]
        .map(humanTurnFromEvent)
        .filter((turn): turn is VoiceSessionHumanTurn => turn !== undefined)
        .sort((left, right) => right.eventSequence - left.eventSequence)[0];
      if (humanTurn === undefined) {
        await loadHistory();
        humanTurn = [...observedEvents.values()]
          .map(humanTurnFromEvent)
          .filter((turn): turn is VoiceSessionHumanTurn => turn !== undefined)
          .sort((left, right) => right.eventSequence - left.eventSequence)[0];
      }
      if (humanTurn === undefined) {
        throw new VoiceSessionDriverError(
          "Pipecat is awaiting an agent turn without a durable human transcript.",
        );
      }
      let turn: VoiceSessionAgentTurn;
      try {
        turn = await options.turnHandler.respond({
          agentRevision: options.agentRevision,
          humanTurn,
        });
      } catch {
        throw new VoiceSessionDriverError(
          "The voice-session turn handler failed unexpectedly.",
        );
      }
      if (turn.toolCall !== undefined) {
        qualifiedToolName(turn.toolCall.tool);
        if (!isRecord(turn.toolCall.input)) {
          throw new VoiceSessionDriverError(
            "The voice-session turn handler returned invalid tool input.",
          );
        }
      }
      await postAgentTurn(
        fetchImpl,
        options.pipecatBaseUrl,
        options.sessionRef.sessionId,
        turn,
      );
      agentTurns.push(turn);
      continue;
    }

    const after = await sessionSnapshot(
      fetchImpl,
      options.pipecatBaseUrl,
      options.sessionRef.sessionId,
    );
    assertSessionScope(after, options.sessionRef, options.agentRevision);
    if (cursor < after.lastEventSequence) {
      continue;
    }
    if (terminalState(after.state) && cursor >= after.lastEventSequence) {
      return {
        sessionId: after.id,
        state: after.state,
        lastSequence: cursor,
        events: [...observedEvents.values()]
          .filter(
            (event) =>
              event.sequence > initialSequence && event.sequence <= cursor,
          )
          .sort((left, right) => left.sequence - right.sequence),
        dispatches,
        agentTurns,
      };
    }

    const now = clockMilliseconds(options.clock);
    const elapsed = now - startedAt;
    if (elapsed >= timeoutMs) {
      throw new VoiceSessionDriverTimeoutError(after.id, cursor);
    }
    const advanceBy = Math.min(pollIntervalMs, timeoutMs - elapsed);
    await options.clock.advance(advanceBy);
    if (clockMilliseconds(options.clock) <= now) {
      throw new VoiceSessionDriverError(
        "The voice-session driver clock did not advance.",
      );
    }
  }
}
