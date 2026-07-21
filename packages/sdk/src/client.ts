import {
  CatalogToolSearchInputError,
  defaultCatalog,
  searchCatalogTools,
} from "@eyeball/catalog";
import {
  buildNameMap,
  type ConnectionId,
  type CreatedTriggerSubscription,
  type CreatedWebhookEndpoint,
  type ExecutionBase,
  type ExecutionRecord,
  type ExecutionResult,
  EyeballError,
  type FileId,
  fromRestrictedToolName,
  isCanonicalToolName,
  isTriggerSubscriptionId,
  isWebhookSubscriptionEventType,
  type JsonValue,
  type QualifiedToolName,
  type RotatedTriggerIngestSecret,
  type RotatedWebhookSecret,
  type StagedFileMetadata,
  type StagedFilePage,
  type StagedFileReference,
  TOOL_ERROR_CODES,
  type ToolDefinition,
  type TriggerDefinition,
  type TriggerSubscription,
  type TriggerSubscriptionPage,
  toAiSdkTools,
  toAnthropicTools,
  toMcpTools,
  toOpenAITools,
  type WebhookDeliveryPage,
  type WebhookEndpoint,
  type WebhookEndpointPage,
  type WebhookSubscriptionEventType,
} from "@eyeball/core";
import { EyeballHttpClient, errorFromNormalized } from "./http.js";
import type {
  ConnectedConnection,
  ConnectionPage,
  CreateConnectionOptions,
  CreateSubscriptionOptions,
  CreateWebhookEndpointOptions,
  ExecuteToolOptions,
  ExecutionPage,
  EyeballClock,
  EyeballOptions,
  EyeballSleep,
  EyeballToolFormat,
  GetToolsOptions,
  GetToolsResult,
  GetTriggersOptions,
  ListExecutionsOptions,
  ListFilesOptions,
  ListSubscriptionsOptions,
  ListWebhookDeliveriesOptions,
  ListWebhookEndpointsOptions,
  RevokedConnection,
  RunToolOptions,
  SearchToolsOptions,
  SearchToolsResult,
  UpdateWebhookEndpointOptions,
  UploadFileOptions,
  WaitForExecutionOptions,
} from "./types.js";

const DEFAULT_POLL_MS = 500;
const DEFAULT_TIMEOUT_MS = 60_000;

interface ClientContext {
  readonly http: EyeballHttpClient;
  readonly defaultUserId?: string;
  readonly clock: EyeballClock;
  readonly sleep: EyeballSleep;
}

type RunningExecuteResponse = Omit<ExecutionBase, "status"> & {
  status: "running";
};

function invalidInput(message: string, cause?: unknown): never {
  throw new EyeballError({
    code: TOOL_ERROR_CODES.INVALID_INPUT,
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

function effectiveUserId(
  explicit: string | undefined,
  defaultUserId: string | undefined,
): string {
  const userId = explicit ?? defaultUserId;
  if (userId === undefined || userId.trim().length === 0) {
    return invalidInput(
      "userId is required; pass it to this method or bind it in the Eyeball constructor.",
    );
  }
  return userId;
}

function canonicalToolName(name: string): QualifiedToolName {
  if (isCanonicalToolName(name)) {
    return name;
  }
  try {
    return fromRestrictedToolName(name);
  } catch (cause) {
    return invalidInput(
      `Unknown tool name ${JSON.stringify(name)}; use a canonical dotted or restricted wire name.`,
      cause,
    );
  }
}

function localTool(name: string): ToolDefinition | undefined {
  const canonical = canonicalToolName(name);
  return defaultCatalog.getTool(canonical);
}

function canonicalInput(input: unknown): Readonly<Record<string, JsonValue>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalidInput("Tool input must be a JSON object.");
  }
  return input as Readonly<Record<string, JsonValue>>;
}

function positiveMilliseconds(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    return invalidInput(`${name} must be a positive finite number.`);
  }
  return value;
}

function nonNegativeMilliseconds(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    return invalidInput(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function systemSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const systemClock: EyeballClock = { now: Date.now };

function base64Content(content: UploadFileOptions["content"]): string {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)),
    );
  }
  return btoa(binary);
}

function webhookEndpointId(value: string): string {
  if (value.trim().length === 0) {
    return invalidInput("endpointId must not be empty.");
  }
  return encodeURIComponent(value);
}

function webhookEvents(
  events: readonly WebhookSubscriptionEventType[],
): readonly WebhookSubscriptionEventType[] {
  if (
    events.length === 0 ||
    new Set(events).size !== events.length ||
    events.some((event) => !isWebhookSubscriptionEventType(event))
  ) {
    return invalidInput(
      "events must contain one or more distinct supported webhook event types.",
    );
  }
  return events;
}

function subscriptionId(value: string): string {
  if (!isTriggerSubscriptionId(value)) {
    return invalidInput("subscriptionId must be a valid trgsub_* identifier.");
  }
  return encodeURIComponent(value);
}

function pageSuffix(options: {
  cursor?: string;
  limit?: number;
  userId?: string;
}): string {
  const query = new URLSearchParams();
  if (options.userId !== undefined) {
    if (options.userId.trim().length === 0) {
      return invalidInput("userId must not be empty.");
    }
    query.set("userId", options.userId);
  }
  if (options.cursor !== undefined) {
    if (options.cursor.length === 0) {
      return invalidInput("cursor must not be empty.");
    }
    query.set("cursor", options.cursor);
  }
  if (options.limit !== undefined) {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    ) {
      return invalidInput("limit must be an integer from 1 through 100.");
    }
    query.set("limit", String(options.limit));
  }
  return query.size === 0 ? "" : `?${query.toString()}`;
}

function webhookPageSuffix(
  options: ListWebhookEndpointsOptions | ListWebhookDeliveriesOptions,
): string {
  return pageSuffix(options);
}

/** Project-scoped staging for file content referenced by later tool calls. */
export class FilesClient {
  readonly #context: ClientContext;

  constructor(context: ClientContext) {
    this.#context = context;
  }

  /**
   * Stages UTF-8 text or exact bytes and returns the attachment reference accepted by tools.
   *
   * @param options File name, optional media type, and content to stage.
   * @returns The stable reference to place in a canonical tool input.
   * @throws EyeballError when the upload is rejected or the executor cannot be reached.
   * @example
   * const attachment = await eyeball.files.upload({
   *   name: "invoice.pdf",
   *   mimeType: "application/pdf",
   *   content: invoiceBytes,
   * });
   */
  async upload(options: UploadFileOptions): Promise<StagedFileReference> {
    const metadata = await this.#context.http.request<StagedFileMetadata>(
      "/v1/files",
      {
        method: "POST",
        body: JSON.stringify({
          name: options.name,
          mimeType: options.mimeType ?? "application/octet-stream",
          content: base64Content(options.content),
        }),
      },
    );
    return {
      fileId: metadata.fileId,
      name: metadata.name,
      mimeType: metadata.mimeType,
    };
  }

  /**
   * Lists unexpired project staged-file metadata in newest-first order.
   *
   * @param options Opaque continuation cursor and a page size from 1 through 100; the executor defaults to 100.
   * @returns File metadata plus an optional cursor for the next page.
   * @throws EyeballError when options are invalid, the key lacks project authority, or the executor request fails.
   * @example
   * const first = await eyeball.files.list({ limit: 50 });
   * for (const file of first.files) console.log(file.name, file.expiresAt);
   * if (first.nextCursor !== undefined) {
   *   const next = await eyeball.files.list({
   *     cursor: first.nextCursor,
   *     limit: 50,
   *   });
   *   console.log(next.files.length);
   * }
   */
  async list(options: ListFilesOptions = {}): Promise<StagedFilePage> {
    return this.#context.http.request(`/v1/files${pageSuffix(options)}`);
  }

  /**
   * Retrieves metadata for a staged file without returning its bytes.
   *
   * @param fileId Project-scoped staged file identifier.
   * @returns The stored name, media type, size, and expiry.
   * @throws EyeballError when the file is unavailable or the executor request fails.
   */
  get(fileId: FileId): Promise<StagedFileMetadata> {
    return this.#context.http.request(
      `/v1/files/${encodeURIComponent(fileId)}`,
    );
  }
}

/** Read and poll the executor's project-scoped execution records. */
export class ExecutionsClient {
  readonly #context: ClientContext;

  constructor(context: ClientContext) {
    this.#context = context;
  }

  /**
   * Retrieves one execution record by identifier.
   *
   * @param executionId Execution identifier returned by `tools.execute`.
   * @returns The current durable execution record.
   * @throws EyeballError when the execution is unavailable or the request fails.
   */
  get(executionId: string): Promise<ExecutionRecord> {
    return this.#context.http.request(
      `/v1/executions/${encodeURIComponent(executionId)}`,
    );
  }

  /**
   * Lists execution history with optional status, tool, user, and cursor filters.
   *
   * @param options Filters and pagination for the project execution history.
   * @returns One execution page and an optional continuation cursor.
   * @throws EyeballError when a filter is invalid or the executor request fails.
   */
  list(options: ListExecutionsOptions = {}): Promise<ExecutionPage> {
    const query = new URLSearchParams();
    if (options.status !== undefined) {
      query.set("status", options.status);
    }
    if (options.tool !== undefined) {
      query.set("tool", canonicalToolName(options.tool));
    }
    const userId = options.userId ?? this.#context.defaultUserId;
    if (userId !== undefined) {
      if (userId.trim().length === 0) {
        return Promise.reject(
          new EyeballError({
            code: TOOL_ERROR_CODES.INVALID_INPUT,
            message: "userId must not be empty.",
          }),
        );
      }
      query.set("userId", userId);
    }
    if (options.cursor !== undefined) {
      query.set("cursor", options.cursor);
    }
    if (options.limit !== undefined) {
      query.set("limit", String(options.limit));
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return this.#context.http.request(`/v1/executions${suffix}`);
  }

  /**
   * Polls an execution until it succeeds or fails, bounded by a local deadline.
   *
   * @param executionId Execution identifier returned by `tools.execute`.
   * @param options Poll interval and total timeout in milliseconds.
   * @returns The terminal succeeded or failed execution record.
   * @throws EyeballError with `timeout` when the deadline expires, or the executor's normalized error for a failed request.
   * @throws Error When an injected polling clock returns a non-finite timestamp.
   * @example
   * const terminal = await eyeball.executions.wait(execution.executionId, {
   *   pollMs: 500,
   *   timeoutMs: 60_000,
   * });
   */
  async wait(
    executionId: string,
    options: WaitForExecutionOptions = {},
  ): Promise<ExecutionRecord & { status: "succeeded" | "failed" }> {
    const pollMs = positiveMilliseconds(
      options.pollMs ?? DEFAULT_POLL_MS,
      "pollMs",
    );
    const timeoutMs = nonNegativeMilliseconds(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    const startedAt = this.#now();

    while (true) {
      const execution = await this.get(executionId);
      if (execution.status === "succeeded" || execution.status === "failed") {
        return execution;
      }

      const elapsed = Math.max(0, this.#now() - startedAt);
      if (elapsed >= timeoutMs) {
        throw new EyeballError({
          code: TOOL_ERROR_CODES.TIMEOUT,
          message: `Execution ${executionId} did not reach a terminal state within ${timeoutMs}ms.`,
          retryable: false,
          executionId,
        });
      }
      await this.#context.sleep(Math.min(pollMs, timeoutMs - elapsed));
    }
  }

  #now(): number {
    const value = this.#context.clock.now();
    if (!Number.isFinite(value)) {
      throw new Error("Eyeball polling clock returned an invalid timestamp.");
    }
    return value;
  }
}

/** Local tool discovery and authenticated canonical execution. */
export class ToolsClient {
  readonly #context: ClientContext;
  readonly #executions: ExecutionsClient;

  constructor(context: ClientContext, executions: ExecutionsClient) {
    this.#context = context;
    this.#executions = executions;
  }

  /**
   * Searches and ranks the local open-core catalog without contacting the executor.
   *
   * @param options Search text, result limit, and optional local catalog filters.
   * @returns Canonical tool definitions ordered by relevance.
   * @throws EyeballError with `invalid_input` when the query or a filter is invalid.
   */
  async search(options: SearchToolsOptions): Promise<SearchToolsResult> {
    if (options.userId !== undefined && options.userId.trim().length === 0) {
      return invalidInput("userId must not be empty when provided.");
    }
    const toolkitSet =
      options.toolkits === undefined ? undefined : new Set(options.toolkits);
    if (
      toolkitSet !== undefined &&
      [...toolkitSet].some((toolkit) => toolkit.trim().length === 0)
    ) {
      return invalidInput("toolkits must not contain empty values.");
    }
    const candidates = defaultCatalog
      .listTools(
        options.capability === undefined
          ? {}
          : { capability: options.capability },
      )
      .filter(
        (tool) => toolkitSet === undefined || toolkitSet.has(tool.toolkit),
      );
    try {
      return {
        tools: Object.freeze(
          searchCatalogTools(candidates, {
            query: options.query,
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          }),
        ),
      };
    } catch (error) {
      if (error instanceof CatalogToolSearchInputError) {
        return invalidInput(error.message, error);
      }
      throw error;
    }
  }

  /**
   * Resolves and converts the open-core catalog locally without calling the executor.
   *
   * Hosted per-project enablement and catalog policy are eyeball-cloud concerns.
   *
   * @param options Toolkit and capability filters plus the requested model format.
   * @returns Converted tools, their canonical definitions, and the reversible name map.
   * @throws EyeballError with `invalid_input` when filters are invalid or AI SDK callbacks have no user binding.
   * @example
   * const bundle = await eyeball.tools.get({
   *   toolkits: ["gmail"],
   *   format: "anthropic",
   * });
   * console.log(bundle.tools, bundle.nameMap);
   */
  async get<Format extends EyeballToolFormat = "canonical">(
    options: GetToolsOptions<Format> = {},
  ): Promise<GetToolsResult<Format>> {
    const format = options.format ?? "canonical";
    const toolkitSet =
      options.toolkits === undefined ? undefined : new Set(options.toolkits);
    if (
      toolkitSet !== undefined &&
      [...toolkitSet].some((toolkit) => toolkit.trim().length === 0)
    ) {
      return invalidInput("toolkits must not contain empty values.");
    }
    const raw = Object.freeze(
      defaultCatalog
        .listTools(
          options.capability === undefined
            ? {}
            : { capability: options.capability },
        )
        .filter(
          (tool) => toolkitSet === undefined || toolkitSet.has(tool.toolkit),
        ),
    );
    const nameMap = buildNameMap(raw);

    let tools: GetToolsResult<EyeballToolFormat>["tools"];
    switch (format) {
      case "canonical":
        tools = raw;
        break;
      case "anthropic":
        tools = toAnthropicTools(raw).tools;
        break;
      case "openai":
        tools = toOpenAITools(raw).tools;
        break;
      case "mcp":
        tools = toMcpTools(
          raw,
          options.includeAsync === undefined
            ? {}
            : { includeAsync: options.includeAsync },
        ).tools;
        break;
      case "ai-sdk": {
        const boundUserId = effectiveUserId(
          options.userId,
          this.#context.defaultUserId,
        );
        tools = toAiSdkTools(raw, async (wireName, input) => {
          const canonicalName = nameMap.wireToCanonical[wireName];
          if (canonicalName === undefined) {
            return invalidInput(`Unknown converted tool name: ${wireName}.`);
          }
          return this.run(canonicalName, input, { userId: boundUserId });
        }).tools;
        break;
      }
    }

    return { tools, nameMap, raw } as GetToolsResult<Format>;
  }

  /**
   * Starts one canonical execution and returns its immediate execution envelope.
   *
   * Canonical dotted and restricted wire names are accepted. Mutations receive a generated
   * UUID idempotency key when one is not supplied; pass a stable key to correlate retries
   * across separate calls.
   *
   * @param toolName Canonical dotted name or restricted name emitted to a model.
   * @param options Canonical input, user binding, execution mode, and retry identity.
   * @returns A succeeded, failed, or pending execution result.
   * @throws EyeballError when local validation, transport, authentication, or executor admission fails.
   * @example
   * const execution = await eyeball.tools.execute("gmail.create_draft", {
   *   userId: "user_42",
   *   input: { to: ["guest@example.com"], subject: "Review", body: "Draft" },
   *   idempotencyKey: "draft:reservation:42",
   * });
   */
  async execute(
    toolName: string,
    options: ExecuteToolOptions,
  ): Promise<ExecutionResult> {
    const canonical = canonicalToolName(toolName);
    const tool = localTool(canonical);
    const userId = effectiveUserId(options.userId, this.#context.defaultUserId);
    const mode = options.mode ?? (tool?.annotations.async ? "async" : "sync");
    const idempotencyKey =
      options.idempotencyKey ??
      (tool?.annotations.readOnly === true
        ? undefined
        : globalThis.crypto.randomUUID());
    const headers = new Headers();
    if (idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", idempotencyKey);
    }

    const result = await this.#context.http.request<
      ExecutionResult | RunningExecuteResponse
    >("/v1/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({
        tool: canonical,
        userId,
        input: canonicalInput(options.input),
        mode,
        ...(options.connectionId === undefined
          ? {}
          : { connectionId: options.connectionId }),
      }),
    });

    // An idempotent retry can observe an already-running async execution. Core's
    // immediate ExecutionResult contract represents all non-terminal async work as
    // pending, while executions.get()/wait() expose the full running state.
    return result.status === "running"
      ? { ...result, status: "pending" }
      : result;
  }

  /**
   * Runs a model-selected tool to completion and returns only its canonical output.
   *
   * The exact canonical or restricted wire name emitted by a model is accepted. Async work
   * is polled through `executions.wait` before this method resolves.
   *
   * @param toolName Canonical dotted name or restricted name emitted to a model.
   * @param input Canonical JSON object for the selected tool.
   * @param options User, connection, execution, idempotency, and polling controls.
   * @returns The canonical tool output after successful completion.
   * @throws EyeballError for local validation, request failures, terminal tool errors, or polling timeout.
   * @example
   * const output = await eyeball.tools.run(
   *   "gmail.search_emails",
   *   { query: "reservation", pageSize: 5 },
   *   { userId: "user_42", timeoutMs: 30_000 },
   * );
   */
  async run(
    toolName: string,
    input: unknown,
    options: RunToolOptions = {},
  ): Promise<JsonValue> {
    const result = await this.execute(toolName, {
      input: canonicalInput(input),
      ...(options.userId === undefined ? {} : { userId: options.userId }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: options.idempotencyKey }),
      ...(options.connectionId === undefined
        ? {}
        : { connectionId: options.connectionId }),
    });
    if (result.status === "succeeded") {
      return result.output;
    }
    if (result.status === "failed") {
      throw errorFromNormalized(result.error);
    }

    const terminal = await this.#executions.wait(result.executionId, {
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
    if (terminal.status === "failed") {
      throw errorFromNormalized(terminal.error);
    }
    return terminal.output;
  }
}

/** User-scoped development connections exposed by the executor fixture API. */
export class ConnectionsClient {
  readonly #context: ClientContext;

  constructor(context: ClientContext) {
    this.#context = context;
  }

  /**
   * Creates a connected development fixture for one user and toolkit.
   *
   * Hosted OAuth authorization remains an eyeball Cloud boundary.
   *
   * @param options Toolkit slug and optional user override.
   * @returns The connected fixture identity with no redirect URL.
   * @throws EyeballError with `not_supported` when the executor has no connection route, or another normalized request error.
   */
  async create(options: CreateConnectionOptions): Promise<ConnectedConnection> {
    const userId = effectiveUserId(options.userId, this.#context.defaultUserId);
    if (options.toolkit.trim().length === 0) {
      return invalidInput("toolkit must not be empty.");
    }
    try {
      return await this.#context.http.request("/v1/connections", {
        method: "POST",
        body: JSON.stringify({ userId, toolkit: options.toolkit }),
      });
    } catch (error) {
      if (
        error instanceof EyeballError &&
        error.code === TOOL_ERROR_CODES.NOT_FOUND
      ) {
        throw new EyeballError({
          code: TOOL_ERROR_CODES.NOT_SUPPORTED,
          message:
            "not_implemented: connections.create is provided by the private eyeball-cloud Auth Vault; the OSS executor exposes only an opt-in dev-vault fixture route.",
          retryable: false,
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Lists development connections visible to the authenticated project.
   *
   * @returns One page containing all fixture connection summaries.
   * @throws EyeballError when the executor request fails.
   */
  list(): Promise<ConnectionPage> {
    return this.#context.http.request("/v1/connections");
  }

  /**
   * Revokes a development connection fixture.
   *
   * @param connectionId Project-scoped connection identifier.
   * @returns The revoked connection identity and status.
   * @throws EyeballError when the connection is unavailable or the request fails.
   */
  delete(connectionId: ConnectionId): Promise<RevokedConnection> {
    return this.#context.http.request(
      `/v1/connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
  }
}

/** Canonical trigger discovery from the local open-core catalog. */
export class TriggersClient {
  /**
   * Resolves trigger definitions from the packaged catalog without network I/O.
   *
   * @param options Toolkit, capability, and delivery-mode filters.
   * @returns Matching canonical trigger definitions in catalog order.
   * @throws EyeballError with `invalid_input` when a toolkit filter is empty.
   */
  async list(
    options: GetTriggersOptions = {},
  ): Promise<readonly TriggerDefinition[]> {
    const toolkitSet =
      options.toolkits === undefined ? undefined : new Set(options.toolkits);
    if (
      toolkitSet !== undefined &&
      [...toolkitSet].some((toolkit) => toolkit.trim().length === 0)
    ) {
      return invalidInput("toolkits must not contain empty values.");
    }
    const triggers = defaultCatalog
      .listTriggers({
        ...(options.capability === undefined
          ? {}
          : { capability: options.capability }),
        ...(options.deliveryMode === undefined
          ? {}
          : { deliveryMode: options.deliveryMode }),
      })
      .filter(
        (trigger) =>
          toolkitSet === undefined || toolkitSet.has(trigger.toolkit),
      );
    return Object.freeze(triggers);
  }
}

/** User-scoped push and polling trigger subscriptions. */
export class SubscriptionsClient {
  readonly #context: ClientContext;

  constructor(context: ClientContext) {
    this.#context = context;
  }

  /**
   * Creates a user-scoped push or polling trigger subscription.
   *
   * @param options Canonical trigger, destination webhooks, user, connection, and optional polling controls.
   * @returns The subscription plus a create-time ingest URL for push triggers when applicable.
   * @throws EyeballError when validation, authentication, or executor admission fails.
   * @example
   * const subscription = await eyeball.subscriptions.create({
   *   trigger: "slack.message_received",
   *   userId: "user_42",
   *   connectionId: "conn_slack",
   *   webhookEndpointIds: ["whe_events"],
   * });
   */
  create(
    options: CreateSubscriptionOptions,
  ): Promise<CreatedTriggerSubscription> {
    if (!isCanonicalToolName(options.trigger)) {
      return invalidInput("trigger must be a canonical dotted trigger name.");
    }
    const userId = effectiveUserId(options.userId, this.#context.defaultUserId);
    if (
      options.webhookEndpointIds.length === 0 ||
      new Set(options.webhookEndpointIds).size !==
        options.webhookEndpointIds.length ||
      options.webhookEndpointIds.some((endpointId) => endpointId.length === 0)
    ) {
      return invalidInput(
        "webhookEndpointIds must contain one or more distinct endpoint IDs.",
      );
    }
    if (
      options.pollIntervalSeconds !== undefined &&
      (!Number.isSafeInteger(options.pollIntervalSeconds) ||
        options.pollIntervalSeconds < 1)
    ) {
      return invalidInput("pollIntervalSeconds must be a positive integer.");
    }
    return this.#context.http.request("/v1/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        trigger: options.trigger,
        userId,
        ...(options.connectionId === undefined
          ? {}
          : { connectionId: options.connectionId }),
        webhookEndpointIds: options.webhookEndpointIds,
        ...(options.filters === undefined ? {} : { filters: options.filters }),
        ...(options.pollIntervalSeconds === undefined
          ? {}
          : { pollIntervalSeconds: options.pollIntervalSeconds }),
      }),
    });
  }

  /**
   * Lists trigger subscriptions with optional user and cursor filters.
   *
   * @param options User scope and pagination controls.
   * @returns One page of trigger subscriptions.
   * @throws EyeballError when a filter is invalid or the executor request fails.
   */
  list(
    options: ListSubscriptionsOptions = {},
  ): Promise<TriggerSubscriptionPage> {
    const userId = options.userId ?? this.#context.defaultUserId;
    return this.#context.http.request(
      `/v1/subscriptions${pageSuffix({
        ...(userId === undefined ? {} : { userId }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      })}`,
    );
  }

  /**
   * Retrieves one trigger subscription.
   *
   * @param value Valid `trgsub_*` subscription identifier.
   * @returns The current subscription record.
   * @throws EyeballError when the identifier is invalid, unavailable, or the request fails.
   */
  get(value: string): Promise<TriggerSubscription> {
    return this.#context.http.request(
      `/v1/subscriptions/${subscriptionId(value)}`,
    );
  }

  /**
   * Invalidates a push subscription's current ingest URL and returns its replacement once.
   *
   * @param value Valid `trgsub_*` subscription identifier.
   * @returns The replacement ingest URL and rotation timestamp.
   * @throws EyeballError for polling subscriptions or unavailable identifiers.
   */
  rotateSecret(value: string): Promise<RotatedTriggerIngestSecret> {
    return this.#context.http.request(
      `/v1/subscriptions/${subscriptionId(value)}/rotate-secret`,
      { method: "POST" },
    );
  }

  /**
   * Permanently removes one trigger subscription.
   *
   * @param value Valid `trgsub_*` subscription identifier.
   * @returns Nothing after the executor accepts the deletion.
   * @throws EyeballError when the identifier is invalid, unavailable, or the request fails.
   */
  delete(value: string): Promise<void> {
    return this.#context.http.request(
      `/v1/subscriptions/${subscriptionId(value)}`,
      { method: "DELETE" },
    );
  }
}

/** Project webhook endpoints, secret rotation, and delivery history. */
export class WebhooksClient {
  readonly #context: ClientContext;

  constructor(context: ClientContext) {
    this.#context = context;
  }

  /**
   * Creates a signed webhook endpoint and reveals its secret once.
   *
   * @param options HTTPS destination, subscribed event types, and initial active state.
   * @returns The endpoint record and create-time signing secret.
   * @throws EyeballError when validation, authentication, or executor admission fails.
   * @example
   * const endpoint = await eyeball.webhooks.create({
   *   url: "https://agent.example.com/eyeball",
   *   events: ["execution.completed", "trigger.slack.message_received"],
   * });
   * console.log(endpoint.secret);
   */
  create(
    options: CreateWebhookEndpointOptions,
  ): Promise<CreatedWebhookEndpoint> {
    if (options.url.trim().length === 0) {
      return invalidInput("url must not be empty.");
    }
    return this.#context.http.request("/v1/webhooks", {
      method: "POST",
      body: JSON.stringify({
        url: options.url,
        events: webhookEvents(options.events),
        ...(options.active === undefined ? {} : { active: options.active }),
      }),
    });
  }

  /**
   * Lists webhook endpoints with cursor pagination.
   *
   * @param options Cursor and page-size controls.
   * @returns One page of webhook endpoint records.
   * @throws EyeballError when pagination is invalid or the executor request fails.
   */
  list(
    options: ListWebhookEndpointsOptions = {},
  ): Promise<WebhookEndpointPage> {
    return this.#context.http.request(
      `/v1/webhooks${webhookPageSuffix(options)}`,
    );
  }

  /**
   * Retrieves one webhook endpoint without exposing its signing secret.
   *
   * @param endpointId Project-scoped webhook endpoint identifier.
   * @returns The current endpoint configuration.
   * @throws EyeballError when the identifier is invalid, unavailable, or the request fails.
   */
  get(endpointId: string): Promise<WebhookEndpoint> {
    return this.#context.http.request(
      `/v1/webhooks/${webhookEndpointId(endpointId)}`,
    );
  }

  /**
   * Updates at least one mutable webhook endpoint field.
   *
   * @param endpointId Project-scoped webhook endpoint identifier.
   * @param options New URL, event subscriptions, or active state.
   * @returns The updated endpoint record.
   * @throws EyeballError when no field changes, a value is invalid, or the executor request fails.
   */
  update(
    endpointId: string,
    options: UpdateWebhookEndpointOptions,
  ): Promise<WebhookEndpoint> {
    if (
      options.url === undefined &&
      options.events === undefined &&
      options.active === undefined
    ) {
      return invalidInput("Webhook update must change url, events, or active.");
    }
    if (options.url !== undefined && options.url.trim().length === 0) {
      return invalidInput("url must not be empty.");
    }
    return this.#context.http.request(
      `/v1/webhooks/${webhookEndpointId(endpointId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          ...(options.url === undefined ? {} : { url: options.url }),
          ...(options.events === undefined
            ? {}
            : { events: webhookEvents(options.events) }),
          ...(options.active === undefined ? {} : { active: options.active }),
        }),
      },
    );
  }

  /**
   * Invalidates the prior signing secret and reveals its replacement once.
   *
   * @param endpointId Project-scoped webhook endpoint identifier.
   * @returns The new secret, prefix, and rotation time.
   * @throws EyeballError when the endpoint is unavailable or the request fails.
   */
  rotateSecret(endpointId: string): Promise<RotatedWebhookSecret> {
    return this.#context.http.request(
      `/v1/webhooks/${webhookEndpointId(endpointId)}/rotate-secret`,
      { method: "POST" },
    );
  }

  /**
   * Lists delivery attempts for one webhook endpoint.
   *
   * @param endpointId Project-scoped webhook endpoint identifier.
   * @param options Cursor and page-size controls.
   * @returns One page of delivery records and their attempts.
   * @throws EyeballError when pagination is invalid or the executor request fails.
   */
  deliveries(
    endpointId: string,
    options: ListWebhookDeliveriesOptions = {},
  ): Promise<WebhookDeliveryPage> {
    return this.#context.http.request(
      `/v1/webhooks/${webhookEndpointId(endpointId)}/deliveries${webhookPageSuffix(
        options,
      )}`,
    );
  }

  /**
   * Permanently removes one webhook endpoint.
   *
   * @param endpointId Project-scoped webhook endpoint identifier.
   * @returns Nothing after the executor accepts the deletion.
   * @throws EyeballError when the endpoint is unavailable or the request fails.
   */
  delete(endpointId: string): Promise<void> {
    return this.#context.http.request(
      `/v1/webhooks/${webhookEndpointId(endpointId)}`,
      { method: "DELETE" },
    );
  }
}

/** Authenticated TypeScript entry point for every Eyeball SDK namespace. */
export class Eyeball {
  /** Local discovery and canonical tool execution. */
  readonly tools: ToolsClient;
  /** Execution history and terminal-state polling. */
  readonly executions: ExecutionsClient;
  /** Development connection fixture administration. */
  readonly connections: ConnectionsClient;
  /** Project-scoped staged file operations. */
  readonly files: FilesClient;
  /** Local canonical trigger discovery. */
  readonly triggers: TriggersClient;
  /** User-scoped trigger subscription operations. */
  readonly subscriptions: SubscriptionsClient;
  /** Signed webhook endpoint and delivery operations. */
  readonly webhooks: WebhooksClient;

  /**
   * Creates an SDK client bound to one executor and optional default user.
   *
   * @param options Project credential, executor URL, user binding, and optional test seams.
   * @throws TypeError When credentials, URL security, user identity, or fetch configuration is invalid.
   */
  constructor(options: EyeballOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError(
        "No fetch implementation is available; pass fetch in the Eyeball constructor.",
      );
    }
    if (options.userId !== undefined && options.userId.trim().length === 0) {
      throw new TypeError("userId must not be empty when provided.");
    }
    const sleep = options.sleep ?? systemSleep;
    const context: ClientContext = {
      http: new EyeballHttpClient({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        fetchImpl,
        sleep,
        ...(options.allowInsecureHttp === undefined
          ? {}
          : { allowInsecureHttp: options.allowInsecureHttp }),
      }),
      ...(options.userId === undefined
        ? {}
        : { defaultUserId: options.userId }),
      clock: options.clock ?? systemClock,
      sleep,
    };
    this.executions = new ExecutionsClient(context);
    this.tools = new ToolsClient(context, this.executions);
    this.connections = new ConnectionsClient(context);
    this.files = new FilesClient(context);
    this.triggers = new TriggersClient();
    this.subscriptions = new SubscriptionsClient(context);
    this.webhooks = new WebhooksClient(context);
  }
}
