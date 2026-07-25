import { createHash, randomUUID } from "node:crypto";
import { defaultCatalog } from "@eyeball/catalog";
import {
  type ConnectionId,
  type ExecutionId,
  type ExecutionRecord,
  type ExecutionResult,
  type ExecutionStatus,
  EyeballError,
  isConnectionId,
  type JsonValue,
  type McpToolDescriptor,
  type NormalizedToolError,
  type QualifiedToolName,
  TOOL_ERROR_CODES,
  type ToolDefinition,
  toMcpTools,
} from "@eyeball/core";
import type {
  McpExecuteRequest,
  McpExecutor,
  TerminalExecution,
} from "./executor.js";
import {
  EXECUTE_TOOL_NAME,
  executeToolDescriptor,
  SEARCH_TOOL_NAME,
  SearchToolInputError,
  searchToolDescriptor,
  searchTools,
} from "./search-tool.js";
import {
  InMemorySessionStore,
  type McpProgressToken,
  type SessionStore,
  type StoredMcpSession,
  type StoredMcpTask,
} from "./session-store.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const MCP_SERVER_NAME = "eyeball-mcp-gateway" as const;
export const MCP_SERVER_VERSION = "0.1.0" as const;
export const MCP_TASKS_CAPABILITY = "tasks" as const;
/** @deprecated Use the top-level MCP_TASKS_CAPABILITY path. */
export const MCP_TASKS_EXPERIMENTAL_CAPABILITY = "tasks" as const;

const EXECUTION_META_KEY = "dev.eyeball/execution";
const TOOL_META_KEY = "dev.eyeball/tool";
const USER_ID_META_KEY = "dev.eyeball/userId";
const CONNECTION_ID_META_KEY = "dev.eyeball/connectionId";
const IDEMPOTENCY_KEY_META_KEY = "dev.eyeball/idempotencyKey";
const RELATED_TASK_META_KEY = "io.modelcontextprotocol/related-task";
const PROGRESS_TOKEN_META_KEY = "progressToken";
const DEFAULT_TASK_POLL_MS = 1_000;
const DEFAULT_TASK_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export interface GatewayCatalog {
  readonly catalogVersion?: string;
  listTools(): readonly ToolDefinition[];
  getTool(name: string): ToolDefinition | undefined;
}

export type ToolDiscoveryMode = "catalog" | "search";

export interface McpClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemMcpClock: McpClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface McpRequestContext {
  apiKey: string;
  /** One-way binding for the inbound credential and canonical authority scope. */
  authBinding?: string;
  /** Trusted server binding or transport-provided end-user identity. */
  userId?: string;
  /** Authenticated key claim; transport and tool metadata may not override it. */
  pinnedUserId?: string;
  sessionId?: string;
}

export interface McpProtocolOptions {
  executor: McpExecutor;
  catalog?: GatewayCatalog;
  discoveryMode?: ToolDiscoveryMode;
  serverVersion?: string;
  sessionIdFactory?: () => string;
  eventIdFactory?: () => string;
  sessionStore?: SessionStore;
  clock?: McpClock;
  taskPollMs?: number;
  taskTtlMs?: number;
  sessionTtlMs?: number;
}

export interface McpProtocolResult {
  response?: JsonRpcResponse;
  sessionId?: string;
}

export type McpSessionResolution =
  | { kind: "active"; session: StoredMcpSession }
  | { kind: "invalid" }
  | { kind: "unknown" };

interface TaskRequest {
  ttl?: number;
}

interface ToolCallParams {
  name: string;
  input: Readonly<Record<string, JsonValue>>;
  meta: Readonly<Record<string, unknown>>;
  task?: TaskRequest;
}

interface ToolResult {
  content: readonly [{ type: "text"; text: string }];
  structuredContent?: JsonValue;
  isError?: true;
  _meta?: Readonly<Record<string, unknown>>;
}

interface ResolvedProviderCall {
  params: ToolCallParams;
  tool: ToolDefinition;
}

type ProviderCallResolution =
  | { kind: "provider"; call: ResolvedProviderCall }
  | { kind: "search"; params: ToolCallParams }
  | { kind: "error"; result: ToolResult };

type SessionEventListener = (message: JsonRpcNotification | undefined) => void;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function serialized(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function unexpectedError(): NormalizedToolError {
  return {
    code: TOOL_ERROR_CODES.PROVIDER_ERROR,
    message: "Tool execution failed unexpectedly.",
    retryable: false,
  };
}

function normalizedError(error: unknown): NormalizedToolError {
  if (error instanceof EyeballError) {
    return error.toJSON();
  }
  if (error instanceof SearchToolInputError) {
    return {
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: error.message,
      retryable: false,
    };
  }
  return unexpectedError();
}

function failedToolResult(
  error: NormalizedToolError,
  execution?: TerminalExecution,
): ToolResult {
  return {
    content: [{ type: "text", text: serialized({ error }) }],
    isError: true,
    ...(execution === undefined
      ? {}
      : {
          _meta: {
            [EXECUTION_META_KEY]: executionMeta(execution),
          },
        }),
  };
}

function successfulToolResult(
  output: JsonValue,
  execution?: TerminalExecution,
): ToolResult {
  return {
    content: [{ type: "text", text: serialized(output) }],
    structuredContent: output,
    ...(execution === undefined
      ? {}
      : {
          _meta: {
            [EXECUTION_META_KEY]: executionMeta(execution),
          },
        }),
  };
}

function executionMeta(
  execution: TerminalExecution,
): Readonly<Record<string, unknown>> {
  return {
    executionId: execution.executionId,
    tool: execution.tool,
    toolVersion: execution.toolVersion,
    catalogVersion: execution.catalogVersion,
    status: execution.status,
    latencyMs: execution.latencyMs,
  };
}

function withRelatedTask(result: ToolResult, taskId: ExecutionId): ToolResult {
  return {
    ...result,
    _meta: {
      ...result._meta,
      [RELATED_TASK_META_KEY]: { taskId },
    },
  };
}

function requestMessage(
  value: unknown,
): JsonRpcRequest | JsonRpcNotification | undefined {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string"
  ) {
    return undefined;
  }
  if (!("id" in value)) {
    return {
      jsonrpc: "2.0",
      method: value.method,
      ...(value.params === undefined ? {} : { params: value.params }),
    };
  }
  if (
    value.id !== null &&
    typeof value.id !== "string" &&
    typeof value.id !== "number"
  ) {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    id: value.id,
    method: value.method,
    ...(value.params === undefined ? {} : { params: value.params }),
  };
}

function parseTaskRequest(value: unknown): TaskRequest {
  if (!isRecord(value)) {
    throw new SearchToolInputError("tools/call task must be a JSON object.");
  }
  const unknownKey = Object.keys(value).find((key) => key !== "ttl");
  if (unknownKey !== undefined) {
    throw new SearchToolInputError(
      `Unknown tools/call task field: ${unknownKey}.`,
    );
  }
  if (
    value.ttl !== undefined &&
    (typeof value.ttl !== "number" ||
      !Number.isSafeInteger(value.ttl) ||
      value.ttl <= 0)
  ) {
    throw new SearchToolInputError(
      "tools/call task ttl must be a positive integer number of milliseconds.",
    );
  }
  return value.ttl === undefined ? {} : { ttl: value.ttl };
}

function parseToolCallParams(value: unknown): ToolCallParams {
  if (!isRecord(value)) {
    throw new SearchToolInputError("tools/call params must be a JSON object.");
  }
  const unknownKey = Object.keys(value).find(
    (key) =>
      key !== "name" &&
      key !== "arguments" &&
      key !== "_meta" &&
      key !== "task",
  );
  if (unknownKey !== undefined) {
    throw new SearchToolInputError(`Unknown tools/call field: ${unknownKey}.`);
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new SearchToolInputError(
      "tools/call name must be a non-empty string.",
    );
  }
  const input = value.arguments ?? {};
  if (!isRecord(input)) {
    throw new SearchToolInputError(
      "tools/call arguments must be a JSON object.",
    );
  }
  const meta = value._meta ?? {};
  if (!isRecord(meta)) {
    throw new SearchToolInputError("tools/call _meta must be a JSON object.");
  }
  return {
    name: value.name,
    input: input as Readonly<Record<string, JsonValue>>,
    meta,
    ...(value.task === undefined ? {} : { task: parseTaskRequest(value.task) }),
  };
}

function optionalString(
  meta: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = meta[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SearchToolInputError(`${key} must be a non-empty string.`);
  }
  return value;
}

function progressToken(
  meta: Readonly<Record<string, unknown>>,
): McpProgressToken | undefined {
  const value = meta[PROGRESS_TOKEN_META_KEY];
  if (value === undefined) return undefined;
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new SearchToolInputError(
      "progressToken must be a string or finite number.",
    );
  }
  return value;
}

function connectionId(
  meta: Readonly<Record<string, unknown>>,
): ConnectionId | undefined {
  const value = optionalString(meta, CONNECTION_ID_META_KEY);
  if (value === undefined) {
    return undefined;
  }
  if (!isConnectionId(value)) {
    throw new SearchToolInputError(
      `${CONNECTION_ID_META_KEY} must be a valid conn_* identifier.`,
    );
  }
  return value;
}

function idempotencyKey(
  meta: Readonly<Record<string, unknown>>,
  requestId: JsonRpcId,
  sessionId: string | undefined,
): string {
  const explicit = optionalString(meta, IDEMPOTENCY_KEY_META_KEY);
  if (explicit !== undefined) {
    return explicit;
  }
  return `mcp:${sessionId ?? "stateless"}:${String(requestId)}`;
}

function descriptorWithMeta(
  descriptor: McpToolDescriptor,
  tool: ToolDefinition,
): McpToolDescriptor & { _meta: Readonly<Record<string, unknown>> } {
  return {
    ...descriptor,
    _meta: {
      [TOOL_META_KEY]: {
        toolkit: tool.toolkit,
        capability: tool.capability,
        version: tool.version,
      },
    },
  };
}

function visibleTools(catalog: GatewayCatalog): readonly ToolDefinition[] {
  // Async-by-nature tools stay visible without MCP Tasks: plain calls bridge
  // through the executor's async mode and wait for the terminal record.
  return catalog.listTools();
}

function withoutExecutionMeta(
  descriptor: McpToolDescriptor,
): McpToolDescriptor {
  const { execution: _execution, ...rest } = descriptor;
  return rest;
}

function listedTools(
  catalog: GatewayCatalog,
  discoveryMode: ToolDiscoveryMode,
  tasksEnabled: boolean,
): readonly (McpToolDescriptor | (McpToolDescriptor & { _meta: unknown }))[] {
  if (discoveryMode === "search") {
    return [
      searchToolDescriptor,
      tasksEnabled
        ? {
            ...executeToolDescriptor,
            execution: { taskSupport: "optional" },
          }
        : executeToolDescriptor,
    ];
  }
  const raw = visibleTools(catalog);
  const converted = toMcpTools(raw, { includeAsync: true }).tools;
  return [
    searchToolDescriptor,
    ...converted.map((descriptor, index) => {
      const tool = raw[index];
      if (tool === undefined || tool.name !== descriptor.name) {
        throw new Error("MCP conversion changed canonical catalog ordering.");
      }
      // `execution.taskSupport` is Tasks metadata; only negotiated sessions see it.
      return descriptorWithMeta(
        tasksEnabled ? descriptor : withoutExecutionMeta(descriptor),
        tool,
      );
    }),
  ];
}

function initializeParams(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    isRecord(value) &&
    typeof value.protocolVersion === "string" &&
    isRecord(value.capabilities) &&
    isRecord(value.clientInfo)
  );
}

function tasksRequested(
  capabilities: Readonly<Record<string, unknown>>,
): boolean {
  const tasks = capabilities[MCP_TASKS_CAPABILITY];
  if (tasks === true || isRecord(tasks)) return true;
  if (!isRecord(capabilities.experimental)) return false;
  const legacyTasks =
    capabilities.experimental[MCP_TASKS_EXPERIMENTAL_CAPABILITY];
  return legacyTasks === true || isRecord(legacyTasks);
}

function listParamsValid(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return (
    isRecord(value) &&
    (value.cursor === undefined || typeof value.cursor === "string")
  );
}

function taskIdParams(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const unknownKey = Object.keys(value).find(
    (key) => key !== "taskId" && key !== "_meta",
  );
  if (
    unknownKey !== undefined ||
    typeof value.taskId !== "string" ||
    value.taskId.length === 0
  ) {
    return undefined;
  }
  return value.taskId;
}

function taskView(task: StoredMcpTask): Readonly<Record<string, unknown>> {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage === undefined
      ? {}
      : { statusMessage: task.statusMessage }),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttl: task.ttl,
    pollInterval: task.pollInterval,
  };
}

function taskStatus(
  execution: ExecutionResult | ExecutionRecord,
): StoredMcpTask["status"] {
  switch (execution.status) {
    case "pending":
    case "running":
      return "working";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function taskStatusMessage(
  execution: ExecutionResult | ExecutionRecord,
): string {
  switch (execution.status) {
    case "pending":
      return "Execution queued.";
    case "running":
      return "Execution running.";
    case "succeeded":
      return "Execution completed.";
    case "failed":
      return execution.error.message;
    case "cancelled":
      return execution.cancellation.dispatchMayHaveBegun
        ? "Execution cancelled after provider dispatch may have begun; cancellation is best effort and upstream work may still complete."
        : "Execution cancelled before provider dispatch.";
  }
}

function terminalTask(task: StoredMcpTask): boolean {
  return (
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled"
  );
}

function executionProgress(status: ExecutionStatus): number {
  switch (status) {
    case "pending":
      return 0;
    case "running":
      return 1;
    case "succeeded":
    case "failed":
    case "cancelled":
      return 2;
  }
}

function preferredTask(
  current: StoredMcpTask | undefined,
  candidate: StoredMcpTask,
): StoredMcpTask {
  if (current === undefined) return candidate;
  if (terminalTask(current)) return current;
  if (terminalTask(candidate)) return candidate;
  return executionProgress(candidate.executionStatus) <=
    executionProgress(current.executionStatus)
    ? current
    : candidate;
}

function taskKey(sessionId: string, taskId: string): string {
  return `${sessionId}:${taskId}`;
}

function visibleAscii(value: string): boolean {
  return /^[\x21-\x7e]+$/u.test(value);
}

/** Implements MCP Streamable HTTP request semantics plus negotiated Tasks state. */
export class McpProtocol {
  readonly #executor: McpExecutor;
  readonly #catalog: GatewayCatalog;
  readonly #discoveryMode: ToolDiscoveryMode;
  readonly #serverVersion: string;
  readonly #sessionIdFactory: () => string;
  readonly #eventIdFactory: () => string;
  readonly #sessionStore: SessionStore;
  readonly #clock: McpClock;
  readonly #taskPollMs: number;
  readonly #taskTtlMs: number;
  readonly #sessionTtlMs: number;
  readonly #listeners = new Map<string, Set<SessionEventListener>>();
  readonly #pollHandles = new Map<string, unknown>();
  readonly #sessionExpiryHandles = new Map<string, unknown>();
  readonly #terminalWaiters = new Map<string, Set<() => void>>();
  #disposed = false;

  constructor(options: McpProtocolOptions) {
    this.#executor = options.executor;
    this.#catalog = options.catalog ?? defaultCatalog;
    this.#discoveryMode = options.discoveryMode ?? "catalog";
    this.#serverVersion = options.serverVersion ?? MCP_SERVER_VERSION;
    this.#sessionIdFactory =
      options.sessionIdFactory ??
      (() => `mcp_${randomUUID().replaceAll("-", "")}`);
    this.#eventIdFactory =
      options.eventIdFactory ?? (() => randomUUID().replaceAll("-", ""));
    this.#sessionStore = options.sessionStore ?? new InMemorySessionStore();
    this.#clock = options.clock ?? systemMcpClock;
    this.#taskPollMs = options.taskPollMs ?? DEFAULT_TASK_POLL_MS;
    this.#taskTtlMs = options.taskTtlMs ?? DEFAULT_TASK_TTL_MS;
    this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isSafeInteger(this.#taskPollMs) || this.#taskPollMs <= 0) {
      throw new Error("taskPollMs must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#taskTtlMs) || this.#taskTtlMs <= 0) {
      throw new Error("taskTtlMs must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#sessionTtlMs) || this.#sessionTtlMs <= 0) {
      throw new Error("sessionTtlMs must be a positive integer.");
    }
  }

  /** Stops process-local work without deleting restart-durable session records. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const handle of this.#pollHandles.values()) {
      this.#clock.clearTimeout(handle);
    }
    this.#pollHandles.clear();
    for (const handle of this.#sessionExpiryHandles.values()) {
      this.#clock.clearTimeout(handle);
    }
    this.#sessionExpiryHandles.clear();
    for (const waiters of this.#terminalWaiters.values()) {
      for (const resolve of waiters) resolve();
    }
    this.#terminalWaiters.clear();
    for (const sessionId of [...this.#listeners.keys()]) {
      this.#closeSessionListeners(sessionId);
    }
  }

  nextEventId(sessionId?: string): string {
    const suffix = this.#eventIdFactory();
    if (!visibleAscii(suffix)) {
      throw new Error(
        "MCP event IDs must contain visible ASCII characters only.",
      );
    }
    return `${sessionId ?? "stateless"}:${suffix}`;
  }

  subscribe(sessionId: string, listener: SessionEventListener): () => void {
    if (this.#disposed) {
      listener(undefined);
      return () => undefined;
    }
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(sessionId);
    };
  }

  async getSession(
    sessionId: string,
    authBinding: string,
  ): Promise<StoredMcpSession | undefined> {
    const resolved = await this.resolveSession(sessionId, authBinding);
    return resolved.kind === "active" ? resolved.session : undefined;
  }

  async resolveSession(
    sessionId: string,
    authBinding: string,
  ): Promise<McpSessionResolution> {
    const session = await this.#sessionStore.get(sessionId);
    if (session === undefined) {
      return { kind: "unknown" };
    }
    if (session.authBinding !== authBinding) {
      return { kind: "invalid" };
    }
    if (this.#clock.now() >= Date.parse(session.expiresAt)) {
      await this.#sessionStore.delete(sessionId);
      this.#cleanUpSession(session);
      return { kind: "invalid" };
    }
    this.#scheduleSessionExpiry(session);
    return { kind: "active", session };
  }

  async deleteSession(
    sessionId: string,
    authBinding: string,
  ): Promise<boolean> {
    const session = await this.getSession(sessionId, authBinding);
    if (session === undefined) return false;
    const deleted = await this.#sessionStore.delete(sessionId);
    this.#cleanUpSession(session);
    return deleted;
  }

  async checkCatalogVersion(
    sessionId: string,
    authBinding: string,
  ): Promise<boolean> {
    const currentVersion = this.#catalog.catalogVersion;
    if (currentVersion === undefined) return false;
    const session = await this.getSession(sessionId, authBinding);
    if (
      session === undefined ||
      session.catalogVersion === undefined ||
      session.catalogVersion === currentVersion
    ) {
      return false;
    }
    await this.#sessionStore.update(sessionId, (stored) =>
      stored.authBinding === authBinding
        ? { ...stored, catalogVersion: currentVersion }
        : stored,
    );
    this.#publish(sessionId, {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
    return true;
  }

  async resumeTasks(context: McpRequestContext): Promise<void> {
    const session = await this.#sessionFor(context);
    if (session === undefined) return;
    for (const task of Object.values(session.tasks)) {
      if (task.status === "working" || task.status === "input_required") {
        this.#scheduleTaskPoll(
          session.sessionId,
          task.taskId,
          session.authBinding,
          context.apiKey,
          task.pollInterval,
        );
      }
    }
  }

  async handle(
    value: unknown,
    context: McpRequestContext,
  ): Promise<McpProtocolResult> {
    const message = requestMessage(value);
    if (message === undefined) {
      return { response: rpcError(null, -32600, "Invalid Request") };
    }
    if (!("id" in message)) {
      // Notifications never dispatch tools: doing so would lose both a stable call ID and
      // a result channel for mutation failures.
      return {};
    }

    switch (message.method) {
      case "initialize":
        return this.#initialize(message, context);
      case "ping":
        return { response: rpcResult(message.id, {}) };
      case "tools/list":
        return this.#listTools(message, context);
      case "tools/call":
        return this.#call(message, context);
      case "tasks/get":
        return this.#getTask(message, context);
      case "tasks/result":
        return this.#getTaskResult(message, context);
      case "tasks/cancel":
        return this.#cancelTask(message, context);
      default:
        return {
          response: rpcError(message.id, -32601, "Method not found"),
        };
    }
  }

  async #initialize(
    message: JsonRpcRequest,
    context: McpRequestContext,
  ): Promise<McpProtocolResult> {
    if (!initializeParams(message.params)) {
      return {
        response: rpcError(message.id, -32602, "Invalid initialize params"),
      };
    }
    const tasksEnabled =
      tasksRequested(
        message.params.capabilities as Readonly<Record<string, unknown>>,
      ) &&
      this.#executor.start !== undefined &&
      this.#executor.get !== undefined;
    const sessionId = this.#sessionIdFactory();
    if (!visibleAscii(sessionId)) {
      throw new Error(
        "MCP session IDs must contain visible ASCII characters only.",
      );
    }
    const createdAt = new Date(this.#clock.now()).toISOString();
    const session: StoredMcpSession = {
      sessionId,
      protocolVersion: MCP_PROTOCOL_VERSION,
      authBinding: this.#authBinding(context),
      tasksEnabled,
      createdAt,
      expiresAt: new Date(this.#clock.now() + this.#sessionTtlMs).toISOString(),
      ...(this.#catalog.catalogVersion === undefined
        ? {}
        : { catalogVersion: this.#catalog.catalogVersion }),
      tasks: {},
    };
    await this.#sessionStore.set(session);
    this.#scheduleSessionExpiry(session);

    const capabilities = tasksEnabled
      ? {
          tools: { listChanged: true },
          tasks: {
            ...(this.#executor.cancel === undefined ? {} : { cancel: {} }),
            requests: { tools: { call: {} } },
          },
        }
      : { tools: { listChanged: true } };
    return {
      sessionId,
      response: rpcResult(message.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities,
        serverInfo: { name: MCP_SERVER_NAME, version: this.#serverVersion },
        instructions: `Use eyeball.search_tools to find canonical provider tools. In search discovery mode, invoke a returned tool through eyeball.execute_tool. Tool failures are returned as normalized MCP tool results.${tasksEnabled ? " Async-by-nature tools require task augmentation; poll tasks/get and retrieve tasks/result." : " Async-by-nature tools run to completion before the call returns."}`,
      }),
    };
  }

  async #listTools(
    message: JsonRpcRequest,
    context: McpRequestContext,
  ): Promise<McpProtocolResult> {
    if (!listParamsValid(message.params)) {
      return {
        response: rpcError(message.id, -32602, "Invalid tools/list params"),
      };
    }
    const cursor = isRecord(message.params) ? message.params.cursor : undefined;
    if (cursor !== undefined) {
      return {
        response: rpcError(
          message.id,
          -32602,
          "This gateway returns the complete tool list and does not accept cursors.",
        ),
      };
    }
    const session = await this.#sessionFor(context);
    return {
      response: rpcResult(message.id, {
        tools: listedTools(
          this.#catalog,
          this.#discoveryMode,
          session?.tasksEnabled ?? false,
        ),
      }),
    };
  }

  async #call(
    message: JsonRpcRequest,
    context: McpRequestContext,
  ): Promise<McpProtocolResult> {
    const session = await this.#sessionFor(context);
    const taskRequested = isRecord(message.params) && "task" in message.params;
    if (taskRequested && session?.tasksEnabled === true) {
      return {
        response: await this.#callToolAsTask(
          message.id,
          message.params,
          context,
          session,
        ),
      };
    }

    if (session?.tasksEnabled === true) {
      const resolution = this.#resolveProviderCall(message.params);
      if (
        resolution.kind === "provider" &&
        resolution.call.tool.annotations.async
      ) {
        return {
          response: rpcError(
            message.id,
            -32601,
            `Task augmentation is required for ${resolution.call.tool.name}.`,
          ),
        };
      }
    }

    return {
      response: rpcResult(
        message.id,
        await this.#callTool(message.id, message.params, context),
      ),
    };
  }

  async #callTool(
    requestId: JsonRpcId,
    value: unknown,
    context: McpRequestContext,
  ): Promise<ToolResult> {
    const resolution = this.#resolveProviderCall(value);
    if (resolution.kind === "error") return resolution.result;
    if (resolution.kind === "search") {
      try {
        return successfulToolResult(
          searchTools(
            visibleTools(this.#catalog),
            resolution.params.input,
          ) as unknown as JsonValue,
        );
      } catch (error) {
        return failedToolResult(normalizedError(error));
      }
    }
    const executionRequest = this.#executionRequest(
      resolution.call,
      requestId,
      context,
    );
    if (!executionRequest.ok) return executionRequest.result;
    try {
      const execution = await this.#executor.execute(executionRequest.request);
      return execution.status === "succeeded"
        ? successfulToolResult(execution.output, execution)
        : failedToolResult(execution.error, execution);
    } catch (error) {
      return failedToolResult(normalizedError(error));
    }
  }

  async #callToolAsTask(
    requestId: JsonRpcId,
    value: unknown,
    context: McpRequestContext,
    session: StoredMcpSession,
  ): Promise<JsonRpcResponse> {
    const resolution = this.#resolveProviderCall(value);
    if (resolution.kind === "error") {
      return rpcResult(requestId, resolution.result);
    }
    if (resolution.kind === "search") {
      return rpcError(
        requestId,
        -32601,
        `${SEARCH_TOOL_NAME} does not support task-augmented execution.`,
      );
    }
    if (
      resolution.call.params.task === undefined ||
      this.#executor.start === undefined ||
      this.#executor.get === undefined
    ) {
      return rpcError(requestId, -32601, "Task execution is not available.");
    }

    const executionRequest = this.#executionRequest(
      resolution.call,
      requestId,
      context,
    );
    if (!executionRequest.ok)
      return rpcResult(requestId, executionRequest.result);

    try {
      const token = progressToken(resolution.call.params.meta);
      const execution = await this.#executor.start(executionRequest.request);
      const now = new Date(this.#clock.now()).toISOString();
      const task: StoredMcpTask = {
        taskId: execution.executionId,
        tool: resolution.call.tool.name as QualifiedToolName,
        executionStatus: execution.status,
        status: taskStatus(execution),
        statusMessage: taskStatusMessage(execution),
        createdAt: now,
        lastUpdatedAt: now,
        ttl: resolution.call.params.task.ttl ?? this.#taskTtlMs,
        pollInterval: this.#taskPollMs,
        progress: executionProgress(execution.status),
        ...(token === undefined ? {} : { progressToken: token }),
      };
      const saved = await this.#saveTask(
        session.sessionId,
        session.authBinding,
        task,
      );

      if (saved.changed && saved.task.status === "working") {
        this.#publishProgress(
          session.sessionId,
          saved.task,
          0,
          "Execution queued.",
        );
        this.#scheduleTaskPoll(
          session.sessionId,
          saved.task.taskId,
          session.authBinding,
          context.apiKey,
          saved.task.pollInterval,
        );
      }
      return rpcResult(requestId, {
        task: taskView(saved.task),
        _meta: {
          [RELATED_TASK_META_KEY]: { taskId: saved.task.taskId },
          "io.modelcontextprotocol/model-immediate-response":
            "The Eyeball execution was accepted and is running as a task.",
        },
      });
    } catch (error) {
      return rpcResult(requestId, failedToolResult(normalizedError(error)));
    }
  }

  #resolveProviderCall(value: unknown): ProviderCallResolution {
    let params: ToolCallParams;
    try {
      params = parseToolCallParams(value);
    } catch (error) {
      return {
        kind: "error",
        result: failedToolResult(normalizedError(error)),
      };
    }

    if (params.name === SEARCH_TOOL_NAME) {
      return { kind: "search", params };
    }
    if (params.name === EXECUTE_TOOL_NAME) {
      const nestedName = params.input.name;
      const nestedInput = params.input.input;
      if (
        typeof nestedName !== "string" ||
        nestedName.length === 0 ||
        !isRecord(nestedInput)
      ) {
        return {
          kind: "error",
          result: failedToolResult({
            code: TOOL_ERROR_CODES.INVALID_INPUT,
            message:
              "eyeball.execute_tool requires a canonical tool name and an input object.",
            retryable: false,
          }),
        };
      }
      params = {
        name: nestedName,
        input: nestedInput as Readonly<Record<string, JsonValue>>,
        meta: params.meta,
        ...(params.task === undefined ? {} : { task: params.task }),
      };
    }

    const tool = this.#catalog.getTool(params.name);
    if (tool === undefined) {
      return {
        kind: "error",
        result: failedToolResult({
          code: TOOL_ERROR_CODES.NOT_SUPPORTED,
          message: `Tool ${params.name} is not supported.`,
          retryable: false,
        }),
      };
    }
    return { kind: "provider", call: { params, tool } };
  }

  #executionRequest(
    call: ResolvedProviderCall,
    requestId: JsonRpcId,
    context: McpRequestContext,
  ):
    | { ok: true; request: McpExecuteRequest }
    | { ok: false; result: ToolResult } {
    try {
      const metaUserId = optionalString(call.params.meta, USER_ID_META_KEY);
      if (
        context.pinnedUserId !== undefined &&
        ((context.userId !== undefined &&
          context.userId !== context.pinnedUserId) ||
          (metaUserId !== undefined && metaUserId !== context.pinnedUserId))
      ) {
        return {
          ok: false,
          result: failedToolResult({
            code: TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE,
            message: "This API key is pinned to a different end user.",
            retryable: false,
          }),
        };
      }
      const userId = context.pinnedUserId ?? context.userId ?? metaUserId;
      if (userId === undefined || userId.trim().length === 0) {
        return {
          ok: false,
          result: failedToolResult({
            code: TOOL_ERROR_CODES.INVALID_INPUT,
            message:
              "An end-user ID is required; configure EYEBALL_USER_ID, send X-Eyeball-User-Id, or pass dev.eyeball/userId in tools/call _meta.",
            retryable: false,
          }),
        };
      }
      const selectedConnectionId = connectionId(call.params.meta);
      return {
        ok: true,
        request: {
          apiKey: context.apiKey,
          userId,
          tool: call.tool.name as QualifiedToolName,
          input: call.params.input,
          idempotencyKey: idempotencyKey(
            call.params.meta,
            requestId,
            context.sessionId,
          ),
          ...(selectedConnectionId === undefined
            ? {}
            : { connectionId: selectedConnectionId }),
          // The executor refuses sync dispatch for async-by-nature tools; the
          // bridge waits on the pending execution to keep tools/call synchronous.
          ...(call.tool.annotations.async ? { mode: "async" as const } : {}),
        },
      };
    } catch (error) {
      return { ok: false, result: failedToolResult(normalizedError(error)) };
    }
  }

  async #getTask(
    message: JsonRpcRequest,
    context: McpRequestContext,
  ): Promise<McpProtocolResult> {
    const found = await this.#taskFor(message, context);
    if (!found.ok) return { response: found.response };
    try {
      const task = await this.#refreshTask(
        found.session,
        found.task,
        context.apiKey,
      );
      return { response: rpcResult(message.id, taskView(task)) };
    } catch {
      return {
        response: rpcError(
          message.id,
          -32603,
          "Failed to refresh task status.",
        ),
      };
    }
  }

  async #getTaskResult(
    message: JsonRpcRequest,
    context: McpRequestContext,
  ): Promise<McpProtocolResult> {
    const found = await this.#taskFor(message, context);
    if (!found.ok) return { response: found.response };
    let task: StoredMcpTask;
    try {
      task = await this.#refreshTask(found.session, found.task, context.apiKey);
    } catch {
      return {
        response: rpcError(
          message.id,
          -32603,
          "Failed to refresh task status.",
        ),
      };
    }
    if (task.status === "working" || task.status === "input_required") {
      await this.#waitForTerminal(found.session, task, context.apiKey);
      const refreshed = await this.#sessionStore.get(found.session.sessionId);
      const stored = refreshed?.tasks[task.taskId];
      if (stored === undefined) {
        return {
          response: rpcError(message.id, -32602, "Task not found."),
        };
      }
      task = stored;
    }
    if (this.#executor.get === undefined) {
      return {
        response: rpcError(
          message.id,
          -32603,
          "Task execution is unavailable.",
        ),
      };
    }
    try {
      const execution = await this.#executor.get({
        apiKey: context.apiKey,
        executionId: task.taskId,
      });
      if (
        execution.status !== "succeeded" &&
        execution.status !== "failed" &&
        execution.status !== "cancelled"
      ) {
        return {
          response: rpcError(
            message.id,
            -32603,
            "Task status became non-terminal while retrieving its result.",
          ),
        };
      }
      const result =
        execution.status === "succeeded"
          ? successfulToolResult(execution.output, execution)
          : failedToolResult(execution.error, execution);
      return {
        response: rpcResult(message.id, withRelatedTask(result, task.taskId)),
      };
    } catch {
      return {
        response: rpcError(
          message.id,
          -32603,
          "Failed to retrieve task result.",
        ),
      };
    }
  }

  async #cancelTask(
    message: JsonRpcRequest,
    context: McpRequestContext,
  ): Promise<McpProtocolResult> {
    const cancel = this.#executor.cancel;
    if (cancel === undefined) {
      return {
        response: rpcError(message.id, -32601, "Method not found"),
      };
    }
    const found = await this.#taskFor(message, context);
    if (!found.ok) return { response: found.response };
    if (
      found.task.status !== "working" &&
      found.task.status !== "input_required"
    ) {
      return {
        response: rpcError(
          message.id,
          -32602,
          `Cannot cancel task: already in terminal status '${found.task.status}'.`,
        ),
      };
    }
    try {
      const outcome = await cancel.call(this.#executor, {
        apiKey: context.apiKey,
        executionId: found.task.taskId,
      });
      const execution = outcome.execution;
      const terminal: StoredMcpTask = {
        ...found.task,
        executionStatus: execution.status,
        status: taskStatus(execution),
        statusMessage: taskStatusMessage(execution),
        lastUpdatedAt: new Date(this.#clock.now()).toISOString(),
        progress: 2,
      };
      const saved = await this.#saveTask(
        found.session.sessionId,
        found.session.authBinding,
        terminal,
      );
      this.#clearTaskPoll(found.session.sessionId, saved.task.taskId);
      this.#publishProgress(
        found.session.sessionId,
        saved.task,
        2,
        saved.task.statusMessage ?? "Execution reached a terminal state.",
      );
      this.#publishTaskStatus(found.session.sessionId, saved.task);
      this.#resolveTerminalWaiters(found.session.sessionId, saved.task.taskId);
      if (
        outcome.kind === "already_terminal" ||
        saved.task.status !== "cancelled"
      ) {
        return {
          response: rpcError(
            message.id,
            -32602,
            `Cannot cancel task: execution reached terminal status '${saved.task.status}' before cancellation won.`,
          ),
        };
      }
      return { response: rpcResult(message.id, taskView(saved.task)) };
    } catch {
      return {
        response: rpcError(message.id, -32603, "Failed to cancel task."),
      };
    }
  }

  async #taskFor(
    message: JsonRpcRequest,
    context: McpRequestContext,
  ): Promise<
    | { ok: true; session: StoredMcpSession; task: StoredMcpTask }
    | { ok: false; response: JsonRpcResponse }
  > {
    const taskId = taskIdParams(message.params);
    if (taskId === undefined) {
      return {
        ok: false,
        response: rpcError(message.id, -32602, "Invalid taskId params."),
      };
    }
    const session = await this.#sessionFor(context);
    if (session?.tasksEnabled !== true) {
      return {
        ok: false,
        response: rpcError(message.id, -32601, "Method not found"),
      };
    }
    const task = session.tasks[taskId];
    if (task === undefined) {
      return {
        ok: false,
        response: rpcError(message.id, -32602, "Task not found."),
      };
    }
    if (
      task.ttl !== null &&
      this.#clock.now() - Date.parse(task.createdAt) >= task.ttl
    ) {
      await this.#sessionStore.update(session.sessionId, (stored) => {
        if (stored.authBinding !== session.authBinding) return stored;
        const tasks = { ...stored.tasks };
        delete tasks[task.taskId];
        return { ...stored, tasks };
      });
      this.#clearTaskPoll(session.sessionId, task.taskId);
      this.#resolveTerminalWaiters(session.sessionId, task.taskId);
      return {
        ok: false,
        response: rpcError(message.id, -32602, "Task has expired."),
      };
    }
    return { ok: true, session, task };
  }

  async #refreshTask(
    session: StoredMcpSession,
    task: StoredMcpTask,
    apiKey: string,
  ): Promise<StoredMcpTask> {
    if (
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled" ||
      this.#executor.get === undefined
    ) {
      return task;
    }
    const execution = await this.#executor.get({
      apiKey,
      executionId: task.taskId,
    });
    if (execution.status === task.executionStatus) return task;

    const updated: StoredMcpTask = {
      ...task,
      executionStatus: execution.status,
      status: taskStatus(execution),
      statusMessage: taskStatusMessage(execution),
      lastUpdatedAt: new Date(this.#clock.now()).toISOString(),
      progress: executionProgress(execution.status),
    };
    const saved = await this.#saveTask(
      session.sessionId,
      session.authBinding,
      updated,
    );
    if (!saved.changed) return saved.task;
    if (execution.status === "running" && task.executionStatus === "pending") {
      this.#publishProgress(
        session.sessionId,
        updated,
        1,
        "Execution running.",
      );
    }
    if (
      updated.status === "completed" ||
      updated.status === "failed" ||
      updated.status === "cancelled"
    ) {
      this.#publishProgress(
        session.sessionId,
        updated,
        2,
        updated.status === "completed"
          ? "Execution completed."
          : updated.status === "failed"
            ? "Execution failed."
            : (updated.statusMessage ?? "Execution cancelled."),
      );
      this.#publishTaskStatus(session.sessionId, updated);
      this.#clearTaskPoll(session.sessionId, updated.taskId);
      this.#resolveTerminalWaiters(session.sessionId, updated.taskId);
    }
    return updated;
  }

  async #waitForTerminal(
    session: StoredMcpSession,
    task: StoredMcpTask,
    apiKey: string,
  ): Promise<void> {
    const key = taskKey(session.sessionId, task.taskId);
    const promise = new Promise<void>((resolve) => {
      const waiters = this.#terminalWaiters.get(key) ?? new Set();
      waiters.add(resolve);
      this.#terminalWaiters.set(key, waiters);
    });
    this.#scheduleTaskPoll(
      session.sessionId,
      task.taskId,
      session.authBinding,
      apiKey,
      task.pollInterval,
    );
    await promise;
  }

  #scheduleTaskPoll(
    sessionId: string,
    taskId: ExecutionId,
    authBinding: string,
    apiKey: string,
    pollInterval = this.#taskPollMs,
  ): void {
    if (this.#disposed) return;
    const key = taskKey(sessionId, taskId);
    if (this.#pollHandles.has(key)) return;
    const handle = this.#clock.setTimeout(
      () => {
        this.#pollHandles.delete(key);
        void this.#pollTask(sessionId, taskId, authBinding, apiKey);
      },
      Math.min(pollInterval, MAX_TIMER_DELAY_MS),
    );
    this.#pollHandles.set(key, handle);
  }

  async #pollTask(
    sessionId: string,
    taskId: ExecutionId,
    authBinding: string,
    apiKey: string,
  ): Promise<void> {
    let pollInterval = this.#taskPollMs;
    try {
      const session = await this.getSession(sessionId, authBinding);
      const task = session?.tasks[taskId];
      if (session === undefined || task === undefined) return;
      pollInterval = task.pollInterval;
      if (
        task.ttl !== null &&
        this.#clock.now() - Date.parse(task.createdAt) >= task.ttl
      ) {
        await this.#sessionStore.update(sessionId, (stored) => {
          if (stored.authBinding !== authBinding) return stored;
          const tasks = { ...stored.tasks };
          delete tasks[taskId];
          return { ...stored, tasks };
        });
        this.#clearTaskPoll(sessionId, taskId);
        this.#resolveTerminalWaiters(sessionId, taskId);
        return;
      }
      const updated = await this.#refreshTask(session, task, apiKey);
      if (updated.status === "working" || updated.status === "input_required") {
        this.#scheduleTaskPoll(
          sessionId,
          taskId,
          authBinding,
          apiKey,
          updated.pollInterval,
        );
      }
    } catch {
      this.#scheduleTaskPoll(
        sessionId,
        taskId,
        authBinding,
        apiKey,
        pollInterval,
      );
    }
  }

  #clearTaskPoll(sessionId: string, taskId: string): void {
    const key = taskKey(sessionId, taskId);
    const handle = this.#pollHandles.get(key);
    if (handle !== undefined) this.#clock.clearTimeout(handle);
    this.#pollHandles.delete(key);
  }

  #resolveTerminalWaiters(sessionId: string, taskId: string): void {
    const key = taskKey(sessionId, taskId);
    const waiters = this.#terminalWaiters.get(key);
    this.#terminalWaiters.delete(key);
    for (const resolve of waiters ?? []) resolve();
  }

  async #saveTask(
    sessionId: string,
    authBinding: string,
    task: StoredMcpTask,
  ): Promise<{ task: StoredMcpTask; changed: boolean }> {
    let changed = false;
    const updated = await this.#sessionStore.update(sessionId, (session) => {
      if (session.authBinding !== authBinding) return session;
      const selected = preferredTask(session.tasks[task.taskId], task);
      changed = selected === task;
      return {
        ...session,
        tasks: { ...session.tasks, [task.taskId]: selected },
      };
    });
    if (updated === undefined || updated.authBinding !== authBinding) {
      throw new Error("MCP session ended before task state could be saved.");
    }
    const stored = updated.tasks[task.taskId];
    if (stored === undefined) {
      throw new Error("MCP task disappeared while its state was being saved.");
    }
    return { task: stored, changed };
  }

  #publishProgress(
    sessionId: string,
    task: StoredMcpTask,
    progress: number,
    message: string,
  ): void {
    if (task.progressToken === undefined) return;
    this.#publish(sessionId, {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: task.progressToken,
        progress,
        total: 2,
        message,
        _meta: { [RELATED_TASK_META_KEY]: { taskId: task.taskId } },
      },
    });
  }

  #publishTaskStatus(sessionId: string, task: StoredMcpTask): void {
    this.#publish(sessionId, {
      jsonrpc: "2.0",
      method: "notifications/tasks/status",
      params: taskView(task),
    });
  }

  #publish(sessionId: string, message: JsonRpcNotification): void {
    const listener = this.#listeners.get(sessionId)?.values().next().value;
    listener?.(message);
  }

  #closeSessionListeners(sessionId: string): void {
    const listeners = this.#listeners.get(sessionId);
    this.#listeners.delete(sessionId);
    for (const listener of listeners ?? []) listener(undefined);
  }

  #cleanUpSession(session: StoredMcpSession): void {
    this.#clearSessionExpiry(session.sessionId);
    for (const taskId of Object.keys(session.tasks)) {
      this.#clearTaskPoll(session.sessionId, taskId);
      this.#resolveTerminalWaiters(session.sessionId, taskId);
    }
    this.#closeSessionListeners(session.sessionId);
  }

  #scheduleSessionExpiry(session: StoredMcpSession): void {
    if (this.#disposed) return;
    if (this.#sessionExpiryHandles.has(session.sessionId)) return;
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, Date.parse(session.expiresAt) - this.#clock.now()),
    );
    const handle = this.#clock.setTimeout(() => {
      this.#sessionExpiryHandles.delete(session.sessionId);
      void this.#expireSession(session.sessionId);
    }, delayMs);
    this.#sessionExpiryHandles.set(session.sessionId, handle);
  }

  async #expireSession(sessionId: string): Promise<void> {
    try {
      const session = await this.#sessionStore.get(sessionId);
      if (session === undefined) {
        this.#closeSessionListeners(sessionId);
        return;
      }
      if (this.#clock.now() < Date.parse(session.expiresAt)) {
        this.#scheduleSessionExpiry(session);
        return;
      }
      await this.#sessionStore.delete(sessionId);
      this.#cleanUpSession(session);
    } catch {
      // A later authenticated request retries the same expiry check through resolveSession().
    }
  }

  #clearSessionExpiry(sessionId: string): void {
    const handle = this.#sessionExpiryHandles.get(sessionId);
    if (handle !== undefined) this.#clock.clearTimeout(handle);
    this.#sessionExpiryHandles.delete(sessionId);
  }

  async #sessionFor(
    context: McpRequestContext,
  ): Promise<StoredMcpSession | undefined> {
    if (context.sessionId === undefined) return undefined;
    return this.getSession(context.sessionId, this.#authBinding(context));
  }

  #authBinding(context: McpRequestContext): string {
    return (
      context.authBinding ??
      createHash("sha256").update(context.apiKey).digest("base64url")
    );
  }
}

export function parseJsonRpc(
  text: string,
): { ok: true; value: unknown } | { ok: false; response: JsonRpcResponse } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: rpcError(null, -32700, "Parse error") };
  }
}
