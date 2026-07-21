import { EXECUTOR_PROJECT_HEADER } from "./executor-key-shared";

export type ExecutionStatus = "pending" | "running" | "succeeded" | "failed";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface NormalizedToolError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfter?: number;
  provider?: {
    toolkit: string;
    status?: number;
    code?: string;
    requestId?: string;
    detail?: JsonValue;
  };
}

export interface ExecutorErrorEnvelope {
  error: NormalizedToolError;
  requestId?: string;
}

interface ExecutionRecordBase {
  catalogVersion: string;
  createdAt: string;
  executionId: `exe_${string}`;
  tool: string;
  toolVersion: string;
  userId: string;
  startedAt?: string;
  completedAt?: string;
  replayed?: true;
  source?: {
    kind: "voice_session";
    sessionId: string;
  };
  attachments?: {
    count: number;
    fileIds: readonly string[];
  };
}

export type ExecutionRecord = ExecutionRecordBase &
  (
    | { status: "pending" | "running" }
    | { latencyMs: number; output: JsonValue; status: "succeeded" }
    | { error: NormalizedToolError; latencyMs: number; status: "failed" }
  );

export interface ExecutionPage {
  executions: readonly ExecutionRecord[];
  nextCursor?: string;
}

export interface ListExecutionsParams {
  cursor?: string;
  limit?: number;
  status?: ExecutionStatus;
  tool?: string;
  userId?: string;
}

export interface ExecutorHealth {
  service: "executor";
  status: "ok";
}

export type ConnectionStatus = "connected" | "expired" | "revoked";

export interface ConnectionRecord {
  connectionId: `conn_${string}`;
  createdAt: string;
  status: ConnectionStatus;
  toolkit: string;
  userId: string;
}

export interface ConnectionPage {
  connections: readonly ConnectionRecord[];
}

export interface CreateConnectionRequest {
  toolkit: string;
  userId: string;
}

export interface CreateConnectionResponse {
  connectionId: `conn_${string}`;
  redirectUrl: string | null;
  status: "connected";
}

export interface RevokeConnectionResponse {
  connectionId: `conn_${string}`;
  status: "revoked";
}

export type WebhookSubscriptionEventType =
  | "execution.completed"
  | "execution.succeeded"
  | "execution.failed"
  | "voice.session.event"
  | "voice.transcript.ready"
  | "voice.observer.failed"
  | "trigger.*"
  | `trigger.${string}.${string}`;

export interface WebhookEndpoint {
  endpointId: string;
  url: string;
  secretPrefix: string;
  events: readonly WebhookSubscriptionEventType[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedWebhookEndpoint extends WebhookEndpoint {
  secret: string;
}

export interface RotatedWebhookSecret {
  endpointId: string;
  secretPrefix: string;
  secret: string;
  rotatedAt: string;
}

export interface WebhookEndpointPage {
  webhooks: readonly WebhookEndpoint[];
  nextCursor?: string;
}

export interface CreateWebhookEndpointRequest {
  url: string;
  events: readonly WebhookSubscriptionEventType[];
  active: boolean;
}

export interface UpdateWebhookEndpointRequest {
  url?: string;
  events?: readonly WebhookSubscriptionEventType[];
  active?: boolean;
}

export type WebhookDeliveryStatus =
  | "pending"
  | "delivering"
  | "succeeded"
  | "failed";

export interface WebhookDeliveryAttempt {
  attempt: number;
  attemptedAt: string;
  completedAt: string;
  statusCode?: number;
  error?: string;
}

export interface WebhookDelivery {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: readonly WebhookDeliveryAttempt[];
  createdAt: string;
  nextRetryAt?: string;
  completedAt?: string;
}

export interface WebhookDeliveryPage {
  deliveries: readonly WebhookDelivery[];
  nextCursor?: string;
}

export interface ListWebhookEndpointsParams {
  cursor?: string;
  limit?: number;
}

export interface ListWebhookDeliveriesParams {
  cursor?: string;
  limit?: number;
}

export type TriggerSubscriptionStatus = "active" | "paused";

export interface TriggerSubscription {
  subscriptionId: string;
  userId: string;
  trigger: string;
  connectionId?: string;
  webhookEndpointIds: readonly string[];
  filters?: Readonly<Record<string, JsonValue>>;
  /** Polling triggers only; omitted for push subscriptions. */
  pollIntervalSeconds?: number;
  status: TriggerSubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

/** Push subscriptions reveal their unguessable ingest URL only in the create response. */
export interface CreatedTriggerSubscription extends TriggerSubscription {
  ingestUrl?: string;
}

/** Push ingest URL returned only when its secret is rotated. */
export interface RotatedTriggerIngestSecret {
  subscriptionId: string;
  ingestUrl: string;
  rotatedAt: string;
}

export interface TriggerSubscriptionPage {
  subscriptions: readonly TriggerSubscription[];
  nextCursor?: string;
}

export interface CreateTriggerSubscriptionRequest {
  trigger: string;
  userId: string;
  connectionId?: string;
  webhookEndpointIds: readonly string[];
  filters?: Readonly<Record<string, JsonValue>>;
  pollIntervalSeconds?: number;
}

export interface ListTriggerSubscriptionsParams {
  cursor?: string;
  limit?: number;
  userId?: string;
}

export interface StagedFileMetadata {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  expiresAt: string;
}

export interface StagedFilePage {
  files: readonly StagedFileMetadata[];
  nextCursor?: string;
}

export interface ListStagedFilesParams {
  cursor?: string;
  limit?: number;
}

export interface UploadStagedFileRequest {
  name: string;
  mimeType?: string;
  /** Padded standard base64 of the raw file bytes. */
  content: string;
}

export interface ExecuteToolRequest {
  connectionId?: `conn_${string}`;
  input: Readonly<Record<string, JsonValue>>;
  mode: "async" | "sync";
  tool: string;
  userId: string;
}

export interface ExecuteToolOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface DevVoiceSessionAdvanceResponse {
  sessionId: string;
  state:
    | "created"
    | "connecting"
    | "in-progress"
    | "wrap-up"
    | "completed"
    | "failed"
    | "abandoned";
  lastSequence: number;
  terminal: boolean;
  advancedByMs: number;
}

export type ExecuteToolResponse =
  | {
      catalogVersion: string;
      executionId: `exe_${string}`;
      status: "pending" | "running";
      tool: string;
      toolVersion: string;
    }
  | {
      catalogVersion: string;
      executionId: `exe_${string}`;
      latencyMs: number;
      output: JsonValue;
      status: "succeeded";
      tool: string;
      toolVersion: string;
    }
  | {
      catalogVersion: string;
      error: NormalizedToolError;
      executionId: `exe_${string}`;
      latencyMs: number;
      status: "failed";
      tool: string;
      toolVersion: string;
    };

export interface ExecutorClientOptions {
  apiKey?: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  projectId?: string;
}

export class ExecutorApiError extends Error {
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean | undefined;
  readonly status: number;

  constructor(
    message: string,
    status: number,
    details: {
      code?: string;
      requestId?: string;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "ExecutorApiError";
    this.code = details.code;
    this.requestId = details.requestId;
    this.retryable = details.retryable;
    this.status = status;
  }
}

function metadataRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExecutorApiError(
      `Executor returned invalid ${label} metadata.`,
      502,
    );
  }
  return value as Record<string, unknown>;
}

function metadataString(
  value: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const result = value[field];
  if (typeof result !== "string") {
    throw new ExecutorApiError(
      `Executor returned invalid ${label} metadata.`,
      502,
    );
  }
  return result;
}

function optionalMetadataString(
  value: Record<string, unknown>,
  field: string,
  label: string,
): string | undefined {
  const result = value[field];
  if (result === undefined) return undefined;
  if (typeof result !== "string") {
    throw new ExecutorApiError(
      `Executor returned invalid ${label} metadata.`,
      502,
    );
  }
  return result;
}

export function projectWebhookEndpoint(value: unknown): WebhookEndpoint {
  const endpoint = metadataRecord(value, "webhook endpoint");
  const events = endpoint.events;
  if (
    !Array.isArray(events) ||
    events.some((event) => typeof event !== "string") ||
    typeof endpoint.active !== "boolean"
  ) {
    throw new ExecutorApiError(
      "Executor returned invalid webhook endpoint metadata.",
      502,
    );
  }
  return {
    endpointId: metadataString(endpoint, "endpointId", "webhook endpoint"),
    url: metadataString(endpoint, "url", "webhook endpoint"),
    secretPrefix: metadataString(endpoint, "secretPrefix", "webhook endpoint"),
    events: events as WebhookSubscriptionEventType[],
    active: endpoint.active,
    createdAt: metadataString(endpoint, "createdAt", "webhook endpoint"),
    updatedAt: metadataString(endpoint, "updatedAt", "webhook endpoint"),
  };
}

function projectCreatedWebhookEndpoint(value: unknown): CreatedWebhookEndpoint {
  const record = metadataRecord(value, "created webhook endpoint");
  const endpoint = projectWebhookEndpoint(record);
  return {
    endpointId: endpoint.endpointId,
    url: endpoint.url,
    secretPrefix: endpoint.secretPrefix,
    events: endpoint.events,
    active: endpoint.active,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
    secret: metadataString(record, "secret", "created webhook endpoint"),
  };
}

function projectRotatedWebhookSecret(value: unknown): RotatedWebhookSecret {
  const rotated = metadataRecord(value, "rotated webhook secret");
  return {
    endpointId: metadataString(rotated, "endpointId", "rotated webhook secret"),
    secretPrefix: metadataString(
      rotated,
      "secretPrefix",
      "rotated webhook secret",
    ),
    secret: metadataString(rotated, "secret", "rotated webhook secret"),
    rotatedAt: metadataString(rotated, "rotatedAt", "rotated webhook secret"),
  };
}

function projectWebhookDeliveryAttempt(value: unknown): WebhookDeliveryAttempt {
  const attempt = metadataRecord(value, "webhook delivery attempt");
  if (typeof attempt.attempt !== "number") {
    throw new ExecutorApiError(
      "Executor returned invalid webhook delivery attempt metadata.",
      502,
    );
  }
  const statusCode = attempt.statusCode;
  if (statusCode !== undefined && typeof statusCode !== "number") {
    throw new ExecutorApiError(
      "Executor returned invalid webhook delivery attempt metadata.",
      502,
    );
  }
  const error = optionalMetadataString(
    attempt,
    "error",
    "webhook delivery attempt",
  );
  return {
    attempt: attempt.attempt,
    attemptedAt: metadataString(
      attempt,
      "attemptedAt",
      "webhook delivery attempt",
    ),
    completedAt: metadataString(
      attempt,
      "completedAt",
      "webhook delivery attempt",
    ),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(error === undefined ? {} : { error }),
  };
}

export function projectWebhookDelivery(value: unknown): WebhookDelivery {
  const delivery = metadataRecord(value, "webhook delivery");
  const attempts = delivery.attempts;
  if (
    !Array.isArray(attempts) ||
    (delivery.status !== "pending" &&
      delivery.status !== "delivering" &&
      delivery.status !== "succeeded" &&
      delivery.status !== "failed")
  ) {
    throw new ExecutorApiError(
      "Executor returned invalid webhook delivery metadata.",
      502,
    );
  }
  const nextRetryAt = optionalMetadataString(
    delivery,
    "nextRetryAt",
    "webhook delivery",
  );
  const completedAt = optionalMetadataString(
    delivery,
    "completedAt",
    "webhook delivery",
  );
  return {
    deliveryId: metadataString(delivery, "deliveryId", "webhook delivery"),
    endpointId: metadataString(delivery, "endpointId", "webhook delivery"),
    eventId: metadataString(delivery, "eventId", "webhook delivery"),
    eventType: metadataString(delivery, "eventType", "webhook delivery"),
    status: delivery.status,
    attempts: attempts.map(projectWebhookDeliveryAttempt),
    createdAt: metadataString(delivery, "createdAt", "webhook delivery"),
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

export function projectWebhookEndpointPage(
  value: unknown,
): WebhookEndpointPage {
  const page = metadataRecord(value, "webhook endpoint page");
  if (!Array.isArray(page.webhooks)) {
    throw new ExecutorApiError(
      "Executor returned invalid webhook endpoint page metadata.",
      502,
    );
  }
  const nextCursor = optionalMetadataString(
    page,
    "nextCursor",
    "webhook endpoint page",
  );
  return {
    webhooks: page.webhooks.map(projectWebhookEndpoint),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function projectWebhookDeliveryPage(
  value: unknown,
): WebhookDeliveryPage {
  const page = metadataRecord(value, "webhook delivery page");
  if (!Array.isArray(page.deliveries)) {
    throw new ExecutorApiError(
      "Executor returned invalid webhook delivery page metadata.",
      502,
    );
  }
  const nextCursor = optionalMetadataString(
    page,
    "nextCursor",
    "webhook delivery page",
  );
  return {
    deliveries: page.deliveries.map(projectWebhookDelivery),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function projectTriggerSubscription(
  value: unknown,
): TriggerSubscription {
  const subscription = metadataRecord(value, "trigger subscription");
  const endpointIds = subscription.webhookEndpointIds;
  if (
    !Array.isArray(endpointIds) ||
    endpointIds.some((endpointId) => typeof endpointId !== "string") ||
    (subscription.status !== "active" && subscription.status !== "paused")
  ) {
    throw new ExecutorApiError(
      "Executor returned invalid trigger subscription metadata.",
      502,
    );
  }
  const connectionId = optionalMetadataString(
    subscription,
    "connectionId",
    "trigger subscription",
  );
  const filters = subscription.filters;
  if (
    filters !== undefined &&
    (typeof filters !== "object" || filters === null || Array.isArray(filters))
  ) {
    throw new ExecutorApiError(
      "Executor returned invalid trigger subscription metadata.",
      502,
    );
  }
  const pollIntervalSeconds = subscription.pollIntervalSeconds;
  if (
    pollIntervalSeconds !== undefined &&
    typeof pollIntervalSeconds !== "number"
  ) {
    throw new ExecutorApiError(
      "Executor returned invalid trigger subscription metadata.",
      502,
    );
  }
  return {
    subscriptionId: metadataString(
      subscription,
      "subscriptionId",
      "trigger subscription",
    ),
    userId: metadataString(subscription, "userId", "trigger subscription"),
    trigger: metadataString(subscription, "trigger", "trigger subscription"),
    ...(connectionId === undefined ? {} : { connectionId }),
    webhookEndpointIds: endpointIds as string[],
    ...(filters === undefined
      ? {}
      : { filters: filters as Readonly<Record<string, JsonValue>> }),
    ...(pollIntervalSeconds === undefined ? {} : { pollIntervalSeconds }),
    status: subscription.status,
    createdAt: metadataString(
      subscription,
      "createdAt",
      "trigger subscription",
    ),
    updatedAt: metadataString(
      subscription,
      "updatedAt",
      "trigger subscription",
    ),
  };
}

function projectCreatedTriggerSubscription(
  value: unknown,
): CreatedTriggerSubscription {
  const record = metadataRecord(value, "created trigger subscription");
  const subscription = projectTriggerSubscription(record);
  const ingestUrl = optionalMetadataString(
    record,
    "ingestUrl",
    "created trigger subscription",
  );
  return {
    ...subscription,
    ...(ingestUrl === undefined ? {} : { ingestUrl }),
  };
}

function projectRotatedTriggerIngestSecret(
  value: unknown,
): RotatedTriggerIngestSecret {
  const rotated = metadataRecord(value, "rotated trigger ingest secret");
  return {
    subscriptionId: metadataString(
      rotated,
      "subscriptionId",
      "rotated trigger ingest secret",
    ),
    ingestUrl: metadataString(
      rotated,
      "ingestUrl",
      "rotated trigger ingest secret",
    ),
    rotatedAt: metadataString(
      rotated,
      "rotatedAt",
      "rotated trigger ingest secret",
    ),
  };
}

export function projectTriggerSubscriptionPage(
  value: unknown,
): TriggerSubscriptionPage {
  const page = metadataRecord(value, "trigger subscription page");
  if (!Array.isArray(page.subscriptions)) {
    throw new ExecutorApiError(
      "Executor returned invalid trigger subscription page metadata.",
      502,
    );
  }
  const nextCursor = optionalMetadataString(
    page,
    "nextCursor",
    "trigger subscription page",
  );
  return {
    subscriptions: page.subscriptions.map(projectTriggerSubscription),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function projectStagedFileMetadata(value: unknown): StagedFileMetadata {
  const file = metadataRecord(value, "staged file");
  if (typeof file.size !== "number") {
    throw new ExecutorApiError(
      "Executor returned invalid staged file metadata.",
      502,
    );
  }
  return {
    fileId: metadataString(file, "fileId", "staged file"),
    name: metadataString(file, "name", "staged file"),
    mimeType: metadataString(file, "mimeType", "staged file"),
    size: file.size,
    expiresAt: metadataString(file, "expiresAt", "staged file"),
  };
}

export function projectStagedFilePage(value: unknown): StagedFilePage {
  const page = metadataRecord(value, "staged file page");
  if (!Array.isArray(page.files)) {
    throw new ExecutorApiError(
      "Executor returned invalid staged file page metadata.",
      502,
    );
  }
  const nextCursor = optionalMetadataString(
    page,
    "nextCursor",
    "staged file page",
  );
  return {
    files: page.files.map(projectStagedFileMetadata),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export const DEFAULT_EXECUTOR_BASE_URL = "http://127.0.0.1:8787";
export const DASHBOARD_EXECUTOR_PROXY_BASE_URL = "/api/executor";

export class ExecutorClient {
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #projectId: string | undefined;

  constructor({
    apiKey,
    baseUrl,
    fetch: fetchImpl = globalThis.fetch,
    projectId,
  }: ExecutorClientOptions) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("ExecutorClient requires a fetch implementation.");
    }
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    // Browsers require fetch to be invoked with the global as `this`;
    // storing it on a class field otherwise throws "Illegal invocation".
    this.#fetch =
      fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
    this.#projectId = projectId;
  }

  async health(signal?: AbortSignal): Promise<ExecutorHealth> {
    const value = await this.#request<unknown>(
      "/health",
      signal === undefined ? {} : { signal },
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("status" in value) ||
      !("service" in value) ||
      value.status !== "ok" ||
      value.service !== "executor"
    ) {
      throw new ExecutorApiError(
        "Executor returned an invalid health response.",
        502,
      );
    }
    return value as ExecutorHealth;
  }

  listExecutions(
    params: ListExecutionsParams = {},
    signal?: AbortSignal,
  ): Promise<ExecutionPage> {
    const query = new URLSearchParams();
    if (params.cursor !== undefined) query.set("cursor", params.cursor);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.status !== undefined) query.set("status", params.status);
    if (params.tool !== undefined) query.set("tool", params.tool);
    if (params.userId !== undefined) query.set("userId", params.userId);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.#request<ExecutionPage>(
      `/v1/executions${suffix}`,
      signal === undefined ? {} : { signal },
    );
  }

  getExecution(
    executionId: string,
    signal?: AbortSignal,
  ): Promise<ExecutionRecord> {
    return this.#request<ExecutionRecord>(
      `/v1/executions/${encodeURIComponent(executionId)}`,
      signal === undefined ? {} : { signal },
    );
  }

  listConnections(signal?: AbortSignal): Promise<ConnectionPage> {
    return this.#request<ConnectionPage>(
      "/v1/connections",
      signal === undefined ? {} : { signal },
    );
  }

  createConnection(
    request: CreateConnectionRequest,
    signal?: AbortSignal,
  ): Promise<CreateConnectionResponse> {
    return this.#request<CreateConnectionResponse>("/v1/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  revokeConnection(
    connectionId: string,
    signal?: AbortSignal,
  ): Promise<RevokeConnectionResponse> {
    return this.#request<RevokeConnectionResponse>(
      `/v1/connections/${encodeURIComponent(connectionId)}`,
      {
        method: "DELETE",
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async listWebhookEndpoints(
    params: ListWebhookEndpointsParams = {},
    signal?: AbortSignal,
  ): Promise<WebhookEndpointPage> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor !== undefined) query.set("cursor", params.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const value = await this.#request<unknown>(`/v1/webhooks${suffix}`, {
      ...(signal === undefined ? {} : { signal }),
    });
    return projectWebhookEndpointPage(value);
  }

  async createWebhookEndpoint(
    request: CreateWebhookEndpointRequest,
    signal?: AbortSignal,
  ): Promise<CreatedWebhookEndpoint> {
    const value = await this.#request<unknown>("/v1/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    });
    return projectCreatedWebhookEndpoint(value);
  }

  async getWebhookEndpoint(
    endpointId: string,
    signal?: AbortSignal,
  ): Promise<WebhookEndpoint> {
    const value = await this.#request<unknown>(
      `/v1/webhooks/${encodeURIComponent(endpointId)}`,
      signal === undefined ? {} : { signal },
    );
    return projectWebhookEndpoint(value);
  }

  async updateWebhookEndpoint(
    endpointId: string,
    request: UpdateWebhookEndpointRequest,
    signal?: AbortSignal,
  ): Promise<WebhookEndpoint> {
    const value = await this.#request<unknown>(
      `/v1/webhooks/${encodeURIComponent(endpointId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return projectWebhookEndpoint(value);
  }

  async rotateWebhookSecret(
    endpointId: string,
    signal?: AbortSignal,
  ): Promise<RotatedWebhookSecret> {
    const value = await this.#request<unknown>(
      `/v1/webhooks/${encodeURIComponent(endpointId)}/rotate-secret`,
      {
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return projectRotatedWebhookSecret(value);
  }

  async listWebhookDeliveries(
    endpointId: string,
    params: ListWebhookDeliveriesParams = {},
    signal?: AbortSignal,
  ): Promise<WebhookDeliveryPage> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor !== undefined) query.set("cursor", params.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const value = await this.#request<unknown>(
      `/v1/webhooks/${encodeURIComponent(endpointId)}/deliveries${suffix}`,
      signal === undefined ? {} : { signal },
    );
    return projectWebhookDeliveryPage(value);
  }

  async deleteWebhookEndpoint(
    endpointId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#request<void>(
      `/v1/webhooks/${encodeURIComponent(endpointId)}`,
      {
        method: "DELETE",
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async listTriggerSubscriptions(
    params: ListTriggerSubscriptionsParams = {},
    signal?: AbortSignal,
  ): Promise<TriggerSubscriptionPage> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor !== undefined) query.set("cursor", params.cursor);
    if (params.userId !== undefined) query.set("userId", params.userId);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const value = await this.#request<unknown>(`/v1/subscriptions${suffix}`, {
      ...(signal === undefined ? {} : { signal }),
    });
    return projectTriggerSubscriptionPage(value);
  }

  async createTriggerSubscription(
    request: CreateTriggerSubscriptionRequest,
    signal?: AbortSignal,
  ): Promise<CreatedTriggerSubscription> {
    const value = await this.#request<unknown>("/v1/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    });
    return projectCreatedTriggerSubscription(value);
  }

  async getTriggerSubscription(
    subscriptionId: string,
    signal?: AbortSignal,
  ): Promise<TriggerSubscription> {
    const value = await this.#request<unknown>(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      signal === undefined ? {} : { signal },
    );
    return projectTriggerSubscription(value);
  }

  async rotateTriggerIngestSecret(
    subscriptionId: string,
    signal?: AbortSignal,
  ): Promise<RotatedTriggerIngestSecret> {
    const value = await this.#request<unknown>(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/rotate-secret`,
      {
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return projectRotatedTriggerIngestSecret(value);
  }

  async deleteTriggerSubscription(
    subscriptionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#request<void>(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        method: "DELETE",
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async listStagedFiles(
    params: ListStagedFilesParams = {},
    signal?: AbortSignal,
  ): Promise<StagedFilePage> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor !== undefined) query.set("cursor", params.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const value = await this.#request<unknown>(`/v1/files${suffix}`, {
      ...(signal === undefined ? {} : { signal }),
    });
    return projectStagedFilePage(value);
  }

  async uploadStagedFile(
    request: UploadStagedFileRequest,
    signal?: AbortSignal,
  ): Promise<StagedFileMetadata> {
    const value = await this.#request<unknown>("/v1/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    });
    return projectStagedFileMetadata(value);
  }

  execute(
    request: ExecuteToolRequest,
    options: ExecuteToolOptions = {},
  ): Promise<ExecuteToolResponse> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (options.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", options.idempotencyKey);
    }
    return this.#request<ExecuteToolResponse>("/v1/execute", {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  advanceVoiceSession(
    sessionId: string,
    request: { userId: string; milliseconds?: number; end?: boolean },
    signal?: AbortSignal,
  ): Promise<DevVoiceSessionAdvanceResponse> {
    return this.#request<DevVoiceSessionAdvanceResponse>(
      `/v1/dev/voice-sessions/${encodeURIComponent(sessionId)}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (this.#projectId !== undefined) {
      headers.set(EXECUTOR_PROJECT_HEADER, this.#projectId);
    }
    if (this.#apiKey !== undefined) {
      headers.set("Authorization", `Bearer ${this.#apiKey}`);
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = undefined;
    }
    if (!response.ok) {
      const envelope = errorEnvelope(value);
      throw new ExecutorApiError(
        envelope?.error.message ??
          `Executor request failed with HTTP ${response.status}.`,
        response.status,
        envelope === undefined
          ? {}
          : {
              code: envelope.error.code,
              retryable: envelope.error.retryable,
              ...(envelope.requestId === undefined
                ? {}
                : { requestId: envelope.requestId }),
            },
      );
    }
    return value as T;
  }
}

function errorEnvelope(value: unknown): ExecutorErrorEnvelope | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return undefined;
  }
  const error = value.error;
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    !("message" in error) ||
    !("retryable" in error) ||
    typeof error.code !== "string" ||
    typeof error.message !== "string" ||
    typeof error.retryable !== "boolean"
  ) {
    return undefined;
  }
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
    ...("requestId" in value && typeof value.requestId === "string"
      ? { requestId: value.requestId }
      : {}),
  };
}

export function configuredExecutorBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_EYEBALL_EXECUTOR_URL ?? DEFAULT_EXECUTOR_BASE_URL
  );
}

export function dashboardProjectIdFromPathname(
  pathname: string,
): string | undefined {
  const segment = pathname.split("/").filter(Boolean)[0];
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export function dashboardExecutorClient(projectId?: string): ExecutorClient {
  const selectedProjectId =
    projectId ??
    (typeof window === "undefined"
      ? undefined
      : dashboardProjectIdFromPathname(window.location.pathname));
  return new ExecutorClient({
    baseUrl: DASHBOARD_EXECUTOR_PROXY_BASE_URL,
    ...(selectedProjectId === undefined
      ? {}
      : { projectId: selectedProjectId }),
  });
}
