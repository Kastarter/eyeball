import {
  type Clock,
  type ExecutorLogger,
  noopLogger,
  systemClock,
} from "@eyeball/core";

export type Logger = ExecutorLogger;
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (line: string) => void;

export const REDACTED = "[REDACTED]";

const REDACTING_LOGGER = Symbol("eyeball.redacting-logger");

const MAX_DEPTH = 8;
const MAX_ENTRIES = 100;
const MAX_STRING_BYTES = 1_024;
const BODY_KEYS = new Set([
  "body",
  "bytes",
  "canonicalinput",
  "canonicaloutput",
  "content",
  "filecontent",
  "filecontents",
  "input",
  "output",
  "payload",
  "rawbody",
]);
const PREFIX_ONLY_SECRET_KEYS = new Set([
  "ingestsecret",
  "signingsecret",
  "webhooksecret",
]);
const EXACT_SECRET_KEYS = new Set(["idempotencykey"]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function sensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    EXACT_SECRET_KEYS.has(normalized) ||
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "credential" ||
    normalized === "credentials" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("signature") ||
    normalized.endsWith("token") ||
    normalized.endsWith("url")
  );
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function redactedBody(value: unknown): string {
  let bytes: number | undefined;
  if (typeof value === "string") {
    bytes = byteLength(value);
  } else if (value instanceof Uint8Array) {
    bytes = value.byteLength;
  } else {
    try {
      bytes = byteLength(JSON.stringify(value));
    } catch {
      bytes = undefined;
    }
  }
  return bytes === undefined
    ? "[REDACTED:body]"
    : `[REDACTED:body:${bytes} bytes]`;
}

function prefixOnly(value: unknown): string {
  if (typeof value !== "string" || value.length <= 4) return REDACTED;
  return `[REDACTED:${value.slice(0, 4)}…]`;
}

function redactValue(
  value: unknown,
  key: string | undefined,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (key !== undefined) {
    const normalized = normalizedKey(key);
    if (BODY_KEYS.has(normalized)) return redactedBody(value);
    if (PREFIX_ONLY_SECRET_KEYS.has(normalized)) return prefixOnly(value);
    if (sensitiveKey(key)) return REDACTED;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return Number.isFinite(value) || typeof value !== "number"
      ? value
      : String(value);
  }
  if (typeof value === "string") {
    const bytes = byteLength(value);
    return bytes <= MAX_STRING_BYTES
      ? value
      : `[REDACTED:long-string:${bytes} bytes]`;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }
  if (value instanceof Uint8Array) {
    return `[REDACTED:binary:${value.byteLength} bytes]`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.valueOf()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) return { name: value.name };
  if (depth >= MAX_DEPTH) return "[TRUNCATED:depth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const redacted = value
      .slice(0, MAX_ENTRIES)
      .map((entry) => redactValue(entry, undefined, depth + 1, seen));
    if (value.length > MAX_ENTRIES) redacted.push("[TRUNCATED:entries]");
    return redacted;
  }
  if (value instanceof Headers) {
    return redactValue(
      Object.fromEntries(value.entries()),
      undefined,
      depth + 1,
      seen,
    );
  }
  const entries = Object.entries(value as Readonly<Record<string, unknown>>);
  const redacted = Object.fromEntries(
    entries
      .slice(0, MAX_ENTRIES)
      .map(([childKey, child]) => [
        childKey,
        redactValue(child, childKey, depth + 1, seen),
      ]),
  );
  if (entries.length > MAX_ENTRIES) redacted._truncated = true;
  return redacted;
}

/** Central JSON-safe sanitizer used by every built-in logger and log delegate. */
export function redact(value: unknown): unknown {
  return redactValue(value, undefined, 0, new WeakSet());
}

export function redactFields(
  fields: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return redact(fields) as Readonly<Record<string, unknown>>;
}

export interface JsonLineLoggerOptions {
  clock?: Clock;
  format?: "json" | "pretty";
  level?: LogLevel;
  sink?: LogSink;
}

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(value: string | undefined): LogLevel {
  return value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
    ? value
    : "info";
}

export function createJsonLineLogger(
  options: JsonLineLoggerOptions = {},
): Logger {
  const clock = options.clock ?? systemClock;
  const format = options.format ?? "json";
  const minimum = LEVEL_PRIORITY[options.level ?? "info"];
  const sink =
    options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const write = (
    level: LogLevel,
    msg: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void => {
    if (LEVEL_PRIORITY[level] < minimum) return;
    const event = {
      level,
      ts: clock.now().toISOString(),
      msg,
      fields: redactFields(fields),
    };
    sink(
      format === "pretty"
        ? `${event.ts} ${level.toUpperCase().padEnd(5)} ${msg} ${JSON.stringify(event.fields)}`
        : JSON.stringify(event),
    );
  };

  return {
    [REDACTING_LOGGER]: true,
    debug: (message, metadata) => write("debug", message, metadata),
    info: (message, metadata) => write("info", message, metadata),
    warn: (message, metadata) => write("warn", message, metadata),
    error: (message, metadata) => write("error", message, metadata),
  } as Logger;
}

/** Ensures injected logger implementations receive only centrally redacted fields. */
export function withRedaction(logger: Logger): Logger {
  if (REDACTING_LOGGER in logger) return logger;
  return {
    debug: (message, metadata) => logger.debug(message, redactFields(metadata)),
    info: (message, metadata) => logger.info(message, redactFields(metadata)),
    warn: (message, metadata) => logger.warn(message, redactFields(metadata)),
    error: (message, metadata) => logger.error(message, redactFields(metadata)),
  };
}

export function createDefaultLogger(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Logger {
  const nodeEnv = env.NODE_ENV ?? process.env.NODE_ENV;
  const vitest = env.VITEST ?? process.env.VITEST;
  if (nodeEnv === "test" || vitest === "true") return noopLogger;
  return createJsonLineLogger({
    format: env.EYEBALL_LOG_FORMAT === "pretty" ? "pretty" : "json",
    level: configuredLevel(env.EYEBALL_LOG_LEVEL),
  });
}
