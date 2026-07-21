import { createHash } from "node:crypto";
import { defaultCatalog } from "@eyeball/catalog";
import {
  type CredentialProvider,
  CredentialProviderError,
  createExecutionId,
  createFileId,
  type ExecuteRequest,
  type ExecutionBase,
  type ExecutionId,
  type ExecutionMode,
  type ExecutionRecord,
  type ExecutionResult,
  type ExecutionStatus,
  EyeballError,
  type EyeballErrorOptions,
  type FileId,
  fromRestrictedToolName,
  isCanonicalToolName,
  isConnectionId,
  isExecutionId,
  isFileId,
  type JsonValue,
  MockCredentialProvider,
  type NormalizedToolError,
  type ProviderManifest,
  type QualifiedToolName,
  type ResolvedCredential,
  type StagedFileMetadata,
  type StagedFilePage,
  TOOL_ERROR_CODES,
  type ToolDefinition,
  validateInput,
  validateOutput,
} from "@eyeball/core";
import { defaultToolkitAdapters } from "@eyeball/toolkits";
import type { Context, Span } from "@opentelemetry/api";
import {
  AdapterRegistry,
  type Clock,
  type ExecutorLogger,
  type FetchImplementation,
  systemClock,
} from "./adapters/index.js";
import {
  createExecutorJobHandlerRegistry,
  InMemoryTaskQueue,
  type JobHandlerContext,
  type JobHandlerResult,
  type TaskQueue,
} from "./queue.js";
import {
  type ConcurrencyPermit,
  InMemoryToolkitConcurrencyLimiter,
  type ToolkitConcurrencyLimiter,
} from "./rate-limit.js";
import {
  DEFAULT_FILE_TTL_MS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  type FileStore,
  InMemoryFileStore,
  InvalidFileCursorError,
} from "./staged-files.js";
import {
  type ExecutionAllocation,
  type ExecutionAllocationResult,
  type ExecutionDetailRecord,
  type ExecutionListFilters,
  type ExecutionPage,
  type ExecutionResumeContext,
  type ExecutionStore,
  type IdempotencyReservation,
  InMemoryExecutionStore,
  InvalidExecutionCursorError,
  type RecoverableExecution,
} from "./store.js";
import {
  createExecutorTelemetryRuntime,
  type ExecutorTelemetry,
  type ExecutorTelemetryRuntime,
  inTelemetrySpan,
  markSpanError,
  markSpanOk,
} from "./telemetry/index.js";
import {
  type RuntimeTriggerCatalog,
  TriggerService,
} from "./triggers/service.js";
import {
  NoopUsageGate,
  type UsageAdmission,
  type UsageGate,
  UsageGateUnavailableError,
  type UsageReportContext,
  type UsageReservationHandle,
} from "./usage/index.js";
import { WebhookDeliverer } from "./webhooks/deliverer.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const EXECUTE_REQUEST_KEYS = new Set([
  "tool",
  "userId",
  "connectionId",
  "input",
  "mode",
]);

export interface RuntimeCatalog extends RuntimeTriggerCatalog {
  getTool(name: string): ToolDefinition | undefined;
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

interface TracedExecuteResult {
  outcome: ExecuteOutcome;
  deferred: boolean;
}

export interface ExecuteCommand {
  projectId: string;
  request: unknown;
  idempotencyKey?: string;
  /** Trusted worker reservation; never accepted from the public HTTP request body. */
  executionId?: ExecutionId;
}

export interface ListExecutionsQuery {
  status?: ExecutionStatus;
  tool?: QualifiedToolName;
  userId?: string;
  cursor?: string;
  limit?: number;
}

export interface ListFilesQuery {
  cursor?: string;
  limit?: number;
}

export interface StageFileInput {
  name: string;
  mimeType: string;
  content: Uint8Array;
}

export interface ExecutionEngineOptions {
  catalog?: RuntimeCatalog;
  adapters?: AdapterRegistry;
  credentialProvider?: CredentialProvider;
  store?: ExecutionStore;
  fileStore?: FileStore;
  queue?: TaskQueue;
  fetchImpl?: FetchImplementation;
  clock?: Clock;
  telemetry?: ExecutorTelemetry;
  /** Pre-resolved shared runtime used by the stock runtime factory. */
  telemetryRuntime?: ExecutorTelemetryRuntime;
  /** @deprecated Pass telemetry.logger instead. */
  logger?: ExecutorLogger;
  env?: Readonly<Record<string, string | undefined>>;
  executionIdFactory?: () => ExecutionId;
  fileIdFactory?: () => FileId;
  fileTtlMs?: number;
  maxFileSizeBytes?: number;
  idempotencyRetentionMs?: number;
  webhookDeliverer?: WebhookDeliverer;
  triggerService?: TriggerService;
  toolkitConcurrencyLimiter?: ToolkitConcurrencyLimiter;
  usageGate?: UsageGate;
}

export interface ExecutionRateLimitMetadata {
  limit: number;
  remaining: number;
  resetAt: number;
}

export class ExecutionRequestError extends EyeballError {
  readonly httpStatus: 404 | 409 | 413 | 422 | 429;
  readonly rateLimit?: ExecutionRateLimitMetadata;

  constructor(
    httpStatus: 404 | 409 | 413 | 422 | 429,
    options: EyeballErrorOptions,
    rateLimit?: ExecutionRateLimitMetadata,
  ) {
    super(options);
    this.name = "ExecutionRequestError";
    this.httpStatus = httpStatus;
    if (rateLimit !== undefined) {
      this.rateLimit = rateLimit;
    }
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

function positiveIntegerConfig(
  explicit: number | undefined,
  encoded: string | undefined,
  fallback: number,
  name: string,
): number {
  const value =
    explicit ?? (encoded === undefined ? fallback : Number(encoded));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ParsedExecuteRequest = Omit<ExecuteRequest, "mode"> & {
  mode?: ExecutionMode;
};

function canonicalToolName(value: string): QualifiedToolName {
  if (isCanonicalToolName(value)) return value;
  try {
    return fromRestrictedToolName(value);
  } catch {
    return invalidRequest(
      "tool must be a canonical dotted or reversible restricted tool name.",
    );
  }
}

function parseExecuteRequest(value: unknown): ParsedExecuteRequest {
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
  if (
    value.mode !== undefined &&
    value.mode !== "sync" &&
    value.mode !== "async"
  ) {
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
    tool: canonicalToolName(value.tool),
    userId: value.userId,
    ...(value.connectionId === undefined
      ? {}
      : { connectionId: value.connectionId }),
    input: value.input as Readonly<Record<string, JsonValue>>,
    ...(value.mode === undefined ? {} : { mode: value.mode }),
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

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

interface ExecutionTrace {
  readonly span?: Span;
  readonly context?: Context;
  finish(status: string, error?: unknown): void;
}

function startExecutionTrace(
  telemetry: ExecutorTelemetryRuntime,
  command: ExecuteCommand,
): ExecutionTrace {
  const started = telemetry.startSpan("eyeball.execute", {
    "eyeball.project.id": command.projectId,
  });
  let finished = false;
  return {
    ...started,
    finish(status, error) {
      if (finished) return;
      finished = true;
      started.span?.setAttribute("eyeball.execution.status", status);
      if (error !== undefined || status === "failed" || status === "rejected") {
        markSpanError(started.span, error);
      } else {
        markSpanOk(started.span);
      }
      started.span?.end();
    },
  };
}

function hashRequest(request: ExecuteRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(request)))
    .digest("hex");
}

export interface UsageIdempotencyIdentity {
  readonly projectId: string;
  readonly executionId: ExecutionId;
  readonly request: ExecuteRequest;
  readonly catalogVersion: string;
  readonly idempotencyKey?: string;
}

/** Opaque, deterministic Cloud identity; raw client idempotency keys never leave the executor. */
export function deriveUsageIdempotencyKey(
  identity: UsageIdempotencyIdentity,
): string {
  const catalogMajor = identity.catalogVersion.split(".", 1)[0] ?? "0";
  const material =
    identity.idempotencyKey === undefined
      ? ["usage-v1", identity.projectId, identity.executionId]
      : [
          "usage-v1",
          identity.projectId,
          identity.request.tool,
          identity.request.userId,
          identity.request.connectionId ?? "default",
          catalogMajor,
          identity.idempotencyKey,
          hashRequest(identity.request),
        ];
  return `usage_${createHash("sha256")
    .update(JSON.stringify(material))
    .digest("base64url")}`;
}

/** Stable webhook identity allocated before execution dispatch for recovery. */
export function deriveExecutionWebhookEventId(
  projectId: string,
  executionId: ExecutionId,
): string {
  return `evt_${createHash("sha256")
    .update(JSON.stringify(["execution.webhook.v1", projectId, executionId]))
    .digest("base64url")}`;
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

class UnexpectedCredentialProviderError extends Error {
  constructor(cause: unknown) {
    super("Credential provider failed unexpectedly.", { cause });
    this.name = "UnexpectedCredentialProviderError";
  }
}

class ExecutionDispatchFencedError extends Error {
  constructor() {
    super("Execution provider dispatch was fenced by another worker.");
    this.name = "ExecutionDispatchFencedError";
  }
}

function credentialFailureKind(error: unknown): string {
  if (
    error instanceof CredentialProviderError ||
    error instanceof EyeballError
  ) {
    return error.code;
  }
  return error instanceof UnexpectedCredentialProviderError
    ? "unexpected_provider_error"
    : "unexpected_error";
}

function validationMessage(
  errors: readonly { instancePath: string; message: string }[],
): string {
  const first = errors[0];
  if (first === undefined) return "Canonical input is invalid.";
  const location =
    first.instancePath.length === 0 ? "input" : `input${first.instancePath}`;
  const remaining = errors.length - 1;
  return `Canonical input is invalid at ${location}: ${first.message}${remaining === 0 ? "" : ` (${remaining} more issue${remaining === 1 ? "" : "s"}).`}`;
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
  readonly fileStore: FileStore;
  readonly fileTtlMs: number;
  readonly maxFileSizeBytes: number;
  readonly queue: TaskQueue;
  readonly webhookDeliverer: WebhookDeliverer;
  readonly triggerService: TriggerService;
  readonly toolkitConcurrencyLimiter: ToolkitConcurrencyLimiter;
  readonly telemetry: ExecutorTelemetryRuntime;
  readonly usageGate: UsageGate;
  readonly #fetchImpl: FetchImplementation;
  readonly #clock: Clock;
  readonly #logger: ExecutorLogger;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #executionIdFactory: () => ExecutionId;
  readonly #fileIdFactory: () => FileId;
  readonly #idempotencyRetentionMs: number;
  constructor(options: ExecutionEngineOptions = {}) {
    this.catalog = options.catalog ?? defaultCatalog;
    this.adapters =
      options.adapters ?? new AdapterRegistry(defaultToolkitAdapters);
    this.credentialProvider =
      options.credentialProvider ?? new MockCredentialProvider([]);
    this.#clock = options.clock ?? systemClock;
    this.#env = options.env ?? process.env;
    this.store = options.store ?? new InMemoryExecutionStore();
    this.fileStore = options.fileStore ?? new InMemoryFileStore();
    this.fileTtlMs = positiveIntegerConfig(
      options.fileTtlMs,
      this.#env.EYEBALL_FILE_TTL_MS,
      DEFAULT_FILE_TTL_MS,
      "fileTtlMs",
    );
    this.maxFileSizeBytes = positiveIntegerConfig(
      options.maxFileSizeBytes,
      this.#env.EYEBALL_FILE_MAX_BYTES,
      DEFAULT_MAX_FILE_SIZE_BYTES,
      "maxFileSizeBytes",
    );
    this.toolkitConcurrencyLimiter =
      options.toolkitConcurrencyLimiter ??
      new InMemoryToolkitConcurrencyLimiter();
    this.#fetchImpl = options.fetchImpl ?? fetch;
    const configuredLogger = options.telemetry?.logger ?? options.logger;
    this.telemetry =
      options.telemetryRuntime ??
      createExecutorTelemetryRuntime(
        {
          ...options.telemetry,
          ...(configuredLogger === undefined
            ? {}
            : { logger: configuredLogger }),
        },
        this.#env,
      );
    this.#logger = this.telemetry.logger;
    this.usageGate = options.usageGate ?? new NoopUsageGate();
    let ownedQueue: InMemoryTaskQueue | undefined;
    if (options.queue === undefined) {
      ownedQueue = new InMemoryTaskQueue({
        clock: this.#clock,
        logger: this.#logger,
      });
      this.queue = ownedQueue;
    } else {
      this.queue = options.queue;
    }
    this.webhookDeliverer =
      options.webhookDeliverer ??
      new WebhookDeliverer({
        queue: this.queue,
        executionStore: this.store,
        fetchImpl: this.#fetchImpl,
        clock: this.#clock,
        telemetry: this.telemetry,
      });
    this.triggerService =
      options.triggerService ??
      new TriggerService({
        catalog: this.catalog,
        credentialProvider: this.credentialProvider,
        webhookDeliverer: this.webhookDeliverer,
        fetchImpl: this.#fetchImpl,
        clock: this.#clock,
        telemetry: this.telemetry,
        env: this.#env,
      });
    if (
      this.triggerService.catalog !== this.catalog ||
      this.triggerService.credentialProvider !== this.credentialProvider ||
      this.triggerService.webhookDeliverer !== this.webhookDeliverer
    ) {
      throw new Error(
        "The execution engine and trigger service must share catalog, credential, and webhook dependencies.",
      );
    }
    this.#executionIdFactory = options.executionIdFactory ?? createExecutionId;
    this.#fileIdFactory = options.fileIdFactory ?? createFileId;
    this.#idempotencyRetentionMs = Math.max(
      DAY_MS,
      options.idempotencyRetentionMs ?? DAY_MS,
    );
    if (ownedQueue !== undefined) {
      ownedQueue.bindHandlers(
        createExecutorJobHandlerRegistry({
          engine: this,
          webhookDeliverer: this.webhookDeliverer,
        }),
      );
      ownedQueue.start();
    }
  }

  async stageFile(
    projectId: string,
    input: StageFileInput,
  ): Promise<StagedFileMetadata> {
    if (projectId.trim().length === 0) {
      return invalidRequest("Authenticated project ID must not be empty.");
    }
    const name = input.name.trim();
    if (
      name.length === 0 ||
      Buffer.byteLength(name, "utf8") > 255 ||
      name.includes("\0") ||
      name.includes("\r") ||
      name.includes("\n")
    ) {
      return invalidRequest(
        "name must be 1-255 UTF-8 bytes without nulls or line breaks.",
      );
    }
    const mimeType = input.mimeType.trim();
    if (
      mimeType.length === 0 ||
      mimeType.length > 255 ||
      mimeType.includes("\0") ||
      mimeType.includes("\r") ||
      mimeType.includes("\n") ||
      !/^[^\s/;]+\/[^\s;]+(?:\s*;.*)?$/u.test(mimeType)
    ) {
      return invalidRequest("mimeType must be a valid MIME type.");
    }
    if (!(input.content instanceof Uint8Array)) {
      return invalidRequest("content must decode to binary bytes.");
    }
    if (input.content.byteLength > this.maxFileSizeBytes) {
      throw new ExecutionRequestError(413, {
        code: TOOL_ERROR_CODES.INVALID_INPUT,
        message: `File content exceeds the ${this.maxFileSizeBytes}-byte staging limit.`,
      });
    }
    const fileId = this.#fileIdFactory();
    if (!isFileId(fileId)) {
      throw new Error("File ID factory returned an invalid file_* identifier.");
    }
    const now = this.#now();
    const expiresAt = new Date(now.valueOf() + this.fileTtlMs);
    if (Number.isNaN(expiresAt.valueOf())) {
      throw new Error(
        "Configured staged-file TTL exceeds the supported date range.",
      );
    }
    const meta: StagedFileMetadata = {
      fileId,
      name,
      mimeType,
      size: input.content.byteLength,
      expiresAt: expiresAt.toISOString(),
    };
    await this.fileStore.put(projectId, {
      meta,
      content: Uint8Array.from(input.content),
      createdAt: now.toISOString(),
    });
    return structuredClone(meta);
  }

  async getFile(
    projectId: string,
    fileId: string,
  ): Promise<{ meta: StagedFileMetadata; content: Uint8Array }> {
    if (!isFileId(fileId)) {
      throw new ExecutionRequestError(404, {
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message: "Staged file was not found or has expired.",
      });
    }
    const now = this.#now();
    const file = await this.fileStore.get(projectId, fileId, now.toISOString());
    if (file === undefined) {
      throw new ExecutionRequestError(404, {
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message: "Staged file was not found or has expired.",
      });
    }
    const expiresAt = Date.parse(file.meta.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new Error("File store returned an invalid expiry timestamp.");
    }
    if (expiresAt <= now.valueOf()) {
      throw new ExecutionRequestError(404, {
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message: "Staged file was not found or has expired.",
      });
    }
    return file;
  }

  async getFileMetadata(
    projectId: string,
    fileId: string,
  ): Promise<StagedFileMetadata> {
    if (!isFileId(fileId)) {
      throw new ExecutionRequestError(404, {
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message: "Staged file was not found or has expired.",
      });
    }
    const now = this.#now();
    const metadata = await this.fileStore.getMetadata(
      projectId,
      fileId,
      now.toISOString(),
    );
    if (metadata === undefined) {
      throw new ExecutionRequestError(404, {
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message: "Staged file was not found or has expired.",
      });
    }
    const expiresAt = Date.parse(metadata.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new Error("File store returned an invalid expiry timestamp.");
    }
    if (expiresAt <= now.valueOf()) {
      throw new ExecutionRequestError(404, {
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message: "Staged file was not found or has expired.",
      });
    }
    return structuredClone(metadata);
  }

  async listFiles(
    projectId: string,
    query: ListFilesQuery = {},
  ): Promise<StagedFilePage> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return invalidRequest("limit must be an integer from 1 through 100.");
    }
    const now = this.#now();
    let page: StagedFilePage;
    try {
      page = await this.fileStore.list(projectId, {
        limit,
        now: now.toISOString(),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
    } catch (error) {
      if (error instanceof InvalidFileCursorError) {
        return invalidRequest(error.message);
      }
      throw error;
    }
    for (const metadata of page.files) {
      const expiresAt = Date.parse(metadata.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now.valueOf()) {
        throw new Error("File store returned invalid or expired metadata.");
      }
    }
    return structuredClone(page);
  }

  async execute(command: ExecuteCommand): Promise<ExecuteOutcome> {
    const executionTrace = startExecutionTrace(this.telemetry, command);
    try {
      const result = await this.#execute(command, executionTrace);
      if (!result.deferred) {
        executionTrace.finish(result.outcome.response.status);
      }
      return result.outcome;
    } catch (error) {
      executionTrace.finish("rejected", error);
      throw error;
    }
  }

  async #execute(
    command: ExecuteCommand,
    executionTrace: ExecutionTrace,
  ): Promise<TracedExecuteResult> {
    const validated = await inTelemetrySpan(
      this.telemetry,
      "eyeball.execute.validate",
      { "eyeball.project.id": command.projectId },
      async (_spanContext, span) => {
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
        span?.setAttribute("eyeball.schema.valid", validation.ok);
        if (!validation.ok) {
          return invalidRequest(validationMessage(validation.errors));
        }
        const canonicalRequest: ExecuteRequest = {
          ...request,
          mode: request.mode ?? (tool.annotations.async ? "async" : "sync"),
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
        if (
          command.executionId !== undefined &&
          !isExecutionId(command.executionId)
        ) {
          return invalidRequest("The reserved execution ID is invalid.");
        }
        if (
          !tool.annotations.readOnly &&
          command.idempotencyKey === undefined
        ) {
          return invalidRequest(
            `Idempotency-Key is required for mutating tool ${tool.name}.`,
          );
        }
        return {
          canonicalRequest,
          tool,
          manifest,
          requiredScopes: effectiveScopes.required,
        };
      },
      executionTrace.context,
    );
    const { canonicalRequest, tool, manifest, requiredScopes } = validated;
    executionTrace.span?.setAttribute("eyeball.tool", tool.name);
    executionTrace.span?.setAttribute(
      "eyeball.execution.mode",
      canonicalRequest.mode,
    );
    executionTrace.span?.setAttribute(
      "eyeball.input.size_bytes",
      jsonByteLength(canonicalRequest.input),
    );

    const concurrencyLimit = manifest.limits?.maxConcurrentExecutionsPerProject;
    const concurrencyBucketKey = `${command.projectId}:${tool.toolkit}`;
    let syncPermit: ConcurrencyPermit | undefined;
    if (canonicalRequest.mode === "sync" && concurrencyLimit !== undefined) {
      syncPermit = this.toolkitConcurrencyLimiter.tryAcquire(
        concurrencyBucketKey,
        concurrencyLimit,
      );
      if (syncPermit === undefined) {
        const retryAfter = 1;
        const now = this.#now().valueOf();
        this.telemetry.recordRateLimitRejection("toolkit_concurrency");
        this.#logger.warn("rate_limit.rejected", {
          projectId: command.projectId,
          tool: tool.name,
          bucket: "toolkit_concurrency",
        });
        throw new ExecutionRequestError(
          429,
          {
            code: TOOL_ERROR_CODES.RATE_LIMITED,
            message: `The ${tool.toolkit} concurrency limit is currently full.`,
            retryable: true,
            retryAfter,
          },
          {
            limit: concurrencyLimit,
            remaining: 0,
            resetAt: now + retryAfter * 1_000,
          },
        );
      }
    }

    try {
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
        executionId: command.executionId ?? this.#executionIdFactory(),
        tool: tool.name,
        toolVersion: tool.version,
        catalogVersion: this.catalog.catalogVersion,
        status: "pending",
        userId: canonicalRequest.userId,
        createdAt: createdAt.toISOString(),
      };
      let allocationRequest: ExecutionAllocation = {
        projectId: command.projectId,
        record: pending,
        request: canonicalRequest,
        ...(idempotency === undefined ? {} : { idempotency }),
      };

      let allocation: ExecutionAllocationResult | undefined;
      if (this.usageGate.enabled && idempotency !== undefined) {
        const inspection = await inTelemetrySpan(
          this.telemetry,
          "eyeball.execute.idempotency_preflight",
          { "eyeball.tool": tool.name },
          async () => this.store.inspectAllocation(allocationRequest),
          executionTrace.context,
        );
        if (inspection.kind !== "available") {
          allocation = inspection;
        }
      }

      let usageReport: UsageReportContext | undefined;
      let usageReservation: UsageReservationHandle | undefined;
      if (allocation === undefined && this.usageGate.enabled) {
        const cloudExecutionId =
          command.idempotencyKey === undefined ||
          command.executionId !== undefined
            ? pending.executionId
            : undefined;
        const usageIdempotencyKey = deriveUsageIdempotencyKey({
          projectId: command.projectId,
          executionId: pending.executionId,
          request: canonicalRequest,
          catalogVersion: this.catalog.catalogVersion,
          ...(command.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: command.idempotencyKey }),
        });
        let admission: UsageAdmission;
        try {
          admission = await inTelemetrySpan(
            this.telemetry,
            "eyeball.execute.usage_reserve",
            { "eyeball.tool": tool.name },
            async () =>
              this.usageGate.reserve({
                projectId: command.projectId,
                executionId: pending.executionId,
                idempotencyKey: usageIdempotencyKey,
                requestedAt: pending.createdAt,
                ...(cloudExecutionId === undefined ? {} : { cloudExecutionId }),
              }),
            executionTrace.context,
          );
        } catch (error) {
          if (error instanceof UsageGateUnavailableError) {
            throw new ExecutionRequestError(429, {
              code: TOOL_ERROR_CODES.RATE_LIMITED,
              message: error.message,
              retryable: true,
            });
          }
          throw error;
        }
        if (!admission.allowed) {
          if (idempotency !== undefined) {
            const lateInspection = await inTelemetrySpan(
              this.telemetry,
              "eyeball.execute.idempotency_preflight",
              { "eyeball.tool": tool.name },
              async () => this.store.inspectAllocation(allocationRequest),
              executionTrace.context,
            );
            if (lateInspection.kind !== "available") {
              allocation = lateInspection;
            }
          }
          if (allocation === undefined) {
            throw new ExecutionRequestError(429, {
              code: TOOL_ERROR_CODES.RATE_LIMITED,
              message: admission.message,
              retryable: false,
            });
          }
        } else {
          usageReport = admission.report;
          usageReservation = admission.reservation;
        }
      }

      const webhookEventId = deriveExecutionWebhookEventId(
        command.projectId,
        pending.executionId,
      );
      allocationRequest = {
        ...allocationRequest,
        recovery: {
          webhookEventId,
          resumeContext: {
            version: 1,
            tool: tool.name,
            toolVersion: tool.version,
            toolkitSlug: tool.toolkit,
            requiredScopes: [...requiredScopes],
            concurrencyBucketKey,
            ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
            ...(usageReport === undefined ? {} : { usageReport }),
            ...(usageReservation === undefined ? {} : { usageReservation }),
          },
        },
      };

      if (allocation === undefined) {
        try {
          allocation = await inTelemetrySpan(
            this.telemetry,
            "eyeball.execute.idempotency",
            {
              "eyeball.tool": tool.name,
              "eyeball.idempotency.present":
                command.idempotencyKey !== undefined,
            },
            async (_spanContext, span) => {
              const result = await this.store.allocate(allocationRequest);
              span?.setAttribute("eyeball.idempotency.result", result.kind);
              return result;
            },
            executionTrace.context,
          );
        } catch (error) {
          if (usageReservation !== undefined) {
            await this.usageGate.release(usageReservation);
          }
          throw error;
        }
      }
      if (allocation.kind === "conflict") {
        if (usageReservation !== undefined) {
          await this.usageGate.release(usageReservation);
        }
        return invalidRequest(
          "Idempotency-Key was already used with different request parameters.",
          409,
        );
      }
      executionTrace.span?.setAttribute(
        "eyeball.execution.id",
        allocation.record.executionId,
      );
      this.#logger.info("execution.received", {
        executionId: allocation.record.executionId,
        tool: tool.name,
        projectId: command.projectId,
        mode: canonicalRequest.mode,
        inputSizeBytes: jsonByteLength(canonicalRequest.input),
        inputSchemaValid: true,
        replayed: allocation.kind === "replay",
      });
      if (allocation.kind === "replay") {
        if (usageReservation !== undefined) {
          await this.usageGate.release(usageReservation);
        }
        syncPermit?.release();
        syncPermit = undefined;
        if (
          command.executionId !== undefined &&
          allocation.record.executionId !== command.executionId
        ) {
          return invalidRequest(
            "Reserved execution ID does not match the existing idempotent execution.",
            409,
          );
        }
        const replayRecord =
          canonicalRequest.mode === "sync" &&
          (allocation.record.status === "pending" ||
            allocation.record.status === "running")
            ? await this.store.waitForTerminal(
                command.projectId,
                allocation.record.executionId,
              )
            : allocation.record;
        if (
          replayRecord.status === "succeeded" ||
          replayRecord.status === "failed"
        ) {
          await this.#reconcileReplayedTerminal(
            command.projectId,
            replayRecord,
          );
        }
        if (
          canonicalRequest.mode === "async" &&
          (replayRecord.status === "pending" ||
            replayRecord.status === "running")
        ) {
          await this.#submitExecutionJob(
            command.projectId,
            replayRecord.executionId,
          );
        }
        return {
          outcome: {
            statusCode:
              replayRecord.status === "pending" ||
              replayRecord.status === "running"
                ? 202
                : 200,
            response: executeResponse(replayRecord),
            replayed: true,
          },
          deferred: false,
        };
      }

      if (canonicalRequest.mode === "async") {
        await this.#submitExecutionJob(
          command.projectId,
          allocation.record.executionId,
        );
        return {
          outcome: {
            statusCode: 202,
            response: executeResponse(allocation.record),
            replayed: false,
          },
          deferred: false,
        };
      }

      await this.#runAllocated(
        command.projectId,
        allocation.record,
        canonicalRequest,
        tool,
        manifest,
        requiredScopes,
        concurrencyBucketKey,
        concurrencyLimit,
        executionTrace,
        false,
        usageReport,
        usageReservation,
        webhookEventId,
        syncPermit,
      );
      syncPermit = undefined;
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
        outcome: {
          statusCode: 200,
          response: executeResponse(terminal),
          replayed: false,
        },
        deferred: false,
      };
    } finally {
      syncPermit?.release();
    }
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

  async getExecutionDetail(
    projectId: string,
    executionId: string,
  ): Promise<ExecutionDetailRecord> {
    if (!isExecutionId(executionId)) {
      throw new ExecutionRequestError(404, {
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message: "Execution was not found.",
      });
    }
    const execution = await this.store.getDetail(projectId, executionId);
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

  /** Runs or reconciles one ID-only execution job from durable store state. */
  async runExecutionJob(
    payload: Readonly<{ projectId: string; executionId: string }>,
    context: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    if (!isExecutionId(payload.executionId)) {
      return { type: "complete" };
    }
    let recoverable = await this.store.getRecoverable(
      payload.projectId,
      payload.executionId,
    );
    if (recoverable === undefined) {
      this.#logger.warn("execution.recovery_missing", {
        projectId: payload.projectId,
      });
      return { type: "complete" };
    }

    try {
      if (
        recoverable.record.status === "succeeded" ||
        recoverable.record.status === "failed"
      ) {
        await this.reconcileTerminalExecution({
          projectId: payload.projectId,
          record: recoverable.record,
          ...(recoverable.resumeContext?.usageReport === undefined
            ? {}
            : { usageReport: recoverable.resumeContext.usageReport }),
          ...(recoverable.resumeContext?.usageReservation === undefined
            ? {}
            : { usageReservation: recoverable.resumeContext.usageReservation }),
          ...(recoverable.webhookEventId === undefined
            ? {}
            : { webhookEventId: recoverable.webhookEventId }),
          dispatchMayHaveBegun:
            recoverable.record.status === "succeeded" ||
            recoverable.dispatchStartedAt !== undefined,
        });
        return { type: "complete" };
      }

      if (recoverable.resumeContext === undefined) {
        const webhookEventId =
          recoverable.webhookEventId ??
          deriveExecutionWebhookEventId(
            payload.projectId,
            recoverable.record.executionId,
          );
        if (recoverable.record.status === "running") {
          await this.failInterruptedExecution(
            recoverable,
            webhookEventId,
            true,
          );
          return { type: "complete" };
        }
        const reconstructed = this.#reconstructResumeContext(recoverable);
        if (reconstructed === undefined || this.usageGate.enabled) {
          await this.failInterruptedExecution(
            recoverable,
            webhookEventId,
            false,
          );
          return { type: "complete" };
        }
        await this.store.setResumeContext(
          payload.projectId,
          recoverable.record.executionId,
          { resumeContext: reconstructed, webhookEventId },
        );
        recoverable =
          (await this.store.getRecoverable(
            payload.projectId,
            recoverable.record.executionId,
          )) ?? recoverable;
      }

      if (
        recoverable.record.status === "running" &&
        recoverable.dispatchStartedAt !== undefined
      ) {
        await this.failInterruptedExecution(
          recoverable,
          recoverable.webhookEventId ??
            deriveExecutionWebhookEventId(
              payload.projectId,
              recoverable.record.executionId,
            ),
          true,
        );
        return { type: "complete" };
      }

      if (context.signal.aborted) {
        return {
          type: "reschedule",
          runAfter: new Date(Date.parse(context.now()) + 1_000).toISOString(),
        };
      }
      const resume = recoverable.resumeContext;
      if (resume === undefined) {
        return { type: "fail", errorCode: "invalid_job_version" };
      }
      if ((resume as { readonly version?: unknown }).version !== 1) {
        await this.failInterruptedExecution(
          recoverable,
          recoverable.webhookEventId ??
            deriveExecutionWebhookEventId(
              payload.projectId,
              recoverable.record.executionId,
            ),
          recoverable.dispatchStartedAt !== undefined,
        );
        return { type: "complete" };
      }
      const tool = this.catalog.getTool(resume.tool);
      const manifest = this.catalog.getManifest(resume.toolkitSlug);
      if (
        tool === undefined ||
        manifest === undefined ||
        tool.version !== resume.toolVersion ||
        tool.toolkit !== resume.toolkitSlug ||
        recoverable.record.toolVersion !== resume.toolVersion
      ) {
        await this.failInterruptedExecution(
          recoverable,
          recoverable.webhookEventId ??
            deriveExecutionWebhookEventId(
              payload.projectId,
              recoverable.record.executionId,
            ),
          false,
        );
        return { type: "complete" };
      }
      const executionTrace = startExecutionTrace(this.telemetry, {
        projectId: payload.projectId,
        request: recoverable.request,
      });
      if (
        recoverable.record.status !== "pending" &&
        recoverable.record.status !== "running"
      ) {
        return { type: "complete" };
      }
      try {
        await this.#runAllocated(
          payload.projectId,
          recoverable.record,
          recoverable.request,
          tool,
          manifest,
          resume.requiredScopes,
          resume.concurrencyBucketKey,
          resume.concurrencyLimit,
          executionTrace,
          true,
          resume.usageReport,
          resume.usageReservation,
          recoverable.webhookEventId,
        );
      } catch {
        const latest = await this.store.getRecoverable(
          payload.projectId,
          recoverable.record.executionId,
        );
        if (
          latest?.record.status === "succeeded" ||
          latest?.record.status === "failed"
        ) {
          await this.reconcileTerminalExecution({
            projectId: payload.projectId,
            record: latest.record,
            ...(latest.resumeContext?.usageReport === undefined
              ? {}
              : { usageReport: latest.resumeContext.usageReport }),
            ...(latest.resumeContext?.usageReservation === undefined
              ? {}
              : { usageReservation: latest.resumeContext.usageReservation }),
            ...(latest.webhookEventId === undefined
              ? {}
              : { webhookEventId: latest.webhookEventId }),
            dispatchMayHaveBegun:
              latest.record.status === "succeeded" ||
              latest.dispatchStartedAt !== undefined,
          });
          return { type: "complete" };
        }
        return {
          type: "reschedule",
          runAfter: new Date(Date.parse(context.now()) + 1_000).toISOString(),
        };
      }
      return { type: "complete" };
    } catch {
      return {
        type: "reschedule",
        runAfter: new Date(Date.parse(context.now()) + 1_000).toISOString(),
      };
    }
  }

  /** Reconciles usage and webhook terminal effects before queue acknowledgement. */
  async reconcileTerminalExecution(input: {
    readonly projectId: string;
    readonly record: ExecutionRecord & { status: "succeeded" | "failed" };
    readonly usageReport?: UsageReportContext;
    readonly usageReservation?: UsageReservationHandle;
    readonly webhookEventId?: string;
    readonly dispatchMayHaveBegun: boolean;
  }): Promise<void> {
    const stored = await this.store.getRecoverable(
      input.projectId,
      input.record.executionId,
    );
    if (stored?.usageFinalizedAt === undefined) {
      const usageReport =
        input.usageReport ??
        stored?.resumeContext?.usageReport ??
        (input.dispatchMayHaveBegun && input.usageReservation !== undefined
          ? {
              projectId: input.usageReservation.projectId,
              executionId: input.usageReservation.localExecutionId,
              idempotencyKey: input.usageReservation.idempotencyKey,
              reservationId: input.usageReservation.reservationId,
              ...(input.usageReservation.cloudExecutionId === undefined
                ? {}
                : {
                    cloudExecutionId: input.usageReservation.cloudExecutionId,
                  }),
              ...(input.usageReservation.reservedAt === undefined
                ? {}
                : { reservedAt: input.usageReservation.reservedAt }),
            }
          : undefined);
      const reservation =
        input.usageReservation ?? stored?.resumeContext?.usageReservation;
      if (input.dispatchMayHaveBegun && usageReport !== undefined) {
        await this.usageGate.reportTerminal({
          context: usageReport,
          record: input.record,
        });
      } else if (!input.dispatchMayHaveBegun && reservation !== undefined) {
        await this.usageGate.release(reservation);
      }
      await this.store.markUsageFinalized(
        input.projectId,
        input.record.executionId,
        this.#now().toISOString(),
      );
    }

    const eventId = input.webhookEventId ?? stored?.webhookEventId;
    if (eventId !== undefined && stored?.webhookPublishedAt === undefined) {
      await this.webhookDeliverer.enqueueExecution(
        input.projectId,
        input.record,
        eventId,
      );
      await this.store.markWebhookPublished(
        input.projectId,
        input.record.executionId,
        this.#now().toISOString(),
      );
    }
  }

  /** Fails ambiguous or unreconstructable work without replaying the provider. */
  async failInterruptedExecution(
    recoverable: RecoverableExecution,
    webhookEventId: string,
    dispatchMayHaveBegun: boolean,
  ): Promise<void> {
    await this.store.setWebhookEventId(
      recoverable.projectId,
      recoverable.record.executionId,
      webhookEventId,
    );
    const completedAt = this.#now();
    const startedAt =
      recoverable.record.status === "running"
        ? (recoverable.record.startedAt ?? recoverable.record.createdAt)
        : recoverable.record.createdAt;
    const terminal: ExecutionRecord & { status: "failed" } = {
      executionId: recoverable.record.executionId,
      tool: recoverable.record.tool,
      toolVersion: recoverable.record.toolVersion,
      catalogVersion: recoverable.record.catalogVersion,
      status: "failed",
      userId: recoverable.record.userId,
      createdAt: recoverable.record.createdAt,
      startedAt,
      completedAt: completedAt.toISOString(),
      error: {
        code: TOOL_ERROR_CODES.EXECUTION_INTERRUPTED,
        message: dispatchMayHaveBegun
          ? "Execution was interrupted after provider dispatch may have begun. Its external outcome is unknown and it was not replayed automatically."
          : "Execution could not be resumed safely after interruption and was not dispatched automatically.",
        retryable: false,
      },
      latencyMs: Math.max(0, completedAt.valueOf() - Date.parse(startedAt)),
    };
    await this.store.update(recoverable.projectId, terminal);
    await this.reconcileTerminalExecution({
      projectId: recoverable.projectId,
      record: terminal,
      ...(recoverable.resumeContext?.usageReport === undefined
        ? {}
        : { usageReport: recoverable.resumeContext.usageReport }),
      ...(recoverable.resumeContext?.usageReservation === undefined
        ? {}
        : { usageReservation: recoverable.resumeContext.usageReservation }),
      webhookEventId,
      dispatchMayHaveBegun,
    });
  }

  #reconstructResumeContext(
    recoverable: RecoverableExecution,
  ): ExecutionResumeContext | undefined {
    const tool = this.catalog.getTool(recoverable.record.tool);
    const manifest =
      tool === undefined ? undefined : this.catalog.getManifest(tool.toolkit);
    const scopes = this.catalog.getEffectiveScopes(recoverable.record.tool);
    if (
      tool === undefined ||
      manifest === undefined ||
      scopes === undefined ||
      tool.version !== recoverable.record.toolVersion
    ) {
      return undefined;
    }
    const concurrencyLimit = manifest.limits?.maxConcurrentExecutionsPerProject;
    return {
      version: 1,
      tool: tool.name,
      toolVersion: tool.version,
      toolkitSlug: tool.toolkit,
      requiredScopes: [...scopes.required],
      concurrencyBucketKey: `${recoverable.projectId}:${tool.toolkit}`,
      ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
    };
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

  async #submitExecutionJob(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<void> {
    const submission = this.queue.submit({
      kind: "execution.run.v1",
      payload: { projectId, executionId },
    });
    void submission.completed.catch(() => {
      this.#logger.error("queue.execution_job_failed", { executionId });
    });
    await submission.accepted;
  }

  async #reconcileReplayedTerminal(
    projectId: string,
    record: ExecutionRecord & { status: "succeeded" | "failed" },
  ): Promise<void> {
    const recoverable = await this.store.getRecoverable(
      projectId,
      record.executionId,
    );
    if (recoverable === undefined) return;
    await this.reconcileTerminalExecution({
      projectId,
      record,
      ...(recoverable.resumeContext?.usageReport === undefined
        ? {}
        : { usageReport: recoverable.resumeContext.usageReport }),
      ...(recoverable.resumeContext?.usageReservation === undefined
        ? {}
        : { usageReservation: recoverable.resumeContext.usageReservation }),
      ...(recoverable.webhookEventId === undefined
        ? {}
        : { webhookEventId: recoverable.webhookEventId }),
      dispatchMayHaveBegun:
        record.status === "succeeded" ||
        recoverable.dispatchStartedAt !== undefined,
    });
  }

  async #runAllocated(
    projectId: string,
    pending: Extract<ExecutionRecord, { status: "pending" | "running" }>,
    request: ExecuteRequest,
    tool: ToolDefinition,
    manifest: ProviderManifest,
    requiredScopes: readonly string[],
    concurrencyBucketKey: string,
    concurrencyLimit: number | undefined,
    executionTrace: ExecutionTrace,
    finishTrace: boolean,
    usageReport?: UsageReportContext,
    usageReservation?: UsageReservationHandle,
    webhookEventId?: string,
    reservedPermit?: ConcurrencyPermit,
  ): Promise<void> {
    let concurrencyPermit: ConcurrencyPermit | undefined;
    let dispatchAttempted = false;
    let dispatchFenced = false;
    let usageFinalized = false;
    let terminalPersisted = false;
    let terminalStatus: "succeeded" | "failed" | undefined;
    let terminalError: unknown;
    try {
      concurrencyPermit =
        reservedPermit ??
        (concurrencyLimit === undefined
          ? undefined
          : await this.toolkitConcurrencyLimiter.acquire(
              concurrencyBucketKey,
              concurrencyLimit,
            ));
      const startedAt =
        pending.status === "running"
          ? new Date(pending.startedAt ?? pending.createdAt)
          : this.#now();
      const startedAtIso = startedAt.toISOString();
      const running: ExecutionRecord & { status: "running" } =
        pending.status === "running"
          ? { ...pending, status: "running", startedAt: startedAtIso }
          : {
              executionId: pending.executionId,
              tool: pending.tool,
              toolVersion: pending.toolVersion,
              catalogVersion: pending.catalogVersion,
              status: "running",
              userId: pending.userId,
              createdAt: pending.createdAt,
              startedAt: startedAtIso,
            };
      if (pending.status === "pending") {
        await inTelemetrySpan(
          this.telemetry,
          "eyeball.execute.store",
          { "eyeball.store.operation": "mark_running" },
          async () => this.store.update(projectId, running),
          executionTrace.context,
        );
      }
      try {
        // Preserve the original execution boundary: a materialized toolkit with
        // no adapter is a deterministic runtime capability failure and must not
        // consult the credential provider.
        const adapter = this.adapters.require(tool.toolkit);
        let credential: ResolvedCredential;
        try {
          credential = await inTelemetrySpan(
            this.telemetry,
            "eyeball.execute.credentials",
            { "eyeball.toolkit": tool.toolkit },
            async (credentialContext) => {
              let resolved: ResolvedCredential;
              try {
                resolved = await this.credentialProvider.resolve({
                  projectId,
                  userId: request.userId,
                  toolkitSlug: tool.toolkit,
                  ...(request.connectionId === undefined
                    ? {}
                    : { connectionId: request.connectionId }),
                });
              } catch (error) {
                if (
                  error instanceof CredentialProviderError ||
                  error instanceof EyeballError
                ) {
                  throw error;
                }
                throw new UnexpectedCredentialProviderError(error);
              }
              await inTelemetrySpan(
                this.telemetry,
                "eyeball.execute.store",
                { "eyeball.store.operation": "set_connection" },
                async () =>
                  this.store.setResolvedConnection(
                    projectId,
                    pending.executionId,
                    resolved.connectionId,
                  ),
                credentialContext,
              );
              validateCredential(
                resolved,
                request,
                manifest,
                requiredScopes,
                this.#now(),
              );
              return resolved;
            },
            executionTrace.context,
          );
        } catch (error) {
          this.#logger.warn("credential.resolution_failed", {
            executionId: pending.executionId,
            tool: tool.name,
            projectId,
            kind: credentialFailureKind(error),
          });
          throw error;
        }
        this.#logger.info("execution.dispatched", {
          executionId: pending.executionId,
          tool: tool.name,
          projectId,
        });
        const output = await inTelemetrySpan(
          this.telemetry,
          "eyeball.execute.adapter-dispatch",
          {
            "eyeball.execution.id": pending.executionId,
            "eyeball.tool": tool.name,
            "eyeball.toolkit": tool.toolkit,
          },
          async (dispatchContext) => {
            const dispatchStartedAt = this.#now().toISOString();
            const marked = await this.store.markDispatchStarted(
              projectId,
              pending.executionId,
              dispatchStartedAt,
            );
            if (!marked) {
              dispatchFenced = true;
              throw new ExecutionDispatchFencedError();
            }
            dispatchAttempted = true;
            return adapter.execute({
              projectId,
              userId: request.userId,
              tool,
              canonicalInput: request.input,
              credential,
              baseUrl: resolveBaseUrl(manifest, this.#env),
              fetchImpl: this.#fetchImpl,
              clock: this.#clock,
              logger: this.#logger,
              ...(this.telemetry.tracer === undefined
                ? {}
                : {
                    telemetry: {
                      tracer: this.telemetry.tracer,
                      ...(dispatchContext === undefined
                        ? {}
                        : { context: dispatchContext }),
                    },
                  }),
              files: {
                resolve: async (fileId) => {
                  return this.getFile(projectId, fileId);
                },
              },
            });
          },
          executionTrace.context,
        );
        const canonicalOutput = await inTelemetrySpan(
          this.telemetry,
          "eyeball.execute.normalize",
          { "eyeball.tool": tool.name },
          async (_normalizeContext, span) => {
            try {
              const normalized = this.#validateOutput(tool, output);
              span?.setAttribute("eyeball.schema.valid", true);
              return normalized;
            } catch (error) {
              span?.setAttribute("eyeball.schema.valid", false);
              throw error;
            }
          },
          executionTrace.context,
        );
        const completedAt = this.#now();
        const terminal: ExecutionRecord & { status: "succeeded" } = {
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
        };
        await inTelemetrySpan(
          this.telemetry,
          "eyeball.execute.store",
          { "eyeball.store.operation": "mark_succeeded" },
          async () => this.store.update(projectId, terminal),
          executionTrace.context,
        );
        terminalPersisted = true;
        await this.reconcileTerminalExecution({
          projectId,
          record: terminal,
          ...(usageReport === undefined ? {} : { usageReport }),
          ...(usageReservation === undefined ? {} : { usageReservation }),
          ...(webhookEventId === undefined ? {} : { webhookEventId }),
          dispatchMayHaveBegun: true,
        });
        usageFinalized = true;
        terminalStatus = "succeeded";
        executionTrace.span?.setAttribute(
          "eyeball.execution.latency_ms",
          terminal.latencyMs,
        );
        this.telemetry.recordExecution(
          tool.name,
          terminal.status,
          terminal.latencyMs,
        );
        this.#logger.info("execution.terminal", {
          executionId: terminal.executionId,
          tool: tool.name,
          projectId,
          latencyMs: terminal.latencyMs,
          status: terminal.status,
          outputSizeBytes: jsonByteLength(canonicalOutput),
          outputSchemaValid: true,
        });
      } catch (error) {
        if (terminalPersisted || error instanceof ExecutionDispatchFencedError)
          throw error;
        terminalError = error;
        markSpanError(executionTrace.span, error);
        const completedAt = this.#now();
        const normalized = normalizedError(error);
        const terminal: ExecutionRecord & { status: "failed" } = {
          executionId: running.executionId,
          tool: running.tool,
          toolVersion: running.toolVersion,
          catalogVersion: running.catalogVersion,
          status: "failed",
          userId: running.userId,
          createdAt: running.createdAt,
          startedAt: startedAtIso,
          completedAt: completedAt.toISOString(),
          error: normalized,
          latencyMs: Math.max(0, completedAt.valueOf() - startedAt.valueOf()),
        };
        await inTelemetrySpan(
          this.telemetry,
          "eyeball.execute.store",
          { "eyeball.store.operation": "mark_failed" },
          async () => this.store.update(projectId, terminal),
          executionTrace.context,
        );
        await this.reconcileTerminalExecution({
          projectId,
          record: terminal,
          ...(usageReport === undefined ? {} : { usageReport }),
          ...(usageReservation === undefined ? {} : { usageReservation }),
          ...(webhookEventId === undefined ? {} : { webhookEventId }),
          dispatchMayHaveBegun: dispatchAttempted,
        });
        usageFinalized = true;
        terminalStatus = "failed";
        executionTrace.span?.setAttribute(
          "eyeball.execution.latency_ms",
          terminal.latencyMs,
        );
        this.telemetry.recordExecution(
          tool.name,
          terminal.status,
          terminal.latencyMs,
        );
        this.#logger.warn("execution.terminal", {
          executionId: terminal.executionId,
          tool: tool.name,
          projectId,
          latencyMs: terminal.latencyMs,
          status: terminal.status,
          errorKind: normalized.code,
        });
        if (error instanceof UnexpectedCredentialProviderError) throw error;
      }
    } catch (error) {
      terminalError ??= error;
      if (
        !dispatchAttempted &&
        !dispatchFenced &&
        !usageFinalized &&
        usageReservation !== undefined
      ) {
        await this.usageGate.release(usageReservation);
        usageFinalized = true;
      }
      throw error;
    } finally {
      concurrencyPermit?.release();
      if (finishTrace) {
        executionTrace.finish(terminalStatus ?? "failed", terminalError);
      }
    }
  }

  #validateOutput(tool: ToolDefinition, output: JsonValue): JsonValue {
    if (tool.outputSchema === undefined) {
      return output;
    }
    const validation = validateOutput(tool, output);
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
