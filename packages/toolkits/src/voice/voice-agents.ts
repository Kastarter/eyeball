import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  TOOL_ERROR_CODES,
  type ToolkitAdapter,
  type TranscriptArtifact,
  type TranscriptTurn,
  type VoiceAgentDefinition,
  type VoiceAgentDraft,
  type VoiceAgentSession,
  type VoiceAgentSessionEvent,
  type VoiceAgentSessionEventData,
  type VoiceAgentSessionState,
  type VoiceAgentSummary,
  type VoiceAgentTransport,
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
}

export interface VoiceAgentMessageReceipt {
  sessionId: string;
  clientMessageId: string;
  message: string;
  userMessageId: string;
  assistantMessage: string;
}

export interface AgentStore {
  createAgent(
    projectId: string,
    draft: VoiceAgentDraft,
    createdAt: string,
  ): VoiceAgentDefinition;
  getAgent(
    projectId: string,
    agentId: string,
    revision?: number,
  ): VoiceAgentDefinition;
  getRunnableAgent(
    projectId: string,
    agentId: string,
    revision?: number,
  ): VoiceAgentDefinition;
  listAgents(
    projectId: string,
    includeDeleted: boolean,
  ): readonly VoiceAgentSummary[];
  updateAgent(
    projectId: string,
    agentId: string,
    expectedRevision: number,
    draft: VoiceAgentDraft,
    createdAt: string,
  ): VoiceAgentDefinition;
  deleteAgent(
    projectId: string,
    agentId: string,
    expectedRevision: number,
    deletedAt: string,
  ): { agentId: string; deletedAt: string };
  attachNumber(
    input: Omit<VoiceAgentBinding, "bindingId" | "createdAt">,
    createdAt: string,
  ): VoiceAgentBinding;
  rememberSession(pointer: VoiceAgentSessionPointer): void;
  getSession(
    projectId: string,
    userId: string,
    sessionId: string,
  ): VoiceAgentSessionPointer;
  listSessions(
    projectId: string,
    userId: string,
  ): readonly VoiceAgentSessionPointer[];
  getMessage(
    projectId: string,
    userId: string,
    sessionId: string,
    clientMessageId: string,
  ): VoiceAgentMessageReceipt | undefined;
  rememberMessage(
    projectId: string,
    userId: string,
    receipt: VoiceAgentMessageReceipt,
  ): void;
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

  createAgent(
    projectId: string,
    draft: VoiceAgentDraft,
    createdAt: string,
  ): VoiceAgentDefinition {
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

  getAgent(
    projectId: string,
    agentId: string,
    revision?: number,
  ): VoiceAgentDefinition {
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

  getRunnableAgent(
    projectId: string,
    agentId: string,
    revision?: number,
  ): VoiceAgentDefinition {
    const resource = this.#resource(projectId, agentId);
    if (resource.deletedAt !== undefined) {
      return storeError(
        TOOL_ERROR_CODES.NOT_FOUND,
        `Voice agent ${agentId} is deleted and cannot start new sessions.`,
      );
    }
    return this.getAgent(projectId, agentId, revision);
  }

  listAgents(
    projectId: string,
    includeDeleted: boolean,
  ): readonly VoiceAgentSummary[] {
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

  updateAgent(
    projectId: string,
    agentId: string,
    expectedRevision: number,
    draft: VoiceAgentDraft,
    createdAt: string,
  ): VoiceAgentDefinition {
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

  deleteAgent(
    projectId: string,
    agentId: string,
    expectedRevision: number,
    deletedAt: string,
  ): { agentId: string; deletedAt: string } {
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

  attachNumber(
    input: Omit<VoiceAgentBinding, "bindingId" | "createdAt">,
    createdAt: string,
  ): VoiceAgentBinding {
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

  rememberSession(pointer: VoiceAgentSessionPointer): void {
    const existing = this.#sessions.get(pointer.sessionId);
    if (
      existing !== undefined &&
      (existing.projectId !== pointer.projectId ||
        existing.userId !== pointer.userId)
    ) {
      throw new Error("AgentStore invariant violated: session scope changed.");
    }
    this.#sessions.set(pointer.sessionId, copy(pointer));
  }

  getSession(
    projectId: string,
    userId: string,
    sessionId: string,
  ): VoiceAgentSessionPointer {
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

  listSessions(
    projectId: string,
    userId: string,
  ): readonly VoiceAgentSessionPointer[] {
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

  getMessage(
    projectId: string,
    userId: string,
    sessionId: string,
    clientMessageId: string,
  ): VoiceAgentMessageReceipt | undefined {
    const receipt = this.#messages.get(
      scopedKey(projectId, userId, sessionId, clientMessageId),
    );
    return receipt === undefined ? undefined : copy(receipt);
  }

  rememberMessage(
    projectId: string,
    userId: string,
    receipt: VoiceAgentMessageReceipt,
  ): void {
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
}

/** Native RFC 002 adapter backed by an injectable revision store and Pipecat. */
export class VoiceAgentsAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "voice-agents";
  readonly store: AgentStore;

  constructor(options: VoiceAgentsAdapterOptions = {}) {
    this.store = options.store ?? new InMemoryAgentStore();
  }

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "voice-agents.create_voice_agent": {
        const agent = this.store.createAgent(
          context.projectId,
          draftFromInput(context),
          context.clock.now().toISOString(),
        );
        return asJson({ agent });
      }
      case "voice-agents.get_voice_agent": {
        const agent = this.store.getAgent(
          context.projectId,
          requiredInputString(context, "agentId"),
          optionalInteger(context.canonicalInput, "revision"),
        );
        return asJson({ agent });
      }
      case "voice-agents.list_voice_agents": {
        const transport = stringValue(context.canonicalInput, "transport");
        const summaries = this.store
          .listAgents(
            context.projectId,
            booleanValue(context.canonicalInput, "includeDeleted") ?? false,
          )
          .filter(
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
        const agent = this.store.updateAgent(
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
          this.store.deleteAgent(
            context.projectId,
            requiredInputString(context, "agentId"),
            requiredInteger(context, "expectedRevision"),
            context.clock.now().toISOString(),
          ),
        );
      case "voice-agents.start_agent_call":
        return this.startAgentCall(context);
      case "voice-agents.attach_agent_to_number": {
        const agent = this.store.getRunnableAgent(
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
        const binding = this.store.attachNumber(
          {
            projectId: context.projectId,
            userId: context.userId,
            agentId: agent.id,
            revision: agent.revision,
            phoneNumber: requiredInputString(context, "phoneNumber"),
            transportConnectionId: requiredInputString(
              context,
              "transportConnectionId",
            ),
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
      case "voice-agents.get_agent_session":
        return this.getAgentSession(context);
      case "voice-agents.list_agent_sessions":
        return this.listAgentSessions(context);
      case "voice-agents.get_session_transcript":
        return this.getSessionTranscript(context);
      case "voice-agents.send_session_message":
        return this.sendSessionMessage(context);
      default:
        return unsupportedTool(context);
    }
  }

  private async startAgentCall(context: AdapterContext): Promise<JsonValue> {
    const agent = this.store.getRunnableAgent(
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
    const body = await pipecatObject(
      context,
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
          ...(stringValue(context.canonicalInput, "from") === undefined
            ? {}
            : { from: stringValue(context.canonicalInput, "from") }),
          ...(stringValue(context.canonicalInput, "transportConnectionId") ===
          undefined
            ? {}
            : {
                transportConnectionId: stringValue(
                  context.canonicalInput,
                  "transportConnectionId",
                ),
              }),
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
    this.store.rememberSession(pointer);
    return asJson({
      session,
      callId: pointer.callId,
      transcriptArtifactId: `transcript_${session.id}`,
    });
  }

  private async readSession(
    context: AdapterContext,
    sessionId: string,
  ): Promise<{
    session: VoiceAgentSession;
    pointer: VoiceAgentSessionPointer;
  }> {
    const pointer = this.store.getSession(
      context.projectId,
      context.userId,
      sessionId,
    );
    const body = await pipecatObject(
      context,
      `sessions/${encodeURIComponent(sessionId)}`,
    );
    const session = sessionFromProvider(context, body);
    assertTrustedSession(context, session, pointer);
    return { session, pointer };
  }

  private async getAgentSession(context: AdapterContext): Promise<JsonValue> {
    const sessionId = requiredInputString(context, "sessionId");
    const { session } = await this.readSession(context, sessionId);
    const events = await eventPage(
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

  private async listAgentSessions(context: AdapterContext): Promise<JsonValue> {
    const requestedAgentId = stringValue(context.canonicalInput, "agentId");
    const requestedState = stringValue(context.canonicalInput, "state");
    const sessions = (
      await Promise.all(
        this.store
          .listSessions(context.projectId, context.userId)
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
    const events = await allEvents(context, sessionId);
    const turns: TranscriptTurn[] = [];
    let previousEndMs = 0;
    for (const event of events) {
      const turn = transcriptTurn(event, previousEndMs);
      if (turn !== undefined) {
        turns.push(turn);
        previousEndMs = Math.max(previousEndMs, turn.endMs);
      }
    }
    const final =
      session.state === "completed" ||
      session.state === "failed" ||
      session.state === "abandoned";
    const artifact: TranscriptArtifact = {
      id: `transcript_${session.id}`,
      sessionId: session.id,
      agentId: session.agentId,
      agentRevision: session.agentRevision,
      transport: session.transport,
      final,
      startedAt: session.startedAt ?? session.createdAt,
      ...(session.completedAt === undefined
        ? {}
        : { endedAt: session.completedAt }),
      turns,
    };
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
      const agent = this.store.getRunnableAgent(
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
      const body = await pipecatObject(
        context,
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
      this.store.rememberSession(pointer);
      const receipt: VoiceAgentMessageReceipt = {
        sessionId: session.id,
        clientMessageId,
        message,
        userMessageId: `message_${clientMessageId}`,
        assistantMessage: "",
      };
      this.store.rememberMessage(context.projectId, context.userId, receipt);
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
    this.store.getAgent(context.projectId, agentId, pointer.agentRevision);
    const existing = this.store.getMessage(
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

    const turn = await pipecatObject(
      context,
      `sessions/${encodeURIComponent(suppliedSessionId)}/turns`,
      jsonRequest({ text: message }),
    );
    const sessionValue = turn.session;
    if (!isRecord(sessionValue)) {
      throw providerError(
        context,
        "Pipecat omitted the session from the turn response.",
      );
    }
    const session = sessionFromProvider(context, sessionValue);
    assertTrustedSession(context, session, pointer);
    const userMessageId = requiredStringField(context, turn, "turnId");
    const receipt: VoiceAgentMessageReceipt = {
      sessionId: suppliedSessionId,
      clientMessageId,
      message,
      userMessageId,
      assistantMessage: message,
    };
    this.store.rememberMessage(context.projectId, context.userId, receipt);
    return asJson({ session, userMessageId, assistantMessage: message });
  }
}

export const voiceAgentsAdapter = new VoiceAgentsAdapter();
