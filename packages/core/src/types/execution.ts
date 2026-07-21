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
export type FileId = `file_${string}`;
/** @deprecated Use FileId. */
export type StagedFileId = FileId;
export type IdempotencyKey = string;

const ID_SEED_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function createPrefixedId<Prefix extends "exe" | "conn" | "file">(
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

/** Creates a `file_*` ID; passing a seed makes the result deterministic for tests. */
export function createFileId(seed?: string): FileId {
  return createPrefixedId("file", seed);
}

/** @deprecated Use createFileId. */
export const createStagedFileId = createFileId;

export function isExecutionId(value: string): value is ExecutionId {
  return value.startsWith("exe_") && ID_SEED_PATTERN.test(value.slice(4));
}

export function isConnectionId(value: string): value is ConnectionId {
  return value.startsWith("conn_") && ID_SEED_PATTERN.test(value.slice(5));
}

export function isFileId(value: string): value is FileId {
  return value.startsWith("file_") && ID_SEED_PATTERN.test(value.slice(5));
}

/** @deprecated Use isFileId. */
export const isStagedFileId = isFileId;

/** Preferred canonical reference to bytes staged through the files API. */
export interface StagedFileReference {
  fileId: FileId;
  /** Optional consumer-visible name overriding the staged metadata. */
  name?: string;
  /** Optional MIME type overriding the staged metadata. */
  mimeType?: string;
}

/** Catalog 1.0 reference shape retained for backward-compatible inputs. */
export interface LegacyStagedFileReference {
  fileId: FileId;
  fileName: string;
  contentType?: string;
}

/** Public metadata returned by the project-scoped staged-file API. */
export interface StagedFileMetadata {
  fileId: FileId;
  name: string;
  mimeType: string;
  size: number;
  expiresAt: string;
}

/** One cursor page of unexpired project-scoped staged-file metadata. */
export interface StagedFilePage {
  files: readonly StagedFileMetadata[];
  nextCursor?: string;
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

/**
 * Verified public origin metadata for an execution.
 *
 * A voice-session source is recorded only when the executor has verified the
 * session identity and its cryptographic binding to the reserved child
 * execution ID. Session grants, control tokens, and private worker headers are
 * never included.
 */
export type ExecutionSource = {
  readonly kind: "voice_session";
  readonly sessionId: string;
};

/**
 * Historical metadata-only summary of staged Eyeball files referenced by an
 * execution's validated canonical input.
 *
 * `count` is always the number of distinct IDs in `fileIds`. The summary does
 * not include names, MIME types, sizes, expiry timestamps, input paths, inline
 * content, decoded content, or file bytes, and it can outlive the staged files.
 */
export interface ExecutionAttachmentSummary {
  readonly count: number;
  readonly fileIds: readonly FileId[];
}

export type ExecutionRecord = ExecutionBase & {
  userId: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /**
   * Present as literal `true` after at least one accepted idempotent replay has
   * been observed for this execution.
   *
   * A replay reuses this record's execution ID. Absence does not show whether
   * the original request carried an idempotency key. No raw idempotency key,
   * prefix, hash, scope, or other derivative is included.
   */
  readonly replayed?: true;
  /** Verified bounded origin metadata, when the execution has one. */
  readonly source?: ExecutionSource;
  /** Distinct staged-file IDs referenced by the validated execution input. */
  readonly attachments?: ExecutionAttachmentSummary;
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
  active: boolean;
}

export interface ExecutionWebhookEvent {
  id: string;
  type: TerminalEventType;
  createdAt: string;
  projectId: string;
  data: ExecutionRecord & { status: "succeeded" | "failed" };
}
