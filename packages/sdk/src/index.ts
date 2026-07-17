export const VERSION = "0.0.1";

export {
  type AsyncExecuteResponse,
  type ConnectionId,
  type ExecutionId,
  type ExecutionMode,
  type ExecutionRecord,
  type ExecutionResult,
  type ExecutionStatus,
  EyeballError,
  type JsonValue,
  type NormalizedToolError,
  type QualifiedToolName,
  TOOL_ERROR_CODES,
  type ToolDefinition,
  type ToolNameMap,
} from "@eyeball/core";
export {
  ConnectionsClient,
  ExecutionsClient,
  Eyeball,
  ToolsClient,
} from "./client.js";
export { executeToolCalls } from "./tool-calls.js";
export type * from "./types.js";
