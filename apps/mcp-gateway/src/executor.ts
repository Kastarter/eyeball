import type {
  CancelledExecutionRecord,
  ConnectionId,
  ExecutionId,
  ExecutionRecord,
  ExecutionResult,
  FailedExecutionRecord,
  JsonValue,
  QualifiedToolName,
  SucceededExecutionRecord,
  TerminalExecutionRecord,
} from "@eyeball/core";
import { Eyeball } from "@eyeball/sdk";

export type TerminalExecution =
  | Extract<ExecutionResult, { status: "succeeded" | "failed" | "cancelled" }>
  | TerminalExecutionRecord;

export type McpCancellationOutcome =
  | {
      readonly kind: "cancelled";
      readonly execution: CancelledExecutionRecord;
    }
  | {
      readonly kind: "already_terminal";
      readonly execution: SucceededExecutionRecord | FailedExecutionRecord;
    };

export interface McpExecuteRequest {
  apiKey: string;
  userId: string;
  tool: QualifiedToolName;
  input: Readonly<Record<string, JsonValue>>;
  idempotencyKey: string;
  connectionId?: ConnectionId;
  /** Executor dispatch mode; async-by-nature tools must run as "async". */
  mode?: "sync" | "async";
}

export interface McpExecutionRequest {
  apiKey: string;
  executionId: ExecutionId;
}

export interface McpExecutor {
  execute(request: McpExecuteRequest): Promise<TerminalExecution>;
  /** Allocate task-backed work without waiting for a terminal result. */
  start?(request: McpExecuteRequest): Promise<ExecutionResult>;
  /** Read task-backed work from the executor's project-scoped execution store. */
  get?(request: McpExecutionRequest): Promise<ExecutionRecord>;
  /** Cancel task-backed work and return the authoritative terminal disposition. */
  cancel?(request: McpExecutionRequest): Promise<McpCancellationOutcome>;
}

export interface HttpMcpExecutorOptions {
  baseUrl: string;
  fetchImpl?: typeof globalThis.fetch;
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Thin MCP-to-SDK bridge. The SDK owns executor HTTP envelopes and polling while this
 * class preserves the terminal execution record needed for MCP result metadata.
 */
export class HttpMcpExecutor implements McpExecutor {
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof globalThis.fetch | undefined;
  readonly #pollMs: number | undefined;
  readonly #timeoutMs: number | undefined;

  constructor(options: HttpMcpExecutorOptions) {
    this.#baseUrl = options.baseUrl;
    this.#fetchImpl = options.fetchImpl;
    this.#pollMs = options.pollMs;
    this.#timeoutMs = options.timeoutMs;
  }

  async execute(request: McpExecuteRequest): Promise<TerminalExecution> {
    const client = this.#client(request.apiKey, request.userId);
    const immediate = await client.tools.execute(request.tool, {
      input: request.input,
      mode: request.mode ?? "sync",
      idempotencyKey: request.idempotencyKey,
      ...(request.connectionId === undefined
        ? {}
        : { connectionId: request.connectionId }),
    });
    if (immediate.status !== "pending") {
      return immediate;
    }

    return client.executions.wait(immediate.executionId, {
      ...(this.#pollMs === undefined ? {} : { pollMs: this.#pollMs }),
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
    });
  }

  start(request: McpExecuteRequest): Promise<ExecutionResult> {
    return this.#client(request.apiKey, request.userId).tools.execute(
      request.tool,
      {
        input: request.input,
        mode: "async",
        idempotencyKey: request.idempotencyKey,
        ...(request.connectionId === undefined
          ? {}
          : { connectionId: request.connectionId }),
      },
    );
  }

  get(request: McpExecutionRequest): Promise<ExecutionRecord> {
    return this.#client(request.apiKey).executions.get(request.executionId);
  }

  async cancel(request: McpExecutionRequest): Promise<McpCancellationOutcome> {
    const client = this.#client(request.apiKey);
    try {
      return {
        kind: "cancelled",
        execution: await client.executions.cancel(request.executionId),
      };
    } catch (error) {
      try {
        const execution = await client.executions.get(request.executionId);
        if (execution.status === "cancelled") {
          return { kind: "cancelled", execution };
        }
        if (execution.status === "succeeded" || execution.status === "failed") {
          return { kind: "already_terminal", execution };
        }
      } catch {
        throw error;
      }
      throw error;
    }
  }

  #client(apiKey: string, userId?: string): Eyeball {
    return new Eyeball({
      apiKey,
      baseUrl: this.#baseUrl,
      ...(userId === undefined ? {} : { userId }),
      ...(this.#fetchImpl === undefined ? {} : { fetch: this.#fetchImpl }),
    });
  }
}
