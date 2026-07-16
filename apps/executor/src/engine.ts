import { createHash } from "node:crypto";
import { defaultCatalog } from "@eyeball/catalog";
import {
  type CatalogVersion,
  type CredentialProvider,
  CredentialProviderError,
  createExecutionId,
  type ExecuteRequest,
  type ExecutionBase,
  type ExecutionId,
  type ExecutionRecord,
  type ExecutionResult,
  type ExecutionStatus,
  EyeballError,
  type EyeballErrorOptions,
  isConnectionId,
  isExecutionId,
  type JsonValue,
  MockCredentialProvider,
  type NormalizedToolError,
  type ProviderManifest,
  type QualifiedToolName,
  type ResolvedCredential,
  TOOL_ERROR_CODES,
  type ToolDefinition,
  validateInput,
} from "@eyeball/core";
import { defaultToolkitAdapters } from "@eyeball/toolkits";
import {
  AdapterRegistry,
  type Clock,
  type ExecutorLogger,
  type FetchImplementation,
  noopLogger,
  systemClock,
} from "./adapters/index.js";
import { PromiseTaskQueue, type TaskQueue } from "./queue.js";
import {
  type ExecutionListFilters,
  type ExecutionPage,
  type ExecutionStore,
  type IdempotencyReservation,
  InMemoryExecutionStore,
  InvalidExecutionCursorError,
} from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const EXECUTE_REQUEST_KEYS = new Set([
  "tool",
  "userId",
  "connectionId",
  "input",
  "mode",
]);

export interface RuntimeCatalog {
  readonly catalogVersion: CatalogVersion;
  getTool(name: string): ToolDefinition | undefined;
  getManifest(toolkitSlug: string): ProviderManifest | undefined;
  getEffectiveScopes(
    name: string,
  ): { required: readonly string[]; optional: readonly string[] } | undefined;
}

export interface RunningExecuteResponse extends ExecutionBase {
  status: "running";
}

export type ExecuteHttpResponse = ExecutionResult | RunningExecuteResponse;

export interface ExecuteOutcome {
  statusCode: 200 | 202;
  response: ExecuteHttpResponse;
  replayed: boolean;
}

export interface ExecuteCommand {
  projectId: string;
  request: unknown;
  idempotencyKey?: string;
}

export interface ListExecutionsQuery {
  status?: ExecutionStatus;
  tool?: QualifiedToolName;
  userId?: string;
  cursor?: string;
  limit?: number;
}

export interface ExecutionEngineOptions {
  catalog?: RuntimeCatalog;
  adapters?: AdapterRegistry;
  credentialProvider?: CredentialProvider;
  store?: ExecutionStore;
  queue?: TaskQueue;
  fetchImpl?: FetchImplementation;
  clock?: Clock;
  logger?: ExecutorLogger;
  env?: Readonly<Record<string, string | undefined>>;
  executionIdFactory?: () => ExecutionId;
  idempotencyRetentionMs?: number;
}

export class ExecutionRequestError extends EyeballError {
  readonly httpStatus: 404 | 409 | 422;

  constructor(httpStatus: 404 | 409 | 422, options: EyeballErrorOptions) {
    super(options);
    this.name = "ExecutionRequestError";
    this.httpStatus = httpStatus;
  }
}

function invalidRequest(message: string, httpStatus: 409 | 422 = 422): never {
  throw new ExecutionRequestError(httpStatus, {
    code: TOOL_ERROR_CODES.INVALID_INPUT,
    message,
  });
}

function notSupported(message: string): never {
  throw new ExecutionRequestError(422, {
    code: TOOL_ERROR_CODES.NOT_SUPPORTED,
    message,
  });
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExecuteRequest(value: unknown): ExecuteRequest {
  if (!isObject(value)) {
    return invalidRequest("The execute request must be a JSON object.");
  }
  const unknownKey = Object.keys(value).find(
    (key) => !EXECUTE_REQUEST_KEYS.has(key),
  );
  if (unknownKey !== undefined) {
    return invalidRequest(`Unknown execute request field: ${unknownKey}.`);
  }
  if (typeof value.tool !== "string") {
    return invalidRequest("tool must be a qualified tool name.");
  }
  if (typeof value.userId !== "string" || value.userId.trim().length === 0) {
    return invalidRequest("userId must be a non-empty string.");
  }
  if (!isObject(value.input)) {
    return invalidRequest("input must be a JSON object.");
  }
  if (value.mode !== "sync" && value.mode !== "async") {
    return invalidRequest('mode must be either "sync" or "async".');
  }
  if (
    value.connectionId !== undefined &&
    (typeof value.connectionId !== "string" ||
      !isConnectionId(value.connectionId))
  ) {
    return invalidRequest("connectionId must be a valid conn_* identifier.");
  }

  return {
    tool: value.tool as QualifiedToolName,
    userId: value.userId,
    ...(value.connectionId === undefined
      ? {}
      : { connectionId: value.connectionId }),
    input: value.input as Readonly<Record<string, JsonValue>>,
    mode: value.mode,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function hashRequest(request: ExecuteRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(request)))
    .digest("hex");
}

function executeResponse(record: ExecutionRecord): ExecuteHttpResponse {
  const base: ExecutionBase = {
    executionId: record.executionId,
    tool: record.tool,
    toolVersion: record.toolVersion,
    catalogVersion: record.catalogVersion,
    status: record.status,
  };
  switch (record.status) {
    case "pending":
      return { ...base, status: "pending" };
    case "running":
      return { ...base, status: "running" };
    case "succeeded":
      return {
        ...base,
        status: "succeeded",
        output: record.output,
        latencyMs: record.latencyMs,
      };
    case "failed":
      return {
        ...base,
        status: "failed",
        error: record.error,
        latencyMs: record.latencyMs,
      };
  }
}

function normalizedError(error: unknown): NormalizedToolError {
  if (error instanceof EyeballError) {
    return error.toJSON();
  }
  if (error instanceof CredentialProviderError) {
    return new EyeballError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.retryAfter === undefined
        ? {}
        : { retryAfter: error.retryAfter }),
      cause: error,
    }).toJSON();
  }
  return new EyeballError({
    code: TOOL_ERROR_CODES.PROVIDER_ERROR,
    message:
      "Execution failed because an internal component returned an unexpected error.",
    retryable: false,
    cause: error,
  }).toJSON();
}

function resolveBaseUrl(
  manifest: ProviderManifest,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const overrideName = manifest.endpoint.baseUrlOverrideEnv;
  const override =
    overrideName === undefined ? undefined : env[overrideName]?.trim();
  const candidate =
    override === undefined || override.length === 0
      ? manifest.endpoint.baseUrl
      : override;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch (error) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: `The configured ${manifest.toolkit.slug} base URL is invalid.`,
      cause: error,
    });
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: `The configured ${manifest.toolkit.slug} base URL is invalid.`,
    });
  }
  return url.toString();
}

function validateCredential(
  credential: ResolvedCredential,
  request: ExecuteRequest,
  manifest: ProviderManifest,
  requiredScopes: readonly string[],
  now: Date,
): void {
  if (credential.type !== manifest.auth.class) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_MISSING,
      message: `No usable ${manifest.toolkit.slug} credential matches the required auth class.`,
    });
  }
  if (
    request.connectionId !== undefined &&
    credential.connectionId !== request.connectionId
  ) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_MISSING,
      message:
        "No usable connection exists for this project, user, and toolkit.",
    });
  }
  if (credential.expiresAt !== undefined) {
    const expiresAt = Date.parse(credential.expiresAt);
    if (Number.isNaN(expiresAt) || expiresAt <= now.valueOf()) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.AUTH_EXPIRED,
        message: `The selected ${manifest.toolkit.slug} credential is expired.`,
      });
    }
  }
  if (
    requiredScopes.some((scope) => credential.scopes?.includes(scope) !== true)
  ) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE,
      message: `The selected ${manifest.toolkit.slug} credential lacks a required scope.`,
    });
  }
}

export class ExecutionEngine {
  readonly catalog: RuntimeCatalog;
  readonly adapters: AdapterRegistry;
  readonly credentialProvider: CredentialProvider;
  readonly store: ExecutionStore;
  readonly queue: TaskQueue;
  readonly #fetchImpl: FetchImplementation;
  readonly #clock: Clock;
  readonly #logger: ExecutorLogger;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #executionIdFactory: () => ExecutionId;
  readonly #idempotencyRetentionMs: number;

  constructor(options: ExecutionEngineOptions = {}) {
    this.catalog = options.catalog ?? defaultCatalog;
    this.adapters =
      options.adapters ?? new AdapterRegistry(defaultToolkitAdapters);
    this.credentialProvider =
      options.credentialProvider ?? new MockCredentialProvider([]);
    this.store = options.store ?? new InMemoryExecutionStore();
    this.queue = options.queue ?? new PromiseTaskQueue();
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? noopLogger;
    this.#env = options.env ?? process.env;
    this.#executionIdFactory = options.executionIdFactory ?? createExecutionId;
    this.#idempotencyRetentionMs = Math.max(
      DAY_MS,
      options.idempotencyRetentionMs ?? DAY_MS,
    );
  }

  async execute(command: ExecuteCommand): Promise<ExecuteOutcome> {
    if (command.projectId.trim().length === 0) {
      return invalidRequest("Authenticated project ID must not be empty.");
    }
    const request = parseExecuteRequest(command.request);
    const tool = this.catalog.getTool(request.tool);
    if (tool === undefined) {
      return notSupported(`Tool ${request.tool} is not supported.`);
    }
    const manifest = this.catalog.getManifest(tool.toolkit);
    const effectiveScopes = this.catalog.getEffectiveScopes(tool.name);
    if (manifest === undefined || effectiveScopes === undefined) {
      return notSupported(`Tool ${request.tool} is not supported.`);
    }

    const validation = validateInput(tool, request.input);
    if (!validation.ok) {
      const first = validation.errors[0];
      return invalidRequest(
        first === undefined
          ? "Canonical input is invalid."
          : `Canonical input is invalid: ${first.message}`,
      );
    }
    const canonicalRequest: ExecuteRequest = {
      ...request,
      input: validation.value,
    };
    if (tool.annotations.async && canonicalRequest.mode === "sync") {
      return invalidRequest(
        `Tool ${tool.name} is async by nature and does not accept sync mode.`,
      );
    }
    if (
      command.idempotencyKey !== undefined &&
      command.idempotencyKey.length === 0
    ) {
      return invalidRequest("Idempotency-Key must not be empty.");
    }
    if (!tool.annotations.readOnly && command.idempotencyKey === undefined) {
      return invalidRequest(
        `Idempotency-Key is required for mutating tool ${tool.name}.`,
      );
    }

    const createdAt = this.#now();
    const idempotency =
      command.idempotencyKey === undefined
        ? undefined
        : this.#idempotencyReservation(
            canonicalRequest,
            command.idempotencyKey,
            createdAt,
          );
    const pending: ExecutionRecord & { status: "pending" } = {
      executionId: this.#executionIdFactory(),
      tool: tool.name,
      toolVersion: tool.version,
      catalogVersion: this.catalog.catalogVersion,
      status: "pending",
      userId: canonicalRequest.userId,
      createdAt: createdAt.toISOString(),
    };
    const allocation = await this.store.allocate({
      projectId: command.projectId,
      record: pending,
      ...(idempotency === undefined ? {} : { idempotency }),
    });
    if (allocation.kind === "conflict") {
      return invalidRequest(
        "Idempotency-Key was already used with different request parameters.",
        409,
      );
    }
    if (allocation.kind === "replay") {
      return {
        statusCode:
          allocation.record.status === "pending" ||
          allocation.record.status === "running"
            ? 202
            : 200,
        response: executeResponse(allocation.record),
        replayed: true,
      };
    }

    if (canonicalRequest.mode === "async") {
      void this.queue
        .enqueue(() =>
          this.#runAllocated(
            command.projectId,
            allocation.record,
            canonicalRequest,
            tool,
            manifest,
            effectiveScopes.required,
          ),
        )
        .catch((error: unknown) => {
          this.#logger.error(
            "Queued execution failed outside the engine boundary.",
            {
              executionId: allocation.record.executionId,
              errorName: error instanceof Error ? error.name : "unknown",
            },
          );
        });
      return {
        statusCode: 202,
        response: executeResponse(allocation.record),
        replayed: false,
      };
    }

    await this.#runAllocated(
      command.projectId,
      allocation.record,
      canonicalRequest,
      tool,
      manifest,
      effectiveScopes.required,
    );
    const terminal = await this.store.get(
      command.projectId,
      allocation.record.executionId,
    );
    if (terminal === undefined) {
      throw new Error(
        "Allocated execution disappeared from the execution store.",
      );
    }
    return {
      statusCode: 200,
      response: executeResponse(terminal),
      replayed: false,
    };
  }

  async getExecution(
    projectId: string,
    executionId: string,
  ): Promise<ExecutionRecord> {
    if (!isExecutionId(executionId)) {
      throw new ExecutionRequestError(404, {
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message: "Execution was not found.",
      });
    }
    const execution = await this.store.get(projectId, executionId);
    if (execution === undefined) {
      throw new ExecutionRequestError(404, {
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message: "Execution was not found.",
      });
    }
    return execution;
  }

  async listExecutions(
    projectId: string,
    query: ListExecutionsQuery = {},
  ): Promise<ExecutionPage> {
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return invalidRequest("limit must be an integer from 1 through 100.");
    }
    const filters: ExecutionListFilters = {
      limit,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.tool === undefined ? {} : { tool: query.tool }),
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    };
    try {
      return await this.store.list(projectId, filters);
    } catch (error) {
      if (error instanceof InvalidExecutionCursorError) {
        return invalidRequest(error.message);
      }
      throw error;
    }
  }

  #idempotencyReservation(
    request: ExecuteRequest,
    key: string,
    createdAt: Date,
  ): IdempotencyReservation {
    return {
      scope: {
        key,
        tool: request.tool,
        userId: request.userId,
        connectionId: request.connectionId ?? "default",
        catalogMajor: this.catalog.catalogVersion.split(".", 1)[0] ?? "0",
      },
      requestHash: hashRequest(request),
      expiresAt: new Date(
        createdAt.valueOf() + this.#idempotencyRetentionMs,
      ).toISOString(),
    };
  }

  async #runAllocated(
    projectId: string,
    pending: ExecutionRecord & { status: "pending" },
    request: ExecuteRequest,
    tool: ToolDefinition,
    manifest: ProviderManifest,
    requiredScopes: readonly string[],
  ): Promise<void> {
    const startedAt = this.#now();
    const startedAtIso = startedAt.toISOString();
    const running: ExecutionRecord & { status: "running" } = {
      executionId: pending.executionId,
      tool: pending.tool,
      toolVersion: pending.toolVersion,
      catalogVersion: pending.catalogVersion,
      status: "running",
      userId: pending.userId,
      createdAt: pending.createdAt,
      startedAt: startedAtIso,
    };
    await this.store.update(projectId, running);

    try {
      const adapter = this.adapters.require(tool.toolkit);
      const credential = await this.credentialProvider.resolve({
        projectId,
        userId: request.userId,
        toolkitSlug: tool.toolkit,
        ...(request.connectionId === undefined
          ? {}
          : { connectionId: request.connectionId }),
      });
      validateCredential(
        credential,
        request,
        manifest,
        requiredScopes,
        this.#now(),
      );
      await this.store.setResolvedConnection(
        projectId,
        pending.executionId,
        credential.connectionId,
      );
      const output = await adapter.execute({
        tool,
        canonicalInput: request.input,
        credential,
        baseUrl: resolveBaseUrl(manifest, this.#env),
        fetchImpl: this.#fetchImpl,
        clock: this.#clock,
        logger: this.#logger,
      });
      const canonicalOutput = this.#validateOutput(tool, output);
      const completedAt = this.#now();
      await this.store.update(projectId, {
        executionId: running.executionId,
        tool: running.tool,
        toolVersion: running.toolVersion,
        catalogVersion: running.catalogVersion,
        status: "succeeded",
        userId: running.userId,
        createdAt: running.createdAt,
        startedAt: startedAtIso,
        completedAt: completedAt.toISOString(),
        output: canonicalOutput,
        latencyMs: Math.max(0, completedAt.valueOf() - startedAt.valueOf()),
      });
    } catch (error) {
      const completedAt = this.#now();
      this.#logger.warn("Execution completed with a normalized failure.", {
        executionId: pending.executionId,
        tool: tool.name,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      await this.store.update(projectId, {
        executionId: running.executionId,
        tool: running.tool,
        toolVersion: running.toolVersion,
        catalogVersion: running.catalogVersion,
        status: "failed",
        userId: running.userId,
        createdAt: running.createdAt,
        startedAt: startedAtIso,
        completedAt: completedAt.toISOString(),
        error: normalizedError(error),
        latencyMs: Math.max(0, completedAt.valueOf() - startedAt.valueOf()),
      });
    }
  }

  #validateOutput(tool: ToolDefinition, output: JsonValue): JsonValue {
    if (tool.outputSchema === undefined) {
      return output;
    }
    const validation = validateInput(
      { inputSchema: tool.outputSchema },
      output,
    );
    if (!validation.ok) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.PROVIDER_ERROR,
        message: `Adapter output for ${tool.name} violated the canonical output schema.`,
        providerDetail: { toolkit: tool.toolkit },
      });
    }
    return validation.value;
  }

  #now(): Date {
    const now = this.#clock.now();
    if (Number.isNaN(now.valueOf())) {
      throw new Error("Executor clock returned an invalid date.");
    }
    return new Date(now.valueOf());
  }
}
