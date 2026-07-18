import type {
  AiSdkToolSet,
  AnthropicToolDescriptor,
  CapabilitySlug,
  ConnectionId,
  ExecutionMode,
  ExecutionRecord,
  ExecutionStatus,
  JsonValue,
  McpToolDescriptor,
  OpenAIFunctionToolDescriptor,
  ToolDefinition,
  ToolNameMap,
  TriggerDefinition,
  WebhookSubscriptionEventType,
} from "@eyeball/core";

/** Fields accepted when registering a signed webhook destination. */
export interface CreateWebhookEndpointOptions {
  url: string;
  events: readonly WebhookSubscriptionEventType[];
  active?: boolean;
}

/** Mutable webhook endpoint fields; at least one must be present. */
export interface UpdateWebhookEndpointOptions {
  url?: string;
  events?: readonly WebhookSubscriptionEventType[];
  active?: boolean;
}

/** Cursor pagination controls for webhook endpoint listing. */
export interface ListWebhookEndpointsOptions {
  cursor?: string;
  limit?: number;
}

/** Cursor pagination controls for one endpoint's delivery history. */
export interface ListWebhookDeliveriesOptions {
  cursor?: string;
  limit?: number;
}

/** Local catalog filters for canonical trigger discovery. */
export interface GetTriggersOptions {
  toolkits?: readonly string[];
  capability?: CapabilitySlug;
  deliveryMode?: TriggerDefinition["annotations"]["deliveryMode"];
}

/** Fields accepted when creating a push or polling trigger subscription. */
export interface CreateSubscriptionOptions {
  trigger: string;
  /** Uses the client-level userId when omitted. */
  userId?: string;
  connectionId?: ConnectionId;
  webhookEndpointIds: readonly string[];
  filters?: Readonly<Record<string, JsonValue>>;
  /** Polling triggers only; the catalog default is used when omitted. */
  pollIntervalSeconds?: number;
}

/** User and cursor filters for trigger subscription listing. */
export interface ListSubscriptionsOptions {
  /** Uses the client-level userId when omitted; omit both to list the project. */
  userId?: string;
  cursor?: string;
  limit?: number;
}

/** Tool-definition formats emitted for supported model frameworks and MCP. */
export type EyeballToolFormat =
  | "canonical"
  | "anthropic"
  | "openai"
  | "ai-sdk"
  | "mcp";

/** Compile-time mapping from a requested format to its emitted tool container. */
export interface EyeballToolFormatMap {
  canonical: readonly ToolDefinition[];
  anthropic: AnthropicToolDescriptor[];
  openai: OpenAIFunctionToolDescriptor[];
  "ai-sdk": AiSdkToolSet;
  mcp: McpToolDescriptor[];
}

/** Local catalog filters and conversion controls for `tools.get`. */
export interface GetToolsOptions<
  Format extends EyeballToolFormat = "canonical",
> {
  /**
   * Binds framework-owned execute callbacks to an end user. Tool discovery itself is
   * resolved entirely from the local `@eyeball/catalog`; hosted project catalog policy
   * belongs to eyeball-cloud and is not fetched by this method.
   */
  userId?: string;
  toolkits?: readonly string[];
  capability?: CapabilitySlug;
  format?: Format;
  /** MCP only: include async-by-nature tools after Tasks support is negotiated. */
  includeAsync?: boolean;
}

/** Converted model tools plus canonical definitions and reversible names. */
export interface GetToolsResult<Format extends EyeballToolFormat> {
  tools: EyeballToolFormatMap[Format];
  nameMap: ToolNameMap;
  raw: readonly ToolDefinition[];
}

/** Query and optional local catalog filters for `tools.search`. */
export interface SearchToolsOptions {
  query: string;
  limit?: number;
  /** Optional local catalog filters, applied before ranking. */
  toolkits?: readonly string[];
  capability?: CapabilitySlug;
  /** Accepted for parity with the future hosted project-scoped search surface. */
  userId?: string;
}

/** Canonical definitions ranked by local catalog relevance. */
export interface SearchToolsResult {
  tools: readonly ToolDefinition[];
}

/** Canonical input and execution controls for `tools.execute`. */
export interface ExecuteToolOptions {
  /** Uses the client-level userId when omitted. */
  userId?: string;
  input: Readonly<Record<string, JsonValue>>;
  /** Defaults from the canonical tool's `annotations.async` value. */
  mode?: ExecutionMode;
  /**
   * Stable caller key for retry correlation. When omitted for a mutation, the SDK
   * generates a fresh `crypto.randomUUID()` for this invocation. Pass your own key
   * when separate calls must replay the same execution.
   */
  idempotencyKey?: string;
  connectionId?: ConnectionId;
}

/** Local polling cadence and deadline for terminal execution state. */
export interface WaitForExecutionOptions {
  /** Milliseconds between polls. Defaults to 500. */
  pollMs?: number;
  /** Total milliseconds before a timeout error. Defaults to 60,000. */
  timeoutMs?: number;
}

/** Execution and polling controls for `tools.run`. */
export interface RunToolOptions
  extends Omit<ExecuteToolOptions, "input">,
    WaitForExecutionOptions {}

/** Project execution-history filters and cursor controls. */
export interface ListExecutionsOptions {
  status?: ExecutionStatus;
  /** Canonical dotted or restricted wire name. */
  tool?: string;
  /** Uses the client-level userId when omitted. */
  userId?: string;
  cursor?: string;
  limit?: number;
}

/** One cursor page of public execution records. */
export interface ExecutionPage {
  executions: readonly ExecutionRecord[];
  nextCursor?: string;
}

/** Name, media type, and exact content staged by `files.upload`. */
export interface UploadFileOptions {
  name: string;
  mimeType?: string;
  /** Strings are staged as UTF-8; byte arrays (including Node Buffers) are preserved. */
  content: Uint8Array | string;
}

/** User and toolkit fields for a development connection fixture. */
export interface CreateConnectionOptions {
  /** Uses the client-level userId when omitted. */
  userId?: string;
  toolkit: string;
}

/** Successful development connection creation result. */
export interface ConnectedConnection {
  connectionId: ConnectionId;
  redirectUrl: null;
  status: "connected";
}

/** Public connection status returned by the development executor API. */
export interface ConnectionSummary {
  connectionId: ConnectionId;
  createdAt: string;
  userId: string;
  toolkit: string;
  status: "connected" | "expired" | "revoked";
}

/** Collection of development connection summaries. */
export interface ConnectionPage {
  connections: readonly ConnectionSummary[];
}

/** Result returned after a development connection is revoked. */
export interface RevokedConnection {
  connectionId: ConnectionId;
  status: "revoked";
}

/** Injectable millisecond clock used to bound execution polling. */
export interface EyeballClock {
  now(): number;
}

/** Injectable sleep function used by polling and safe GET retry delays. */
export type EyeballSleep = (milliseconds: number) => Promise<void>;

/** Authentication, executor location, user binding, and transport seams. */
export interface EyeballOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** Default end-user binding for user-scoped methods. */
  userId?: string;
  /** Test seam used by execution polling. */
  clock?: EyeballClock;
  /** Test seam used by execution polling. */
  sleep?: EyeballSleep;
  /** Development-only escape hatch for non-loopback cleartext executor URLs. */
  allowInsecureHttp?: boolean;
}

/** Name-map boundary and execution controls for framework tool-call dispatch. */
export interface ExecuteToolCallsOptions {
  /** Exact map emitted with the model-facing tool bundle. Unmapped calls are rejected. */
  nameMap: ToolNameMap;
  /** Uses the client-level userId when omitted. */
  userId?: string;
  connectionId?: ConnectionId;
  mode?: ExecutionMode;
  pollMs?: number;
  timeoutMs?: number;
}

/** Anthropic `tool_use` block accepted by `executeToolCalls`. */
export interface AnthropicToolCall {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** Anthropic `tool_result` block returned by `executeToolCalls`. */
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** OpenAI function tool call accepted by `executeToolCalls`. */
export interface OpenAIFunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string | Readonly<Record<string, JsonValue>>;
  };
}

/** OpenAI custom tool call represented in the public input union. */
export interface OpenAICustomToolCall {
  id: string;
  type: "custom";
  custom: { name: string; input: string };
}

/** OpenAI function or custom tool call accepted by `executeToolCalls`. */
export type OpenAIToolCall = OpenAIFunctionToolCall | OpenAICustomToolCall;

/** OpenAI tool result message returned by `executeToolCalls`. */
export interface OpenAIToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}
