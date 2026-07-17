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
  WebhookSubscriptionEventType,
} from "@eyeball/core";

export interface CreateWebhookEndpointOptions {
  url: string;
  events: readonly WebhookSubscriptionEventType[];
  active?: boolean;
}

export interface UpdateWebhookEndpointOptions {
  url?: string;
  events?: readonly WebhookSubscriptionEventType[];
  active?: boolean;
}

export interface ListWebhookEndpointsOptions {
  cursor?: string;
  limit?: number;
}

export interface ListWebhookDeliveriesOptions {
  cursor?: string;
  limit?: number;
}

export type EyeballToolFormat =
  | "canonical"
  | "anthropic"
  | "openai"
  | "ai-sdk"
  | "mcp";

export interface EyeballToolFormatMap {
  canonical: readonly ToolDefinition[];
  anthropic: AnthropicToolDescriptor[];
  openai: OpenAIFunctionToolDescriptor[];
  "ai-sdk": AiSdkToolSet;
  mcp: McpToolDescriptor[];
}

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

export interface GetToolsResult<Format extends EyeballToolFormat> {
  tools: EyeballToolFormatMap[Format];
  nameMap: ToolNameMap;
  raw: readonly ToolDefinition[];
}

export interface SearchToolsOptions {
  query: string;
  limit?: number;
  /** Optional local catalog filters, applied before ranking. */
  toolkits?: readonly string[];
  capability?: CapabilitySlug;
  /** Accepted for parity with the future hosted project-scoped search surface. */
  userId?: string;
}

export interface SearchToolsResult {
  tools: readonly ToolDefinition[];
}

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

export interface WaitForExecutionOptions {
  /** Milliseconds between polls. Defaults to 500. */
  pollMs?: number;
  /** Total milliseconds before a timeout error. Defaults to 60,000. */
  timeoutMs?: number;
}

export interface RunToolOptions
  extends Omit<ExecuteToolOptions, "input">,
    WaitForExecutionOptions {}

export interface ListExecutionsOptions {
  status?: ExecutionStatus;
  /** Canonical dotted or restricted wire name. */
  tool?: string;
  /** Uses the client-level userId when omitted. */
  userId?: string;
  cursor?: string;
  limit?: number;
}

export interface ExecutionPage {
  executions: readonly ExecutionRecord[];
  nextCursor?: string;
}

export interface UploadFileOptions {
  name: string;
  mimeType?: string;
  /** Strings are staged as UTF-8; byte arrays (including Node Buffers) are preserved. */
  content: Uint8Array | string;
}

export interface CreateConnectionOptions {
  /** Uses the client-level userId when omitted. */
  userId?: string;
  toolkit: string;
}

export interface ConnectedConnection {
  connectionId: ConnectionId;
  redirectUrl: null;
  status: "connected";
}

export interface ConnectionSummary {
  connectionId: ConnectionId;
  createdAt: string;
  userId: string;
  toolkit: string;
  status: "connected" | "expired" | "revoked";
}

export interface ConnectionPage {
  connections: readonly ConnectionSummary[];
}

export interface RevokedConnection {
  connectionId: ConnectionId;
  status: "revoked";
}

export interface EyeballClock {
  now(): number;
}

export type EyeballSleep = (milliseconds: number) => Promise<void>;

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

export interface AnthropicToolCall {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface OpenAIFunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string | Readonly<Record<string, JsonValue>>;
  };
}

export interface OpenAICustomToolCall {
  id: string;
  type: "custom";
  custom: { name: string; input: string };
}

export type OpenAIToolCall = OpenAIFunctionToolCall | OpenAICustomToolCall;

export interface OpenAIToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}
