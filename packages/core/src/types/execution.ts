import { randomUUID } from "node:crypto";
import type { NormalizedToolError } from "../errors.js";
import type {
  CatalogVersion,
  JsonValue,
  QualifiedToolName,
  SemVer,
} from "./tool.js";

export type ExecutionMode = "sync" | "async";
export type ExecutionStatus = "pending" | "running" | "succeeded" | "failed";
export type PollingExecutionStatus = ExecutionStatus;

export type ExecutionId = `exe_${string}`;
export type ConnectionId = `conn_${string}`;
export type IdempotencyKey = string;

const ID_SEED_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function createPrefixedId<Prefix extends "exe" | "conn">(
  prefix: Prefix,
  seed?: string,
): `${Prefix}_${string}` {
  const idBody = seed ?? randomUUID().replaceAll("-", "");
  if (!ID_SEED_PATTERN.test(idBody)) {
    throw new Error(
      "ID seed must be 1-128 characters using only letters, digits, underscores, or hyphens",
    );
  }
  return `${prefix}_${idBody}`;
}

/** Creates an `exe_*` ID; passing a seed makes the result deterministic for tests. */
export function createExecutionId(seed?: string): ExecutionId {
  return createPrefixedId("exe", seed);
}

/** Creates a `conn_*` ID; passing a seed makes the result deterministic for tests. */
export function createConnectionId(seed?: string): ConnectionId {
  return createPrefixedId("conn", seed);
}

export function isExecutionId(value: string): value is ExecutionId {
  return value.startsWith("exe_") && ID_SEED_PATTERN.test(value.slice(4));
}

export function isConnectionId(value: string): value is ConnectionId {
  return value.startsWith("conn_") && ID_SEED_PATTERN.test(value.slice(5));
}

export interface ExecuteRequest {
  tool: QualifiedToolName;
  userId: string;
  connectionId?: ConnectionId;
  input: Readonly<Record<string, JsonValue>>;
  mode: ExecutionMode;
}

export interface ExecutionBase {
  executionId: ExecutionId;
  tool: QualifiedToolName;
  toolVersion: SemVer;
  catalogVersion: CatalogVersion;
  status: ExecutionStatus;
}

export type SyncExecuteResponse =
  | (ExecutionBase & {
      status: "succeeded";
      output: JsonValue;
      error?: never;
      latencyMs: number;
    })
  | (ExecutionBase & {
      status: "failed";
      output?: never;
      error: NormalizedToolError;
      latencyMs: number;
    });

export type AsyncExecuteResponse = ExecutionBase & { status: "pending" };

/** The immediate result of POST /v1/execute in either execution mode. */
export type ExecutionResult = SyncExecuteResponse | AsyncExecuteResponse;

/** The RFC 001 async allocation envelope returned with HTTP 202. */
export type AsyncExecutionEnvelope = AsyncExecuteResponse;

export type ExecutionRecord = ExecutionBase & {
  userId: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
} & (
    | {
        status: "pending" | "running";
        output?: never;
        error?: never;
        latencyMs?: never;
      }
    | {
        status: "succeeded";
        output: JsonValue;
        error?: never;
        latencyMs: number;
      }
    | {
        status: "failed";
        output?: never;
        error: NormalizedToolError;
        latencyMs: number;
      }
  );

export type TerminalEventType = "execution.succeeded" | "execution.failed";

export interface WebhookEndpointConfig {
  id: string;
  url: string;
  events: readonly TerminalEventType[];
  secretReference: string;
  enabled: boolean;
}

export interface ExecutionWebhookEvent {
  id: string;
  type: TerminalEventType;
  createdAt: string;
  projectId: string;
  data: ExecutionRecord & { status: "succeeded" | "failed" };
}
