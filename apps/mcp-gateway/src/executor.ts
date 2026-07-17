import type {
  ConnectionId,
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

export interface McpExecutor {
  execute(request: McpExecuteRequest): Promise<TerminalExecution>;
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
    const client = new Eyeball({
      apiKey: request.apiKey,
      baseUrl: this.#baseUrl,
      userId: request.userId,
      ...(this.#fetchImpl === undefined ? {} : { fetch: this.#fetchImpl }),
    });
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
}
