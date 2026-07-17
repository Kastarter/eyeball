import { randomUUID } from "node:crypto";
import { defaultCatalog } from "@eyeball/catalog";
import {
  type ConnectionId,
  EyeballError,
  isConnectionId,
  type JsonValue,
  type McpToolDescriptor,
  type NormalizedToolError,
  type QualifiedToolName,
  TOOL_ERROR_CODES,
  type ToolDefinition,
  toMcpTools,
} from "@eyeball/core";
import type { McpExecutor, TerminalExecution } from "./executor.js";
import {
  SEARCH_TOOL_NAME,
  SearchToolInputError,
  searchToolDescriptor,
  searchTools,
} from "./search-tool.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const MCP_SERVER_NAME = "eyeball-mcp-gateway" as const;
export const MCP_SERVER_VERSION = "0.0.1" as const;

const EXECUTION_META_KEY = "dev.eyeball/execution";
const TOOL_META_KEY = "dev.eyeball/tool";
const USER_ID_META_KEY = "dev.eyeball/userId";
const CONNECTION_ID_META_KEY = "dev.eyeball/connectionId";
const IDEMPOTENCY_KEY_META_KEY = "dev.eyeball/idempotencyKey";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export interface GatewayCatalog {
  listTools(): readonly ToolDefinition[];
  getTool(name: string): ToolDefinition | undefined;
}

export type ToolDiscoveryMode = "catalog" | "search";

export interface McpRequestContext {
  apiKey: string;
  /** Trusted server binding or transport-provided end-user identity. */
  userId?: string;
  sessionId?: string;
}

export interface McpProtocolOptions {
  executor: McpExecutor;
  catalog?: GatewayCatalog;
  discoveryMode?: ToolDiscoveryMode;
  serverVersion?: string;
  sessionIdFactory?: () => string;
}

export interface McpProtocolResult {
  response?: JsonRpcResponse;
  sessionId?: string;
}

interface ToolCallParams {
  name: string;
  input: Readonly<Record<string, JsonValue>>;
  meta: Readonly<Record<string, unknown>>;
}

interface ToolResult {
  content: readonly [{ type: "text"; text: string }];
  structuredContent?: JsonValue;
  isError?: true;
  _meta?: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function serialized(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function unexpectedError(): NormalizedToolError {
  return {
    code: TOOL_ERROR_CODES.PROVIDER_ERROR,
    message: "Tool execution failed unexpectedly.",
    retryable: false,
  };
}

function normalizedError(error: unknown): NormalizedToolError {
  if (error instanceof EyeballError) {
    return error.toJSON();
  }
  if (error instanceof SearchToolInputError) {
    return {
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: error.message,
      retryable: false,
    };
  }
  return unexpectedError();
}

function failedToolResult(
  error: NormalizedToolError,
  execution?: TerminalExecution,
): ToolResult {
  return {
    content: [{ type: "text", text: serialized({ error }) }],
    isError: true,
    ...(execution === undefined
      ? {}
      : {
          _meta: {
            [EXECUTION_META_KEY]: executionMeta(execution),
          },
        }),
  };
}

function successfulToolResult(
  output: JsonValue,
  execution?: TerminalExecution,
): ToolResult {
  return {
    content: [{ type: "text", text: serialized(output) }],
    structuredContent: output,
    ...(execution === undefined
      ? {}
      : {
          _meta: {
            [EXECUTION_META_KEY]: executionMeta(execution),
          },
        }),
  };
}

function executionMeta(
  execution: TerminalExecution,
): Readonly<Record<string, unknown>> {
  return {
    executionId: execution.executionId,
    tool: execution.tool,
    toolVersion: execution.toolVersion,
    catalogVersion: execution.catalogVersion,
    status: execution.status,
    latencyMs: execution.latencyMs,
  };
}

function requestMessage(
  value: unknown,
): JsonRpcRequest | JsonRpcNotification | undefined {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string"
  ) {
    return undefined;
  }
  if (!("id" in value)) {
    return {
      jsonrpc: "2.0",
      method: value.method,
      ...(value.params === undefined ? {} : { params: value.params }),
    };
  }
  if (
    value.id !== null &&
    typeof value.id !== "string" &&
    typeof value.id !== "number"
  ) {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    id: value.id,
    method: value.method,
    ...(value.params === undefined ? {} : { params: value.params }),
  };
}

function parseToolCallParams(value: unknown): ToolCallParams {
  if (!isRecord(value)) {
    throw new SearchToolInputError("tools/call params must be a JSON object.");
  }
  const unknownKey = Object.keys(value).find(
    (key) => key !== "name" && key !== "arguments" && key !== "_meta",
  );
  if (unknownKey !== undefined) {
    throw new SearchToolInputError(`Unknown tools/call field: ${unknownKey}.`);
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new SearchToolInputError(
      "tools/call name must be a non-empty string.",
    );
  }
  const input = value.arguments ?? {};
  if (!isRecord(input)) {
    throw new SearchToolInputError(
      "tools/call arguments must be a JSON object.",
    );
  }
  const meta = value._meta ?? {};
  if (!isRecord(meta)) {
    throw new SearchToolInputError("tools/call _meta must be a JSON object.");
  }
  return {
    name: value.name,
    input: input as Readonly<Record<string, JsonValue>>,
    meta,
  };
}

function optionalString(
  meta: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = meta[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SearchToolInputError(`${key} must be a non-empty string.`);
  }
  return value;
}

function connectionId(
  meta: Readonly<Record<string, unknown>>,
): ConnectionId | undefined {
  const value = optionalString(meta, CONNECTION_ID_META_KEY);
  if (value === undefined) {
    return undefined;
  }
  if (!isConnectionId(value)) {
    throw new SearchToolInputError(
      `${CONNECTION_ID_META_KEY} must be a valid conn_* identifier.`,
    );
  }
  return value;
}

function idempotencyKey(
  meta: Readonly<Record<string, unknown>>,
  requestId: JsonRpcId,
  sessionId: string | undefined,
): string {
  const explicit = optionalString(meta, IDEMPOTENCY_KEY_META_KEY);
  if (explicit !== undefined) {
    return explicit;
  }
  return `mcp:${sessionId ?? "stateless"}:${String(requestId)}`;
}

function descriptorWithMeta(
  descriptor: McpToolDescriptor,
  tool: ToolDefinition,
): McpToolDescriptor & { _meta: Readonly<Record<string, unknown>> } {
  return {
    ...descriptor,
    _meta: {
      [TOOL_META_KEY]: {
        toolkit: tool.toolkit,
        capability: tool.capability,
        version: tool.version,
      },
    },
  };
}

function visibleTools(catalog: GatewayCatalog): readonly ToolDefinition[] {
  return catalog.listTools().filter((tool) => !tool.annotations.async);
}

function listedTools(
  catalog: GatewayCatalog,
  discoveryMode: ToolDiscoveryMode,
): readonly (McpToolDescriptor | (McpToolDescriptor & { _meta: unknown }))[] {
  if (discoveryMode === "search") {
    return [searchToolDescriptor];
  }
  const raw = visibleTools(catalog);
  const converted = toMcpTools(raw);
  return [
    searchToolDescriptor,
    ...converted.map((descriptor, index) => {
      const tool = raw[index];
      if (tool === undefined || tool.name !== descriptor.name) {
        throw new Error("MCP conversion changed canonical catalog ordering.");
      }
      return descriptorWithMeta(descriptor, tool);
    }),
  ];
}

function initializeParams(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    isRecord(value) &&
    typeof value.protocolVersion === "string" &&
    isRecord(value.capabilities) &&
    isRecord(value.clientInfo)
  );
}

function listParamsValid(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return (
    isRecord(value) &&
    (value.cursor === undefined || typeof value.cursor === "string")
  );
}

/** Implements a stateless request/response profile of MCP Streamable HTTP. */
export class McpProtocol {
  readonly #executor: McpExecutor;
  readonly #catalog: GatewayCatalog;
  readonly #discoveryMode: ToolDiscoveryMode;
  readonly #serverVersion: string;
  readonly #sessionIdFactory: () => string;

  constructor(options: McpProtocolOptions) {
    this.#executor = options.executor;
    this.#catalog = options.catalog ?? defaultCatalog;
    this.#discoveryMode = options.discoveryMode ?? "catalog";
    this.#serverVersion = options.serverVersion ?? MCP_SERVER_VERSION;
    this.#sessionIdFactory =
      options.sessionIdFactory ??
      (() => `mcp_${randomUUID().replaceAll("-", "")}`);
  }

  async handle(
    value: unknown,
    context: McpRequestContext,
  ): Promise<McpProtocolResult> {
    const message = requestMessage(value);
    if (message === undefined) {
      return { response: rpcError(null, -32600, "Invalid Request") };
    }
    if (!("id" in message)) {
      // Notifications never dispatch tools: doing so would lose both a stable call ID and
      // a result channel for mutation failures.
      return {};
    }

    switch (message.method) {
      case "initialize": {
        if (!initializeParams(message.params)) {
          return {
            response: rpcError(message.id, -32602, "Invalid initialize params"),
          };
        }
        const sessionId = this.#sessionIdFactory();
        return {
          sessionId,
          response: rpcResult(message.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, version: this.#serverVersion },
            instructions:
              "Use eyeball.search_tools to find canonical provider tools. Tool failures are returned as normalized MCP tool results.",
          }),
        };
      }
      case "ping":
        return { response: rpcResult(message.id, {}) };
      case "tools/list": {
        if (!listParamsValid(message.params)) {
          return {
            response: rpcError(message.id, -32602, "Invalid tools/list params"),
          };
        }
        const cursor = isRecord(message.params)
          ? message.params.cursor
          : undefined;
        if (cursor !== undefined) {
          return {
            response: rpcError(
              message.id,
              -32602,
              "This gateway returns the complete tool list and does not accept cursors.",
            ),
          };
        }
        return {
          response: rpcResult(message.id, {
            tools: listedTools(this.#catalog, this.#discoveryMode),
          }),
        };
      }
      case "tools/call":
        if (isRecord(message.params) && "task" in message.params) {
          return {
            response: rpcResult(
              message.id,
              failedToolResult({
                code: TOOL_ERROR_CODES.NOT_SUPPORTED,
                message:
                  "MCP Tasks calls are not supported because this gateway did not negotiate Tasks capability.",
                retryable: false,
              }),
            ),
          };
        }
        return {
          response: rpcResult(
            message.id,
            await this.#callTool(message.id, message.params, context),
          ),
        };
      default:
        return {
          response: rpcError(message.id, -32601, "Method not found"),
        };
    }
  }

  async #callTool(
    requestId: JsonRpcId,
    value: unknown,
    context: McpRequestContext,
  ): Promise<ToolResult> {
    let params: ToolCallParams;
    try {
      params = parseToolCallParams(value);
    } catch (error) {
      return failedToolResult(normalizedError(error));
    }

    const available = visibleTools(this.#catalog);
    if (params.name === SEARCH_TOOL_NAME) {
      try {
        return successfulToolResult(
          searchTools(available, params.input) as unknown as JsonValue,
        );
      } catch (error) {
        return failedToolResult(normalizedError(error));
      }
    }

    const tool = this.#catalog.getTool(params.name);
    if (tool === undefined) {
      return failedToolResult({
        code: TOOL_ERROR_CODES.NOT_SUPPORTED,
        message: `Tool ${params.name} is not supported.`,
        retryable: false,
      });
    }
    if (tool.annotations.async) {
      return failedToolResult({
        code: TOOL_ERROR_CODES.NOT_SUPPORTED,
        message: `Tool ${tool.name} requires MCP Tasks support, which this gateway did not negotiate.`,
        retryable: false,
      });
    }

    try {
      const userId =
        context.userId ?? optionalString(params.meta, USER_ID_META_KEY);
      if (userId === undefined || userId.trim().length === 0) {
        return failedToolResult({
          code: TOOL_ERROR_CODES.INVALID_INPUT,
          message:
            "An end-user ID is required; configure EYEBALL_USER_ID, send X-Eyeball-User-Id, or pass dev.eyeball/userId in tools/call _meta.",
          retryable: false,
        });
      }
      const selectedConnectionId = connectionId(params.meta);
      const execution = await this.#executor.execute({
        apiKey: context.apiKey,
        userId,
        tool: tool.name as QualifiedToolName,
        input: params.input,
        idempotencyKey: idempotencyKey(
          params.meta,
          requestId,
          context.sessionId,
        ),
        ...(selectedConnectionId === undefined
          ? {}
          : { connectionId: selectedConnectionId }),
      });
      return execution.status === "succeeded"
        ? successfulToolResult(execution.output, execution)
        : failedToolResult(execution.error, execution);
    } catch (error) {
      return failedToolResult(normalizedError(error));
    }
  }
}

export function parseJsonRpc(
  text: string,
): { ok: true; value: unknown } | { ok: false; response: JsonRpcResponse } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: rpcError(null, -32700, "Parse error") };
  }
}
