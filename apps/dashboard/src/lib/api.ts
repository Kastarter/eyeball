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
  retryAfterSeconds?: number;
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
}

export type ExecutionRecord = ExecutionRecordBase &
  (
    | { status: "pending" | "running" }
    | { latencyMs: number; output: JsonValue; status: "succeeded" }
    | { error: NormalizedToolError; latencyMs: number; status: "failed" }
  );

export type ExecutionDetail = ExecutionRecord & {
  projectId: string;
  input: Readonly<Record<string, JsonValue>>;
  mode: "async" | "sync";
  connectionId?: string;
  idempotencyKey?: string;
};

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

export const DEFAULT_EXECUTOR_BASE_URL = "http://127.0.0.1:8787";
export const DASHBOARD_EXECUTOR_PROXY_BASE_URL = "/api/executor";

export class ExecutorClient {
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor({
    apiKey,
    baseUrl,
    fetch: fetchImpl = globalThis.fetch,
  }: ExecutorClientOptions) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("ExecutorClient requires a fetch implementation.");
    }
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetchImpl;
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
  ): Promise<ExecutionDetail> {
    return this.#request<ExecutionDetail>(
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

export function dashboardExecutorClient(): ExecutorClient {
  return new ExecutorClient({ baseUrl: DASHBOARD_EXECUTOR_PROXY_BASE_URL });
}
