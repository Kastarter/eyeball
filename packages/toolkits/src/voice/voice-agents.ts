import { randomUUID } from "node:crypto";
import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  type QualifiedToolName,
  TOOL_ERROR_CODES,
  type ToolDefinition,
  type ToolkitAdapter,
  VOICE_WORKER_CONTRACT_VERSION,
  type VoiceAgentDefinition,
  type VoiceAgentDraft,
  type VoiceAgentSession,
  type VoiceAgentSessionEvent,
  type VoiceAgentSessionEventData,
  type VoiceAgentSessionState,
  type VoiceAgentSummary,
  type VoiceAgentTransport,
  type VoiceWorkerChatTurnResponse,
  type VoiceWorkerStartSessionRequest,
  validateVoiceAgentDraft,
} from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  asJson,
  booleanValue,
  isRecord,
  jsonObject,
  jsonRequest,
  numberValue,
  providerError,
  records,
  requiredInputString,
  requiredStringField,
  stringValue,
  unsupportedTool,
} from "../messaging/common.js";
import type { VoiceSessionDriver } from "./session-driver.js";
import { voiceTranscriptFromEvents } from "./transcript.js";
import { resolveOutboundTransport } from "./transport-resolver.js";

export interface VoiceAgentBinding {
  bindingId: string;
  projectId: string;
  userId: string;
  agentId: string;
  revision: number;
  phoneNumber: string;
  transportConnectionId: string;
  createdAt: string;
}

export interface VoiceAgentSessionPointer {
  sessionId: string;
  projectId: string;
  userId: string;
  agentId: string;
  agentRevision: number;
  callId: string;
  createdAt: string;
  grantId?: string;
  grantExpiresAt?: string;
  grantRevokedAt?: string;
}

export interface VoiceSessionGrantIssuer {
  issue(input: {
    projectId: string;
    userId: string;
    sessionId: string;
    maxDurationSeconds: number;
    allowedTools: readonly QualifiedToolName[];
  }): Promise<{
    token: string;
    grantId: string;
    expiresAt: string;
  }>;
}

/** Executor-owned lifecycle seam that makes remote starts restart-recoverable. */
export interface VoiceSessionObservationLifecycle {
  prepare(pointer: VoiceAgentSessionPointer): Promise<void>;
  activate(pointer: VoiceAgentSessionPointer): Promise<void>;
  /** Returns the authoritative session when an ambiguous start was reconciled. */
  handleStartFailure(input: {
    pointer: VoiceAgentSessionPointer;
    error: unknown;
  }): Promise<VoiceAgentSession | undefined>;
}

export interface VoiceAgentMessageReceipt {
  sessionId: string;
  clientMessageId: string;
  message: string;
  userMessageId: string;
  assistantMessage: string;
}

export interface VoiceProviderToolRequest {
  projectId: string;
  userId: string;
  tool: QualifiedToolName;
  connectionId: string;
  input: Readonly<Record<string, JsonValue>>;
}

export type VoiceProviderToolExecutor = (
  request: VoiceProviderToolRequest,
) => Promise<JsonValue>;

export interface AgentStore {
  createAgent(
    projectId: string,
    draft: VoiceAgentDraft,
    createdAt: string,
  ): Promise<VoiceAgentDefinition>;
  getAgent(
    projectId: string,
    agentId: string,
    revision?: number,
  ): Promise<VoiceAgentDefinition>;
  getRunnableAgent(
    projectId: string,
    agentId: string,
    revision?: number,
  ): Promise<VoiceAgentDefinition>;
  listAgents(
    projectId: string,
    includeDeleted: boolean,
  ): Promise<readonly VoiceAgentSummary[]>;
  updateAgent(
    projectId: string,
    agentId: string,
    expectedRevision: number,
    draft: VoiceAgentDraft,
    createdAt: string,
  ): Promise<VoiceAgentDefinition>;
  deleteAgent(
    projectId: string,
    agentId: string,
    expectedRevision: number,
    deletedAt: string,
  ): Promise<{ agentId: string; deletedAt: string }>;
  attachNumber(
    input: Omit<VoiceAgentBinding, "bindingId" | "createdAt">,
    createdAt: string,
  ): Promise<VoiceAgentBinding>;
  getNumberBinding(
    projectId: string,
    phoneNumber: string,
  ): Promise<VoiceAgentBinding | undefined>;
  listNumberBindings(projectId: string): Promise<readonly VoiceAgentBinding[]>;
  detachNumber(
    projectId: string,
    userId: string,
    phoneNumber: string,
  ): Promise<VoiceAgentBinding | undefined>;
  rememberSession(pointer: VoiceAgentSessionPointer): Promise<void>;
  revokeSessionGrant(input: {
    projectId: string;
    userId: string;
    sessionId: string;
    grantId?: string;
    revokedAt: string;
  }): Promise<void>;
  getSession(
    projectId: string,
    userId: string,
    sessionId: string,
  ): Promise<VoiceAgentSessionPointer>;
  listSessions(
    projectId: string,
    userId: string,
  ): Promise<readonly VoiceAgentSessionPointer[]>;
  getMessage(
    projectId: string,
    userId: string,
    sessionId: string,
    clientMessageId: string,
  ): Promise<VoiceAgentMessageReceipt | undefined>;
  rememberMessage(
    projectId: string,
    userId: string,
    receipt: VoiceAgentMessageReceipt,
  ): Promise<void>;
}

interface AgentResource {
  projectId: string;
  activeRevision: number;
  revisions: Map<number, VoiceAgentDefinition>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | undefined;
}

function storeError(
  code: "invalid_input" | "not_found",
  message: string,
): never {
  throw new EyeballError({ code, message });
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function scopedKey(...parts: readonly string[]): string {
  return parts.join("\u0000");
}

/** Deterministic, process-local RFC 002 store. A durable implementation can be injected. */
export class InMemoryAgentStore implements AgentStore {
  readonly #agents = new Map<string, AgentResource>();
  readonly #bindings = new Map<string, VoiceAgentBinding>();
  readonly #sessions = new Map<string, VoiceAgentSessionPointer>();
  readonly #messages = new Map<string, VoiceAgentMessageReceipt>();
  #agentSequence = 0;
  #bindingSequence = 0;

  async createAgent(
    projectId: string,
    draft: VoiceAgentDraft,
    createdAt: string,
  ): Promise<VoiceAgentDefinition> {
    this.#agentSequence += 1;
    const id = `va_${String(this.#agentSequence).padStart(6, "0")}`;
    const definition: VoiceAgentDefinition = {
      ...copy(draft),
      id,
      revision: 1,
      createdAt,
    };
    this.#agents.set(scopedKey(projectId, id), {
      projectId,
      activeRevision: 1,
      revisions: new Map([[1, definition]]),
      createdAt,
      updatedAt: createdAt,
      deletedAt: undefined,
    });
    return copy(definition);
  }

  async getAgent(
    projectId: string,
    agentId: string,
    revision?: number,
  ): Promise<VoiceAgentDefinition> {
    const resource = this.#resource(projectId, agentId);
    const resolvedRevision = revision ?? resource.activeRevision;
    const definition = resource.revisions.get(resolvedRevision);
    if (definition === undefined) {
      return storeError(
        TOOL_ERROR_CODES.NOT_FOUND,
        `Voice agent ${agentId} revision ${resolvedRevision} was not found.`,
      );
    }
    return copy(definition);
  }

  async getRunnableAgent(
    projectId: string,
    agentId: string,
    revision?: number,
  ): Promise<VoiceAgentDefinition> {
    const resource = this.#resource(projectId, agentId);
    if (resource.deletedAt !== undefined) {
      return storeError(
        TOOL_ERROR_CODES.NOT_FOUND,
        `Voice agent ${agentId} is deleted and cannot start new sessions.`,
      );
    }
    return await this.getAgent(projectId, agentId, revision);
  }

  async listAgents(
    projectId: string,
    includeDeleted: boolean,
  ): Promise<readonly VoiceAgentSummary[]> {
    return [...this.#agents.values()]
      .filter(
        (resource) =>
          resource.projectId === projectId &&
          (includeDeleted || resource.deletedAt === undefined),
      )
      .map((resource) => {
        const active = resource.revisions.get(resource.activeRevision);
        if (active === undefined) {
          throw new Error(
            "AgentStore invariant violated: active revision is absent.",
          );
        }
        return {
          id: active.id,
          activeRevision: resource.activeRevision,
          name: active.name,
          transport: active.transport,
          ...(resource.deletedAt === undefined
            ? {}
            : { deletedAt: resource.deletedAt }),
          createdAt: resource.createdAt,
          updatedAt: resource.updatedAt,
        } satisfies VoiceAgentSummary;
      })
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .map(copy);
  }

  async updateAgent(
    projectId: string,
    agentId: string,
    expectedRevision: number,
    draft: VoiceAgentDraft,
    createdAt: string,
  ): Promise<VoiceAgentDefinition> {
    const resource = this.#resource(projectId, agentId);
    if (resource.deletedAt !== undefined) {
      return storeError(
        TOOL_ERROR_CODES.NOT_FOUND,
        `Voice agent ${agentId} is deleted and cannot be updated.`,
      );
    }
    if (resource.activeRevision !== expectedRevision) {
      return storeError(
        TOOL_ERROR_CODES.INVALID_INPUT,
        `Voice agent ${agentId} is at revision ${resource.activeRevision}; expected ${expectedRevision}.`,
      );
    }
    const revision = resource.activeRevision + 1;
    const definition: VoiceAgentDefinition = {
      ...copy(draft),
      id: agentId,
      revision,
      createdAt,
    };
    resource.revisions.set(revision, definition);
    resource.activeRevision = revision;
    resource.updatedAt = createdAt;
    return copy(definition);
  }

  async deleteAgent(
    projectId: string,
    agentId: string,
    expectedRevision: number,
    deletedAt: string,
  ): Promise<{ agentId: string; deletedAt: string }> {
    const resource = this.#resource(projectId, agentId);
    if (resource.deletedAt !== undefined) {
      return { agentId, deletedAt: resource.deletedAt };
    }
    if (resource.activeRevision !== expectedRevision) {
      return storeError(
        TOOL_ERROR_CODES.INVALID_INPUT,
        `Voice agent ${agentId} is at revision ${resource.activeRevision}; expected ${expectedRevision}.`,
      );
    }
    resource.deletedAt = deletedAt;
    resource.updatedAt = deletedAt;
    return { agentId, deletedAt };
  }

  async attachNumber(
    input: Omit<VoiceAgentBinding, "bindingId" | "createdAt">,
    createdAt: string,
  ): Promise<VoiceAgentBinding> {
    const key = scopedKey(input.projectId, input.phoneNumber);
    const existing = this.#bindings.get(key);
    if (existing !== undefined) {
      if (
        existing.userId === input.userId &&
        existing.agentId === input.agentId &&
        existing.revision === input.revision &&
        existing.transportConnectionId === input.transportConnectionId
      ) {
        return copy(existing);
      }
      return storeError(
        TOOL_ERROR_CODES.INVALID_INPUT,
        `Phone number ${input.phoneNumber} already has a different voice-agent binding.`,
      );
    }
    this.#bindingSequence += 1;
    const binding: VoiceAgentBinding = {
      ...input,
      bindingId: `binding_${String(this.#bindingSequence).padStart(6, "0")}`,
      createdAt,
    };
    this.#bindings.set(key, binding);
    return copy(binding);
  }

  async getNumberBinding(
    projectId: string,
    phoneNumber: string,
  ): Promise<VoiceAgentBinding | undefined> {
    const binding = this.#bindings.get(scopedKey(projectId, phoneNumber));
    return binding === undefined ? undefined : copy(binding);
  }

  async listNumberBindings(
    projectId: string,
  ): Promise<readonly VoiceAgentBinding[]> {
    return [...this.#bindings.values()]
      .filter((binding) => binding.projectId === projectId)
      .sort(
        (left, right) =>
          left.phoneNumber.localeCompare(right.phoneNumber) ||
          left.bindingId.localeCompare(right.bindingId),
      )
      .map(copy);
  }

  async detachNumber(
    projectId: string,
    userId: string,
    phoneNumber: string,
  ): Promise<VoiceAgentBinding | undefined> {
    const key = scopedKey(projectId, phoneNumber);
    const binding = this.#bindings.get(key);
    if (binding === undefined) return undefined;
    if (binding.userId !== userId) {
      return storeError(
        TOOL_ERROR_CODES.NOT_FOUND,
        `Phone number ${phoneNumber} has no binding in the trusted user scope.`,
      );
    }
    this.#bindings.delete(key);
    return copy(binding);
  }

  async rememberSession(pointer: VoiceAgentSessionPointer): Promise<void> {
    if (
      (pointer.grantId === undefined) !==
      (pointer.grantExpiresAt === undefined)
    ) {
      throw new Error(
        "AgentStore invariant violated: grant identity and expiry must be stored together.",
      );
    }
    if (pointer.grantRevokedAt !== undefined && pointer.grantId === undefined) {
      throw new Error(
        "AgentStore invariant violated: a static session cannot have grant revocation state.",
      );
    }
    const existing = this.#sessions.get(pointer.sessionId);
    if (
      existing !== undefined &&
      (existing.projectId !== pointer.projectId ||
        existing.userId !== pointer.userId)
    ) {
      throw new Error("AgentStore invariant violated: session scope changed.");
    }
    if (
      existing !== undefined &&
      (existing.grantId !== pointer.grantId ||
        existing.grantExpiresAt !== pointer.grantExpiresAt)
    ) {
      throw new Error("AgentStore invariant violated: session grant changed.");
    }
    this.#sessions.set(
      pointer.sessionId,
      copy({
        ...pointer,
        ...(existing?.grantRevokedAt === undefined
          ? {}
          : { grantRevokedAt: existing.grantRevokedAt }),
      }),
    );
  }

  async revokeSessionGrant(input: {
    projectId: string;
    userId: string;
    sessionId: string;
    grantId?: string;
    revokedAt: string;
  }): Promise<void> {
    const existing = this.#sessions.get(input.sessionId);
    if (
      existing === undefined ||
      existing.projectId !== input.projectId ||
      existing.userId !== input.userId ||
      existing.grantId === undefined ||
      (input.grantId !== undefined && existing.grantId !== input.grantId) ||
      existing.grantRevokedAt !== undefined
    ) {
      return;
    }
    this.#sessions.set(input.sessionId, {
      ...existing,
      grantRevokedAt: input.revokedAt,
    });
  }

  async getSession(
    projectId: string,
    userId: string,
    sessionId: string,
  ): Promise<VoiceAgentSessionPointer> {
    const pointer = this.#sessions.get(sessionId);
    if (
      pointer === undefined ||
      pointer.projectId !== projectId ||
      pointer.userId !== userId
    ) {
      return storeError(
        TOOL_ERROR_CODES.NOT_FOUND,
        `Voice-agent session ${sessionId} was not found in the trusted scope.`,
      );
    }
    return copy(pointer);
  }

  async listSessions(
    projectId: string,
    userId: string,
  ): Promise<readonly VoiceAgentSessionPointer[]> {
    return [...this.#sessions.values()]
      .filter(
        (pointer) =>
          pointer.projectId === projectId && pointer.userId === userId,
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.sessionId.localeCompare(left.sessionId),
      )
      .map(copy);
  }

  async getMessage(
    projectId: string,
    userId: string,
    sessionId: string,
    clientMessageId: string,
  ): Promise<VoiceAgentMessageReceipt | undefined> {
    const receipt = this.#messages.get(
      scopedKey(projectId, userId, sessionId, clientMessageId),
    );
    return receipt === undefined ? undefined : copy(receipt);
  }

  async rememberMessage(
    projectId: string,
    userId: string,
    receipt: VoiceAgentMessageReceipt,
  ): Promise<void> {
    this.#messages.set(
      scopedKey(projectId, userId, receipt.sessionId, receipt.clientMessageId),
      copy(receipt),
    );
  }

  #resource(projectId: string, agentId: string): AgentResource {
    const resource = this.#agents.get(scopedKey(projectId, agentId));
    if (resource === undefined) {
      return storeError(
        TOOL_ERROR_CODES.NOT_FOUND,
        `Voice agent ${agentId} was not found.`,
      );
    }
    return resource;
  }
}

function requiredInteger(context: AdapterContext, key: string): number {
  const value = numberValue(context.canonicalInput, key);
  if (value === undefined || !Number.isInteger(value)) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name}: ${key} must be an integer.`,
    });
  }
  return value;
}

function optionalInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = numberValue(input, key);
  return value === undefined || !Number.isInteger(value) ? undefined : value;
}

function draftFromInput(context: AdapterContext): VoiceAgentDraft {
  const validation = validateVoiceAgentDraft(context.canonicalInput.agent);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name}: invalid voice-agent definition${first === undefined ? "." : ` at ${first.instancePath || "/"}: ${first.message}`}`,
    });
  }
  return validation.value as unknown as VoiceAgentDraft;
}

async function pipecatObject(
  context: AdapterContext,
  path: string,
  init?: RequestInit,
): Promise<Readonly<Record<string, unknown>>> {
  return jsonObject(
    context,
    await createProviderHttpClient(context)(path, init),
  );
}

function parseTransport(
  context: AdapterContext,
  value: unknown,
): VoiceAgentTransport {
  if (
    value === "pstn:twilio" ||
    value === "webrtc:livekit" ||
    value === "chat"
  ) {
    return value;
  }
  throw providerError(
    context,
    "Pipecat returned an invalid session transport.",
  );
}

function parseState(
  context: AdapterContext,
  value: unknown,
): VoiceAgentSessionState {
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
  throw providerError(context, "Pipecat returned an invalid session state.");
}

function sessionFromProvider(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): VoiceAgentSession {
  const agentRevision = numberValue(value, "agentRevision");
  const lastEventSequence = numberValue(value, "lastEventSequence");
  if (
    agentRevision === undefined ||
    !Number.isInteger(agentRevision) ||
    lastEventSequence === undefined ||
    !Number.isInteger(lastEventSequence)
  ) {
    throw providerError(context, "Pipecat returned invalid session counters.");
  }
  return {
    id: requiredStringField(context, value, "id"),
    projectId: requiredStringField(context, value, "projectId"),
    agentId: requiredStringField(context, value, "agentId"),
    agentRevision,
    transport: parseTransport(context, value.transport),
    state: parseState(context, value.state),
    userId: requiredStringField(context, value, "userId"),
    createdAt: requiredStringField(context, value, "createdAt"),
    ...(typeof value.startedAt === "string"
      ? { startedAt: value.startedAt }
      : {}),
    ...(typeof value.completedAt === "string"
      ? { completedAt: value.completedAt }
      : {}),
    lastEventSequence,
  };
}

function assertTrustedSession(
  context: AdapterContext,
  session: VoiceAgentSession,
  pointer: VoiceAgentSessionPointer,
): void {
  if (
    session.projectId !== context.projectId ||
    session.userId !== context.userId ||
    session.id !== pointer.sessionId ||
    session.agentId !== pointer.agentId ||
    session.agentRevision !== pointer.agentRevision
  ) {
    throw providerError(
      context,
      "Pipecat returned a session outside the pinned trusted scope.",
    );
  }
}

function eventFromProvider(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): VoiceAgentSessionEvent {
  const sequence = numberValue(value, "sequence");
  if (sequence === undefined || !Number.isInteger(sequence) || sequence < 1) {
    throw providerError(context, "Pipecat returned an invalid event sequence.");
  }
  const data = value.data;
  if (!isRecord(data) || typeof data.type !== "string") {
    throw providerError(context, "Pipecat returned invalid event data.");
  }
  return {
    id: requiredStringField(context, value, "id"),
    sessionId: requiredStringField(context, value, "sessionId"),
    sequence,
    createdAt: requiredStringField(context, value, "createdAt"),
    data: copy(data) as unknown as VoiceAgentSessionEventData,
  };
}

async function eventPage(
  context: AdapterContext,
  sessionId: string,
  afterSequence: number,
  limit: number,
): Promise<{
  events: readonly VoiceAgentSessionEvent[];
  nextSequence: number;
  hasMore: boolean;
}> {
  const query = new URLSearchParams({
    afterSequence: String(afterSequence),
    limit: String(limit),
  });
  const body = await pipecatObject(
    context,
    `sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`,
  );
  const nextSequence = numberValue(body, "nextSequence");
  if (nextSequence === undefined || !Number.isInteger(nextSequence)) {
    throw providerError(context, "Pipecat returned an invalid event cursor.");
  }
  if (typeof body.hasMore !== "boolean") {
    throw providerError(
      context,
      "Pipecat returned an invalid event page flag.",
    );
  }
  const events = records(body.events).map((event) =>
    eventFromProvider(context, event),
  );
  let expectedSequence = afterSequence + 1;
  for (const event of events) {
    if (event.sessionId !== sessionId || event.sequence !== expectedSequence) {
      throw providerError(
        context,
        "Pipecat returned events outside the requested gap-free session sequence.",
      );
    }
    expectedSequence += 1;
  }
  if (nextSequence !== (events.at(-1)?.sequence ?? afterSequence)) {
    throw providerError(
      context,
      "Pipecat returned an inconsistent event cursor.",
    );
  }
  return {
    events,
    nextSequence,
    hasMore: body.hasMore,
  };
}

async function allEvents(
  context: AdapterContext,
  sessionId: string,
): Promise<readonly VoiceAgentSessionEvent[]> {
  const events: VoiceAgentSessionEvent[] = [];
  let cursor = 0;
  for (;;) {
    const page = await eventPage(context, sessionId, cursor, 200);
    events.push(...page.events);
    if (!page.hasMore || page.nextSequence <= cursor) {
      return events.sort((left, right) => left.sequence - right.sequence);
    }
    cursor = page.nextSequence;
  }
}

function cursorOffset(
  context: AdapterContext,
  cursor: string | undefined,
): number {
  if (cursor === undefined) {
    return 0;
  }
  const match = /^offset:(\d+)$/u.exec(cursor);
  const offset = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name}: cursor is invalid.`,
    });
  }
  return offset;
}

function page<T>(values: readonly T[], offset: number, limit: number) {
  const items = values.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    ...(nextOffset < values.length
      ? { nextCursor: `offset:${nextOffset}` }
      : {}),
  };
}

export interface VoiceAgentsAdapterOptions {
  store?: AgentStore;
  sessionDriver?: VoiceSessionDriver;
  /** Dedicated service-authenticated transport for the local Pipecat runtime. */
  sessionRuntimeFetch?: typeof globalThis.fetch;
  resolveTool?: (name: QualifiedToolName) => ToolDefinition | undefined;
  executeProviderTool?: VoiceProviderToolExecutor;
  voiceSessionGrantIssuer?: VoiceSessionGrantIssuer;
  remoteObservationLifecycle?: VoiceSessionObservationLifecycle;
}

/** Native RFC 002 adapter backed by an injectable revision store and Pipecat. */
export class VoiceAgentsAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "voice-agents";
  readonly store: AgentStore;
  readonly #sessionDriver: VoiceSessionDriver | undefined;
  readonly #sessionRuntimeFetch: typeof globalThis.fetch | undefined;
  readonly #resolveTool:
    | ((name: QualifiedToolName) => ToolDefinition | undefined)
    | undefined;
  readonly #executeProviderTool: VoiceProviderToolExecutor | undefined;
  readonly #voiceSessionGrantIssuer: VoiceSessionGrantIssuer | undefined;
  readonly #remoteObservationLifecycle:
    | VoiceSessionObservationLifecycle
    | undefined;
  #webSessionSequence = 0;

  constructor(options: VoiceAgentsAdapterOptions = {}) {
    this.store = options.store ?? new InMemoryAgentStore();
    this.#sessionDriver = options.sessionDriver;
    this.#sessionRuntimeFetch = options.sessionRuntimeFetch;
    this.#resolveTool = options.resolveTool;
    this.#executeProviderTool = options.executeProviderTool;
    this.#voiceSessionGrantIssuer = options.voiceSessionGrantIssuer;
    this.#remoteObservationLifecycle = options.remoteObservationLifecycle;
  }

  private sessionRuntimeContext(context: AdapterContext): AdapterContext {
    return this.#sessionRuntimeFetch === undefined
      ? context
      : { ...context, fetchImpl: this.#sessionRuntimeFetch };
  }

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "voice-agents.create_voice_agent": {
        const agent = await this.store.createAgent(
          context.projectId,
          draftFromInput(context),
          context.clock.now().toISOString(),
        );
        return asJson({ agent });
      }
      case "voice-agents.get_voice_agent": {
        const agent = await this.store.getAgent(
          context.projectId,
          requiredInputString(context, "agentId"),
          optionalInteger(context.canonicalInput, "revision"),
        );
        return asJson({ agent });
      }
      case "voice-agents.list_voice_agents": {
        const transport = stringValue(context.canonicalInput, "transport");
        const summaries = (
          await this.store.listAgents(
            context.projectId,
            booleanValue(context.canonicalInput, "includeDeleted") ?? false,
          )
        ).filter(
          (summary) =>
            transport === undefined || summary.transport === transport,
        );
        const current = page(
          summaries,
          cursorOffset(context, stringValue(context.canonicalInput, "cursor")),
          optionalInteger(context.canonicalInput, "limit") ?? 20,
        );
        return asJson({
          agents: current.items,
          ...("nextCursor" in current
            ? { nextCursor: current.nextCursor }
            : {}),
        });
      }
      case "voice-agents.update_voice_agent": {
        const agent = await this.store.updateAgent(
          context.projectId,
          requiredInputString(context, "agentId"),
          requiredInteger(context, "expectedRevision"),
          draftFromInput(context),
          context.clock.now().toISOString(),
        );
        return asJson({ agent });
      }
      case "voice-agents.delete_voice_agent":
        return asJson(
          await this.store.deleteAgent(
            context.projectId,
            requiredInputString(context, "agentId"),
            requiredInteger(context, "expectedRevision"),
            context.clock.now().toISOString(),
          ),
        );
      case "voice-agents.start_agent_call":
        return this.startAgentCall(context);
      case "voice-agents.create_web_session":
        return this.createWebSession(context);
      case "voice-agents.buy_number":
        return this.buyNumber(context);
      case "voice-agents.list_numbers":
        return this.listNumbers(context);
      case "voice-agents.attach_agent_to_number": {
        const agent = await this.store.getRunnableAgent(
          context.projectId,
          requiredInputString(context, "agentId"),
          optionalInteger(context.canonicalInput, "revision"),
        );
        if (agent.transport !== "pstn:twilio") {
          throw new EyeballError({
            code: TOOL_ERROR_CODES.INVALID_INPUT,
            message: `${context.tool.name}: inbound number bindings require a pstn:twilio agent revision.`,
          });
        }
        const phoneNumber = requiredInputString(context, "phoneNumber");
        const transportConnectionId = requiredInputString(
          context,
          "transportConnectionId",
        );
        if (this.#executeProviderTool !== undefined) {
          const inventory = await this.providerTool(
            context,
            "twilio.list_numbers",
            transportConnectionId,
            { phoneNumber },
          );
          if (records(inventory.numbers).length !== 1) {
            throw new EyeballError({
              code: TOOL_ERROR_CODES.NOT_FOUND,
              message: `${context.tool.name}: owned number ${phoneNumber} was not found on the selected Twilio connection.`,
            });
          }
        }
        const binding = await this.store.attachNumber(
          {
            projectId: context.projectId,
            userId: context.userId,
            agentId: agent.id,
            revision: agent.revision,
            phoneNumber,
            transportConnectionId,
          },
          context.clock.now().toISOString(),
        );
        return asJson({
          bindingId: binding.bindingId,
          agentId: binding.agentId,
          revision: binding.revision,
          phoneNumber: binding.phoneNumber,
        });
      }
      case "voice-agents.detach_number": {
        const phoneNumber = requiredInputString(context, "phoneNumber");
        const binding = await this.store.detachNumber(
          context.projectId,
          context.userId,
          phoneNumber,
        );
        return asJson({
          phoneNumber,
          bindingStatus: "unbound",
          ...(binding === undefined
            ? {}
            : { detachedBindingId: binding.bindingId }),
        });
      }
      case "voice-agents.release_number":
        return this.releaseNumber(context);
      case "voice-agents.get_agent_session":
        return this.getAgentSession(context);
      case "voice-agents.list_agent_sessions":
        return this.listAgentSessions(context);
      case "voice-agents.get_session_transcript":
        return this.getSessionTranscript(context);
      case "voice-agents.send_session_message":
        return this.sendSessionMessage(context);
      case "voice-agents.stop_agent_session":
        return this.stopAgentSession(context);
      default:
        return unsupportedTool(context);
    }
  }

  private async providerTool(
    context: AdapterContext,
    tool: QualifiedToolName,
    connectionId: string,
    input: Readonly<Record<string, JsonValue>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (this.#executeProviderTool === undefined) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.NOT_SUPPORTED,
        message: `${context.tool.name}: provider delegation is not configured.`,
      });
    }
    const output = await this.#executeProviderTool({
      projectId: context.projectId,
      userId: context.userId,
      tool,
      connectionId,
      input,
    });
    if (!isRecord(output)) {
      throw providerError(
        context,
        `${tool} returned a non-object provider result.`,
      );
    }
    return output;
  }

  private async numberWithBinding(
    context: AdapterContext,
    number: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const phoneNumber = requiredStringField(context, number, "phoneNumber");
    const binding = await this.store.getNumberBinding(
      context.projectId,
      phoneNumber,
    );
    return {
      ...copy(number),
      bindingStatus: binding === undefined ? "unbound" : "bound",
      ...(binding === undefined
        ? {}
        : {
            binding: {
              bindingId: binding.bindingId,
              agentId: binding.agentId,
              revision: binding.revision,
              transportConnectionId: binding.transportConnectionId,
            },
          }),
    };
  }

  private async buyNumber(context: AdapterContext): Promise<JsonValue> {
    const phoneNumber = requiredInputString(context, "phoneNumber");
    const connectionId = requiredInputString(context, "transportConnectionId");
    const friendlyName = stringValue(context.canonicalInput, "friendlyName");
    const output = await this.providerTool(
      context,
      "twilio.buy_number",
      connectionId,
      {
        phoneNumber,
        ...(friendlyName === undefined ? {} : { friendlyName }),
      },
    );
    if (!isRecord(output.number)) {
      throw providerError(context, "Twilio omitted the acquired number.");
    }
    return asJson({
      number: await this.numberWithBinding(context, output.number),
    });
  }

  private async listNumbers(context: AdapterContext): Promise<JsonValue> {
    const connectionId = requiredInputString(context, "transportConnectionId");
    const phoneNumber = stringValue(context.canonicalInput, "phoneNumber");
    const pageSize = optionalInteger(context.canonicalInput, "pageSize");
    const pageToken = stringValue(context.canonicalInput, "pageToken");
    const output = await this.providerTool(
      context,
      "twilio.list_numbers",
      connectionId,
      {
        ...(phoneNumber === undefined ? {} : { phoneNumber }),
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(pageToken === undefined ? {} : { pageToken }),
      },
    );
    return asJson({
      numbers: await Promise.all(
        records(output.numbers).map((number) =>
          this.numberWithBinding(context, number),
        ),
      ),
      ...(typeof output.nextPageToken === "string"
        ? { nextPageToken: output.nextPageToken }
        : {}),
    });
  }

  private async releaseNumber(context: AdapterContext): Promise<JsonValue> {
    const phoneNumber = requiredInputString(context, "phoneNumber");
    const binding = await this.store.getNumberBinding(
      context.projectId,
      phoneNumber,
    );
    if (binding !== undefined) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.INVALID_INPUT,
        message: `${context.tool.name}: number ${phoneNumber} is still bound; call detach_number before release_number.`,
      });
    }
    return asJson(
      await this.providerTool(
        context,
        "twilio.release_number",
        requiredInputString(context, "transportConnectionId"),
        { phoneNumber },
      ),
    );
  }

  private remoteStartRequest(
    context: AdapterContext,
    agent: VoiceAgentDefinition,
    sessionId: string,
    transport: VoiceWorkerStartSessionRequest["transport"],
    executorGrant?: VoiceWorkerStartSessionRequest["executorGrant"],
  ): VoiceWorkerStartSessionRequest {
    const allowedTools = agent.tools.map((name) => {
      const definition = this.#resolveTool?.(name);
      if (definition === undefined) {
        throw new EyeballError({
          code: TOOL_ERROR_CODES.PROVIDER_ERROR,
          message: `${context.tool.name}: the remote voice worker could not resolve canonical schema ${name}.`,
        });
      }
      return {
        name: definition.name,
        description: definition.description,
        inputSchema: copy(definition.inputSchema),
      };
    });
    return {
      contractVersion: VOICE_WORKER_CONTRACT_VERSION,
      sessionId,
      scope: {
        projectId: context.projectId,
        userId: context.userId,
      },
      agent: {
        id: agent.id,
        revision: agent.revision,
        systemPrompt: agent.systemPrompt,
        llm: {
          provider: "anthropic",
          ...copy(agent.llm),
        },
        voice: copy(agent.voice),
        allowedTools,
        guardrails: copy(agent.guardrails),
        webhooks: copy(agent.webhooks),
        recordingPolicy: copy(agent.recordingPolicy),
        bargeIn: copy(agent.voice.bargeIn ?? { enabled: true }),
      },
      transport,
      ...(executorGrant === undefined ? {} : { executorGrant }),
    };
  }

  private async startRemoteSession(
    context: AdapterContext,
    agent: VoiceAgentDefinition,
    transport: VoiceWorkerStartSessionRequest["transport"],
  ): Promise<{
    pointer: VoiceAgentSessionPointer;
    session: VoiceAgentSession;
  }> {
    if (this.#sessionDriver === undefined) {
      throw new Error("Remote voice-session driver is not configured.");
    }
    const sessionId = `session_${randomUUID().replaceAll("-", "")}`;
    const unsignedRequest = this.remoteStartRequest(
      context,
      agent,
      sessionId,
      transport,
    );
    const issued = await this.#voiceSessionGrantIssuer?.issue({
      projectId: context.projectId,
      userId: context.userId,
      sessionId,
      maxDurationSeconds: agent.guardrails.maxDurationSeconds,
      allowedTools: unsignedRequest.agent.allowedTools.map((tool) => tool.name),
    });
    const pointer: VoiceAgentSessionPointer = {
      sessionId,
      projectId: context.projectId,
      userId: context.userId,
      agentId: agent.id,
      agentRevision: agent.revision,
      callId: `call_${sessionId}`,
      createdAt: context.clock.now().toISOString(),
      ...(issued === undefined
        ? {}
        : { grantId: issued.grantId, grantExpiresAt: issued.expiresAt }),
    };
    await this.store.rememberSession(pointer);
    try {
      await this.#remoteObservationLifecycle?.prepare(pointer);
    } catch (error) {
      await this.store.revokeSessionGrant({
        projectId: context.projectId,
        userId: context.userId,
        sessionId,
        ...(issued === undefined ? {} : { grantId: issued.grantId }),
        revokedAt: context.clock.now().toISOString(),
      });
      throw error;
    }
    try {
      const session = await this.#sessionDriver.startSession({
        ...unsignedRequest,
        ...(issued === undefined
          ? {}
          : {
              executorGrant: {
                token: issued.token,
                expiresAt: issued.expiresAt,
              },
            }),
      });
      assertTrustedSession(context, session, pointer);
      const updated = {
        ...pointer,
        callId: `call_${session.id}`,
        createdAt: session.createdAt,
      };
      await this.store.rememberSession(updated);
      await this.#remoteObservationLifecycle?.activate(updated);
      return { pointer: updated, session };
    } catch (error) {
      if (this.#remoteObservationLifecycle !== undefined) {
        const reconciled =
          await this.#remoteObservationLifecycle.handleStartFailure({
            pointer,
            error,
          });
        if (reconciled !== undefined) {
          assertTrustedSession(context, reconciled, pointer);
          const updated = {
            ...pointer,
            callId: `call_${reconciled.id}`,
            createdAt: reconciled.createdAt,
          };
          await this.store.rememberSession(updated);
          await this.#remoteObservationLifecycle.activate(updated);
          return { pointer: updated, session: reconciled };
        }
        throw error;
      }
      await this.store.revokeSessionGrant({
        projectId: context.projectId,
        userId: context.userId,
        sessionId,
        ...(issued === undefined ? {} : { grantId: issued.grantId }),
        revokedAt: context.clock.now().toISOString(),
      });
      throw error;
    }
  }

  private async remoteEventPage(
    context: AdapterContext,
    sessionId: string,
    afterSequence: number,
    limit: number,
  ): Promise<{
    events: readonly VoiceAgentSessionEvent[];
    nextSequence: number;
    hasMore: boolean;
  }> {
    if (this.#sessionDriver === undefined) {
      return eventPage(
        this.sessionRuntimeContext(context),
        sessionId,
        afterSequence,
        limit,
      );
    }
    return this.#sessionDriver.getEvents(sessionId, { afterSequence, limit });
  }

  private async remoteAllEvents(
    context: AdapterContext,
    sessionId: string,
  ): Promise<readonly VoiceAgentSessionEvent[]> {
    if (this.#sessionDriver === undefined) {
      return allEvents(this.sessionRuntimeContext(context), sessionId);
    }
    const events: VoiceAgentSessionEvent[] = [];
    let cursor = 0;
    for (;;) {
      const current = await this.remoteEventPage(
        context,
        sessionId,
        cursor,
        200,
      );
      events.push(...current.events);
      if (!current.hasMore || current.nextSequence <= cursor) return events;
      cursor = current.nextSequence;
    }
  }

  private async createWebSession(context: AdapterContext): Promise<JsonValue> {
    const agent = await this.store.getRunnableAgent(
      context.projectId,
      requiredInputString(context, "agentId"),
      optionalInteger(context.canonicalInput, "revision"),
    );
    if (agent.transport !== "webrtc:livekit") {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.INVALID_INPUT,
        message: `${context.tool.name}: web sessions require a webrtc:livekit agent revision.`,
      });
    }
    const transportConnectionId = requiredInputString(
      context,
      "transportConnectionId",
    );
    const participantIdentity = requiredInputString(
      context,
      "participantIdentity",
    );
    const participantName = stringValue(
      context.canonicalInput,
      "participantName",
    );
    const metadata = isRecord(context.canonicalInput.metadata)
      ? (copy(context.canonicalInput.metadata) as Readonly<
          Record<string, JsonValue>
        >)
      : undefined;
    this.#webSessionSequence += 1;
    const roomName =
      stringValue(context.canonicalInput, "roomName") ??
      `voice-${agent.id}-${String(this.#webSessionSequence).padStart(6, "0")}`;
    const providerMetadata =
      metadata === undefined ? "" : JSON.stringify(metadata);

    const created = await this.providerTool(
      context,
      "livekit.create_room",
      transportConnectionId,
      {
        roomName,
        maxParticipants: 2,
        metadata: providerMetadata,
      },
    );
    if (requiredStringField(context, created, "roomName") !== roomName) {
      throw providerError(
        context,
        "LiveKit returned a room outside the requested immutable session snapshot.",
      );
    }
    const joined = await this.providerTool(
      context,
      "livekit.join_room",
      transportConnectionId,
      {
        roomName,
        participantIdentity,
        ...(participantName === undefined ? {} : { participantName }),
        metadata: providerMetadata,
        tokenTtlSeconds: 3_600,
      },
    );

    let session: VoiceAgentSession;
    if (this.#sessionDriver !== undefined) {
      ({ session } = await this.startRemoteSession(context, agent, {
        kind: "livekit",
        roomName,
        transportConnectionId,
        participantIdentity: `agent-${agent.id}-${agent.revision}`,
        ...(metadata === undefined ? {} : { metadata }),
      }));
    } else {
      const body = await pipecatObject(
        this.sessionRuntimeContext(context),
        "sessions",
        jsonRequest({
          agentConfig: {
            ...(copy(agent) as unknown as Readonly<Record<string, JsonValue>>),
            projectId: context.projectId,
            userId: context.userId,
            agentId: agent.id,
            agentRevision: agent.revision,
            transport: agent.transport,
            roomName,
            transportConnectionId,
            participantIdentity: `agent-${agent.id}-${agent.revision}`,
            ...(metadata === undefined ? {} : { metadata }),
          },
          ...(Array.isArray(context.canonicalInput.script)
            ? { script: context.canonicalInput.script }
            : {}),
        }),
      );
      session = sessionFromProvider(context, body);
      const pointer: VoiceAgentSessionPointer = {
        sessionId: session.id,
        projectId: context.projectId,
        userId: context.userId,
        agentId: agent.id,
        agentRevision: agent.revision,
        callId: `call_${session.id}`,
        createdAt: session.createdAt,
      };
      assertTrustedSession(context, session, pointer);
      await this.store.rememberSession(pointer);
    }

    return asJson({
      session,
      joinGrant: {
        roomUrl: requiredStringField(context, joined, "serverUrl"),
        participantToken: requiredStringField(context, joined, "token"),
        expiresAt: requiredStringField(context, joined, "expiresAt"),
      },
      transcriptArtifactId: `transcript_${session.id}`,
    });
  }

  private async startAgentCall(context: AdapterContext): Promise<JsonValue> {
    const agent = await this.store.getRunnableAgent(
      context.projectId,
      requiredInputString(context, "agentId"),
      optionalInteger(context.canonicalInput, "revision"),
    );
    if (agent.transport !== "pstn:twilio") {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.INVALID_INPUT,
        message: `${context.tool.name}: outbound calls require a pstn:twilio agent revision.`,
      });
    }
    const requestedFrom = stringValue(context.canonicalInput, "from");
    const requestedConnectionId = stringValue(
      context.canonicalInput,
      "transportConnectionId",
    );
    const transport = resolveOutboundTransport({
      mode: this.#sessionDriver === undefined ? "development" : "remote-worker",
      bindings: (await this.store.listNumberBindings(context.projectId)).filter(
        (binding) =>
          binding.userId === context.userId &&
          binding.agentId === agent.id &&
          binding.revision === agent.revision,
      ),
      ...(requestedFrom === undefined ? {} : { from: requestedFrom }),
      ...(requestedConnectionId === undefined
        ? {}
        : { transportConnectionId: requestedConnectionId }),
    });
    if (this.#sessionDriver !== undefined) {
      const metadata = isRecord(context.canonicalInput.metadata)
        ? (copy(context.canonicalInput.metadata) as Readonly<
            Record<string, JsonValue>
          >)
        : undefined;
      if (transport.kind !== "telephony") {
        throw new Error(
          "Remote outbound transport resolver invariant violated.",
        );
      }
      const { session, pointer } = await this.startRemoteSession(
        context,
        agent,
        {
          kind: "twilio",
          to: requiredInputString(context, "to"),
          from: transport.from,
          transportConnectionId: transport.transportConnectionId,
          ...(metadata === undefined ? {} : { metadata }),
        },
      );
      return asJson({
        session,
        callId: pointer.callId,
        transcriptArtifactId: `transcript_${session.id}`,
      });
    }
    const body = await pipecatObject(
      this.sessionRuntimeContext(context),
      "sessions",
      jsonRequest({
        agentConfig: {
          ...(copy(agent) as unknown as Readonly<Record<string, JsonValue>>),
          projectId: context.projectId,
          userId: context.userId,
          agentId: agent.id,
          agentRevision: agent.revision,
          transport: agent.transport,
          to: requiredInputString(context, "to"),
          ...(transport.kind === "telephony"
            ? {
                from: transport.from,
                transportConnectionId: transport.transportConnectionId,
              }
            : { transportDefault: "development-fake" }),
          ...(isRecord(context.canonicalInput.metadata)
            ? { metadata: context.canonicalInput.metadata }
            : {}),
        },
        ...(Array.isArray(context.canonicalInput.script)
          ? { script: context.canonicalInput.script }
          : {}),
      }),
    );
    const session = sessionFromProvider(context, body);
    const pointer: VoiceAgentSessionPointer = {
      sessionId: session.id,
      projectId: context.projectId,
      userId: context.userId,
      agentId: agent.id,
      agentRevision: agent.revision,
      callId: `call_${session.id}`,
      createdAt: session.createdAt,
    };
    assertTrustedSession(context, session, pointer);
    await this.store.rememberSession(pointer);
    return asJson({
      session,
      callId: pointer.callId,
      transcriptArtifactId: `transcript_${session.id}`,
    });
  }

  private async readSession(
    context: AdapterContext,
    sessionId: string,
    knownPointer?: VoiceAgentSessionPointer,
  ): Promise<{
    session: VoiceAgentSession;
    pointer: VoiceAgentSessionPointer;
  }> {
    const pointer =
      knownPointer ??
      (await this.store.getSession(
        context.projectId,
        context.userId,
        sessionId,
      ));
    const session =
      this.#sessionDriver === undefined
        ? sessionFromProvider(
            context,
            await pipecatObject(
              this.sessionRuntimeContext(context),
              `sessions/${encodeURIComponent(sessionId)}`,
            ),
          )
        : await this.#sessionDriver.getSession(sessionId);
    assertTrustedSession(context, session, pointer);
    return { session, pointer };
  }

  private async getAgentSession(context: AdapterContext): Promise<JsonValue> {
    const sessionId = requiredInputString(context, "sessionId");
    const { session } = await this.readSession(context, sessionId);
    const events = await this.remoteEventPage(
      context,
      sessionId,
      optionalInteger(context.canonicalInput, "afterSequence") ?? 0,
      optionalInteger(context.canonicalInput, "eventLimit") ?? 50,
    );
    return asJson({
      session,
      events: events.events,
      nextSequence: events.nextSequence,
    });
  }

  private async stopAgentSession(context: AdapterContext): Promise<JsonValue> {
    const sessionId = requiredInputString(context, "sessionId");
    const pointer = await this.store.getSession(
      context.projectId,
      context.userId,
      sessionId,
    );
    await this.store.revokeSessionGrant({
      projectId: context.projectId,
      userId: context.userId,
      sessionId,
      ...(pointer.grantId === undefined ? {} : { grantId: pointer.grantId }),
      revokedAt: context.clock.now().toISOString(),
    });
    const { session: current } = await this.readSession(
      context,
      sessionId,
      pointer,
    );
    if (
      current.state === "completed" ||
      current.state === "failed" ||
      current.state === "abandoned"
    ) {
      return asJson({ session: current });
    }
    const reason = stringValue(context.canonicalInput, "reason");
    const session =
      this.#sessionDriver === undefined
        ? sessionFromProvider(
            context,
            await pipecatObject(
              this.sessionRuntimeContext(context),
              `sessions/${encodeURIComponent(sessionId)}/end`,
              jsonRequest(reason === undefined ? {} : { reason }),
            ),
          )
        : await this.#sessionDriver.stopSession(sessionId, {
            contractVersion: VOICE_WORKER_CONTRACT_VERSION,
            ...(reason === undefined ? {} : { reason }),
          });
    assertTrustedSession(context, session, pointer);
    return asJson({ session });
  }

  private async listAgentSessions(context: AdapterContext): Promise<JsonValue> {
    const requestedAgentId = stringValue(context.canonicalInput, "agentId");
    const requestedState = stringValue(context.canonicalInput, "state");
    const pointers = await this.store.listSessions(
      context.projectId,
      context.userId,
    );
    const sessions = (
      await Promise.all(
        pointers
          .filter(
            (pointer) =>
              requestedAgentId === undefined ||
              pointer.agentId === requestedAgentId,
          )
          .map(
            async (pointer) =>
              (
                await this.readSession(context, pointer.sessionId)
              ).session,
          ),
      )
    ).filter(
      (session) =>
        requestedState === undefined || session.state === requestedState,
    );
    const current = page(
      sessions,
      cursorOffset(context, stringValue(context.canonicalInput, "cursor")),
      optionalInteger(context.canonicalInput, "limit") ?? 20,
    );
    return asJson({
      sessions: current.items,
      ...("nextCursor" in current ? { nextCursor: current.nextCursor } : {}),
    });
  }

  private async getSessionTranscript(
    context: AdapterContext,
  ): Promise<JsonValue> {
    const sessionId = requiredInputString(context, "sessionId");
    const { session } = await this.readSession(context, sessionId);
    const agent = await this.store.getAgent(
      context.projectId,
      session.agentId,
      session.agentRevision,
    );
    const events = await this.remoteAllEvents(context, sessionId);
    const artifact = voiceTranscriptFromEvents(agent, session, events);
    return asJson({ artifact });
  }

  private async sendSessionMessage(
    context: AdapterContext,
  ): Promise<JsonValue> {
    const agentId = requiredInputString(context, "agentId");
    const revision = optionalInteger(context.canonicalInput, "revision");
    const message = requiredInputString(context, "message");
    const clientMessageId = requiredInputString(context, "clientMessageId");
    const suppliedSessionId = stringValue(context.canonicalInput, "sessionId");

    if (suppliedSessionId === undefined) {
      const agent = await this.store.getRunnableAgent(
        context.projectId,
        agentId,
        revision,
      );
      if (agent.transport !== "chat") {
        throw new EyeballError({
          code: TOOL_ERROR_CODES.INVALID_INPUT,
          message: `${context.tool.name}: creating a chat session requires a chat agent revision.`,
        });
      }
      if (this.#sessionDriver !== undefined) {
        if (this.#sessionDriver.sendTurn === undefined) {
          throw new EyeballError({
            code: TOOL_ERROR_CODES.NOT_SUPPORTED,
            message: `${context.tool.name}: the configured voice worker does not support chat turns.`,
          });
        }
        const { session, pointer } = await this.startRemoteSession(
          context,
          agent,
          { kind: "chat" },
        );
        let turn: Omit<VoiceWorkerChatTurnResponse, "contractVersion">;
        try {
          turn = await this.#sessionDriver.sendTurn(session.id, {
            contractVersion: VOICE_WORKER_CONTRACT_VERSION,
            text: message,
            idempotencyKey: clientMessageId,
          });
        } catch (error) {
          await this.store.revokeSessionGrant({
            projectId: context.projectId,
            userId: context.userId,
            sessionId: session.id,
            ...(pointer.grantId === undefined
              ? {}
              : { grantId: pointer.grantId }),
            revokedAt: context.clock.now().toISOString(),
          });
          await this.#sessionDriver
            .stopSession(session.id, {
              contractVersion: VOICE_WORKER_CONTRACT_VERSION,
              reason: "The initial chat turn failed.",
            })
            .catch(() => undefined);
          throw error;
        }
        assertTrustedSession(context, turn.session, pointer);
        const receipt: VoiceAgentMessageReceipt = {
          sessionId: session.id,
          clientMessageId,
          message,
          userMessageId: turn.turnId,
          assistantMessage: turn.assistantMessage,
        };
        await this.store.rememberMessage(
          context.projectId,
          context.userId,
          receipt,
        );
        return asJson({
          session: turn.session,
          userMessageId: turn.turnId,
          assistantMessage: turn.assistantMessage,
        });
      }
      const body = await pipecatObject(
        this.sessionRuntimeContext(context),
        "sessions",
        jsonRequest({
          agentConfig: {
            ...(copy(agent) as unknown as Readonly<Record<string, JsonValue>>),
            projectId: context.projectId,
            userId: context.userId,
            agentId: agent.id,
            agentRevision: agent.revision,
            transport: "chat",
          },
          script: [{ caller: message }],
        }),
      );
      const session = sessionFromProvider(context, body);
      const pointer: VoiceAgentSessionPointer = {
        sessionId: session.id,
        projectId: context.projectId,
        userId: context.userId,
        agentId: agent.id,
        agentRevision: agent.revision,
        callId: `call_${session.id}`,
        createdAt: session.createdAt,
      };
      assertTrustedSession(context, session, pointer);
      await this.store.rememberSession(pointer);
      const receipt: VoiceAgentMessageReceipt = {
        sessionId: session.id,
        clientMessageId,
        message,
        userMessageId: `message_${clientMessageId}`,
        assistantMessage: "",
      };
      await this.store.rememberMessage(
        context.projectId,
        context.userId,
        receipt,
      );
      return asJson({
        session,
        userMessageId: receipt.userMessageId,
        assistantMessage: receipt.assistantMessage,
      });
    }

    const { session: before, pointer } = await this.readSession(
      context,
      suppliedSessionId,
    );
    if (
      pointer.agentId !== agentId ||
      (revision !== undefined && pointer.agentRevision !== revision)
    ) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.INVALID_INPUT,
        message: `${context.tool.name}: sessionId is pinned to a different agent revision.`,
      });
    }
    await this.store.getAgent(
      context.projectId,
      agentId,
      pointer.agentRevision,
    );
    const existing = await this.store.getMessage(
      context.projectId,
      context.userId,
      suppliedSessionId,
      clientMessageId,
    );
    if (existing !== undefined) {
      if (existing.message !== message) {
        throw new EyeballError({
          code: TOOL_ERROR_CODES.INVALID_INPUT,
          message: `${context.tool.name}: clientMessageId was already used with different text.`,
        });
      }
      return asJson({
        session: before,
        userMessageId: existing.userMessageId,
        assistantMessage: existing.assistantMessage,
      });
    }

    const remoteTurn =
      this.#sessionDriver === undefined
        ? undefined
        : await this.#sessionDriver.sendTurn?.(suppliedSessionId, {
            contractVersion: VOICE_WORKER_CONTRACT_VERSION,
            text: message,
            idempotencyKey: clientMessageId,
          });
    if (this.#sessionDriver !== undefined && remoteTurn === undefined) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.NOT_SUPPORTED,
        message: `${context.tool.name}: the configured voice worker does not support chat turns.`,
      });
    }
    const turn =
      remoteTurn ??
      (await pipecatObject(
        this.sessionRuntimeContext(context),
        `sessions/${encodeURIComponent(suppliedSessionId)}/turns`,
        jsonRequest({ text: message }),
      ));
    const session =
      remoteTurn?.session ??
      (() => {
        const sessionValue = turn.session;
        if (!isRecord(sessionValue)) {
          throw providerError(
            context,
            "Pipecat omitted the session from the turn response.",
          );
        }
        return sessionFromProvider(context, sessionValue);
      })();
    assertTrustedSession(context, session, pointer);
    const userMessageId =
      remoteTurn?.turnId ?? requiredStringField(context, turn, "turnId");
    const receipt: VoiceAgentMessageReceipt = {
      sessionId: suppliedSessionId,
      clientMessageId,
      message,
      userMessageId,
      assistantMessage: remoteTurn?.assistantMessage ?? message,
    };
    await this.store.rememberMessage(
      context.projectId,
      context.userId,
      receipt,
    );
    return asJson({
      session,
      userMessageId,
      assistantMessage: receipt.assistantMessage,
    });
  }
}

export const voiceAgentsAdapter = new VoiceAgentsAdapter();
