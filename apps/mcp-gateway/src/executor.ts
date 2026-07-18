import type {
  ConnectionId,
  ExecutionId,
  ExecutionRecord,
  ExecutionResult,
  JsonValue,
  QualifiedToolName,
} from "@eyeball/core";
import { Eyeball } from "@eyeball/sdk";

export type TerminalExecution =
  | Extract<ExecutionResult, { status: "succeeded" | "failed" }>
  | (ExecutionRecord & { status: "succeeded" | "failed" });

export interface McpExecuteRequest {
  apiKey: string;
  userId: string;
  tool: QualifiedToolName;
  input: Readonly<Record<string, JsonValue>>;
  idempotencyKey: string;
  connectionId?: ConnectionId;
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
  /** Optional cancellation seam; the stock executor intentionally does not implement it. */
  cancel?(request: McpExecutionRequest): Promise<void>;
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
      mode: "sync",
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

  #client(apiKey: string, userId?: string): Eyeball {
    return new Eyeball({
      apiKey,
      baseUrl: this.#baseUrl,
      ...(userId === undefined ? {} : { userId }),
      ...(this.#fetchImpl === undefined ? {} : { fetch: this.#fetchImpl }),
    });
  }
}
