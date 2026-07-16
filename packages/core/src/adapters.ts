import type { ResolvedCredential } from "./credentials.js";
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

export interface AdapterContext {
  tool: ToolDefinition;
  canonicalInput: Readonly<Record<string, JsonValue>>;
  credential: ResolvedCredential;
  baseUrl: string;
  fetchImpl: FetchImplementation;
  clock: Clock;
  logger: ExecutorLogger;
}

export interface ToolkitAdapter {
  readonly toolkitSlug: ToolkitSlug;
  execute(context: AdapterContext): Promise<JsonValue>;
}
