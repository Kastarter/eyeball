export const VERSION = "0.1.0";

export {
  type AsyncExecuteResponse,
  type ConnectionId,
  type ExecutionId,
  type ExecutionMode,
  type ExecutionRecord,
  type ExecutionResult,
  type ExecutionStatus,
  EyeballError,
  type FileId,
  type JsonValue,
  type NormalizedToolError,
  type QualifiedToolName,
  type StagedFileMetadata,
  type StagedFileReference,
  TOOL_ERROR_CODES,
  type ToolDefinition,
  type ToolNameMap,
} from "@eyeball/core";
export {
  ConnectionsClient,
  ExecutionsClient,
  Eyeball,
  FilesClient,
  ToolsClient,
} from "./client.js";
export { executeToolCalls } from "./tool-calls.js";
export type * from "./types.js";
