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

export interface ExecutorClientOptions {
  apiKey?: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export class ExecutorApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ExecutorApiError";
    this.status = status;
  }
}

export const DEFAULT_EXECUTOR_BASE_URL = "http://127.0.0.1:8787";

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
    if (!response.ok) {
      throw new ExecutorApiError(
        `Executor request failed with HTTP ${response.status}.`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }
}

export function configuredExecutorBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_EYEBALL_EXECUTOR_URL ?? DEFAULT_EXECUTOR_BASE_URL
  );
}
