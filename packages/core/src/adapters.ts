import type { Context, Tracer } from "@opentelemetry/api";
import type { ResolvedCredential } from "./credentials.js";
import type { FileId, StagedFileMetadata } from "./types/execution.js";
import type { JsonValue, ToolDefinition, ToolkitSlug } from "./types/tool.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface ExecutorLogger {
  debug(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  info(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  error(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export const noopLogger: ExecutorLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export type FetchImplementation = typeof fetch;

/** Immutable file bytes resolved within the authenticated project boundary. */
export interface ResolvedFile {
  meta: StagedFileMetadata;
  content: Uint8Array;
}

/**
 * Execution-bound resolver. The executor captures project identity when it creates
 * this object, so adapters can select only a file ID, never a tenant.
 */
export interface FileResolver {
  resolve(fileId: FileId): Promise<ResolvedFile>;
}

/** Optional execution span propagated into provider HTTP helpers. */
export interface AdapterTelemetry {
  tracer: Tracer;
  context?: Context;
}

export interface AdapterContext {
  /** Trusted project scope from the authenticated executor request. */
  projectId: string;
  /** Trusted external-user scope from ExecuteRequest. */
  userId: string;
  tool: ToolDefinition;
  canonicalInput: Readonly<Record<string, JsonValue>>;
  credential: ResolvedCredential;
  baseUrl: string;
  fetchImpl: FetchImplementation;
  clock: Clock;
  logger: ExecutorLogger;
  telemetry?: AdapterTelemetry;
  files: FileResolver;
}

export interface ToolkitAdapter {
  readonly toolkitSlug: ToolkitSlug;
  execute(context: AdapterContext): Promise<JsonValue>;
}
