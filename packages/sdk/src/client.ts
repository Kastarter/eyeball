import {
  CatalogToolSearchInputError,
  defaultCatalog,
  searchCatalogTools,
} from "@eyeball/catalog";
import {
  buildNameMap,
  type ExecutionBase,
  type ExecutionRecord,
  type ExecutionResult,
  EyeballError,
  fromRestrictedToolName,
  isCanonicalToolName,
  type JsonValue,
  type QualifiedToolName,
  TOOL_ERROR_CODES,
  type ToolDefinition,
  toAiSdkTools,
  toAnthropicTools,
  toMcpTools,
  toOpenAITools,
} from "@eyeball/core";
import { EyeballHttpClient, errorFromNormalized } from "./http.js";
import type {
  ConnectedConnection,
  CreateConnectionOptions,
  ExecuteToolOptions,
  ExecutionPage,
  EyeballClock,
  EyeballOptions,
  EyeballSleep,
  EyeballToolFormat,
  GetToolsOptions,
  GetToolsResult,
  ListExecutionsOptions,
  RunToolOptions,
  SearchToolsOptions,
  SearchToolsResult,
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

function localTool(name: string): ToolDefinition {
  const canonical = canonicalToolName(name);
  const tool = defaultCatalog.getTool(canonical);
  if (tool === undefined) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.NOT_SUPPORTED,
      message: `Tool ${canonical} is not present in the local @eyeball/catalog.`,
      retryable: false,
    });
  }
  return tool;
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

export class ExecutionsClient {
  readonly #context: ClientContext;

  constructor(context: ClientContext) {
    this.#context = context;
  }

  get(executionId: string): Promise<ExecutionRecord> {
    return this.#context.http.request(
      `/v1/executions/${encodeURIComponent(executionId)}`,
    );
  }

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

export class ToolsClient {
  readonly #context: ClientContext;
  readonly #executions: ExecutionsClient;

  constructor(context: ClientContext, executions: ExecutionsClient) {
    this.#context = context;
    this.#executions = executions;
  }

  /** Searches the local open-core catalog without contacting the executor. */
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
   * Resolves the open-core catalog locally; this method never calls the executor.
   * Hosted per-project enablement and catalog policy are eyeball-cloud concerns.
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
        );
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
        });
        break;
      }
    }

    return { tools, nameMap, raw } as GetToolsResult<Format>;
  }

  /**
   * Executes a canonical dotted or restricted wire tool name. Mutations receive a
   * generated UUID idempotency key when one is not supplied. The generated key covers
   * this invocation only; pass a stable key to correlate retries across calls.
   */
  async execute(
    toolName: string,
    options: ExecuteToolOptions,
  ): Promise<ExecutionResult> {
    const tool = localTool(toolName);
    const userId = effectiveUserId(options.userId, this.#context.defaultUserId);
    const mode = options.mode ?? (tool.annotations.async ? "async" : "sync");
    const idempotencyKey =
      options.idempotencyKey ??
      (tool.annotations.readOnly ? undefined : globalThis.crypto.randomUUID());
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
        tool: tool.name,
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
   * Agent-loop convenience: accepts the exact canonical or wire name emitted by a model,
   * waits for async work when necessary, and returns only canonical output.
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

export class ConnectionsClient {
  readonly #context: ClientContext;

  constructor(context: ClientContext) {
    this.#context = context;
  }

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
}

export class Eyeball {
  readonly tools: ToolsClient;
  readonly executions: ExecutionsClient;
  readonly connections: ConnectionsClient;

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
    const context: ClientContext = {
      http: new EyeballHttpClient({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        fetchImpl,
      }),
      ...(options.userId === undefined
        ? {}
        : { defaultUserId: options.userId }),
      clock: options.clock ?? systemClock,
      sleep: options.sleep ?? systemSleep,
    };
    this.executions = new ExecutionsClient(context);
    this.tools = new ToolsClient(context, this.executions);
    this.connections = new ConnectionsClient(context);
  }
}
