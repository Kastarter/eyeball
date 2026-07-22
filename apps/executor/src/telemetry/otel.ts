import type { ExecutorLogger } from "@eyeball/core";
import {
  type Attributes,
  type Context,
  type Counter,
  context,
  type Histogram,
  type Meter,
  metrics,
  type ObservableGauge,
  type Span,
  SpanKind,
  type SpanOptions,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { createDefaultLogger, redactFields, withRedaction } from "./log.js";

const INSTRUMENTATION_NAME = "@eyeball/executor";
const INSTRUMENTATION_VERSION = "0.1.0";

export interface ExecutorTelemetry {
  logger?: ExecutorLogger;
  tracer?: Tracer;
  meter?: Meter;
}

export interface TelemetrySpan {
  span?: Span;
  context?: Context;
}

interface ExecutorInstruments {
  executions: Counter;
  executionLatency: Histogram;
  httpRequests: Counter;
  httpRequestDuration: Histogram;
  webhookDeliveryAttempts: Counter;
  triggerEvents: Counter;
  rateLimitRejections: Counter;
  usageReservations: Counter;
  usageReports: Counter;
  usageOutboxDepth: ObservableGauge;
}

export type ExecutionTelemetryStatus = "succeeded" | "failed" | "cancelled";
export type WebhookTelemetryStatus =
  | "succeeded"
  | "http_error"
  | "timeout"
  | "transport_error";
export type RateLimitTelemetryBucket =
  | "request_standard"
  | "request_execute"
  | "daily_execution_quota"
  | "toolkit_concurrency";
export type UsageReservationTelemetryOutcome =
  | "allowed"
  | "denied"
  | "fail_open"
  | "error";
export type UsageReportTelemetryOutcome = "accepted" | "duplicate" | "failed";
export type HttpRequestClass = "health" | "execute" | "ingest" | "standard";
export type HttpRequestMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "OTHER";

export interface ExecutorTelemetryRuntime {
  logger: ExecutorLogger;
  tracer?: Tracer;
  meter?: Meter;
  startSpan(
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
    parentContext?: Context,
    options?: Pick<SpanOptions, "kind">,
  ): TelemetrySpan;
  recordExecution(
    tool: string,
    status: ExecutionTelemetryStatus,
    latencyMs: number,
  ): void;
  recordHttpRequest(
    requestClass: HttpRequestClass,
    method: HttpRequestMethod,
    statusCode: number,
    durationMs: number,
  ): void;
  recordWebhookDeliveryAttempt(status: WebhookTelemetryStatus): void;
  recordTriggerEvent(trigger: string, deduped: boolean): void;
  recordRateLimitRejection(bucket: RateLimitTelemetryBucket): void;
  recordUsageReservation(outcome: UsageReservationTelemetryOutcome): void;
  recordUsageReport(outcome: UsageReportTelemetryOutcome, count?: number): void;
  setUsageOutboxDepth(depth: number): void;
}

function telemetryAttributes(
  attributes: Readonly<Record<string, unknown>> = {},
): Attributes {
  const redacted = redactFields(attributes);
  const result: Attributes = {};
  for (const [key, value] of Object.entries(redacted)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      result[key] = [...value] as string[];
    } else if (value !== undefined) {
      result[key] = "[REDACTED:structured]";
    }
  }
  return result;
}

function createInstruments(meter: Meter): ExecutorInstruments {
  return {
    executions: meter.createCounter("executions_total", {
      description: "Terminal Eyeball executions.",
    }),
    executionLatency: meter.createHistogram("execution_latency_ms", {
      description: "End-to-end execution latency in milliseconds.",
      unit: "ms",
    }),
    httpRequests: meter.createCounter("http_requests_total", {
      description: "Executor HTTP requests.",
    }),
    httpRequestDuration: meter.createHistogram("http_request_duration_ms", {
      description: "Executor HTTP request duration in milliseconds.",
      unit: "ms",
    }),
    webhookDeliveryAttempts: meter.createCounter(
      "webhook_delivery_attempts_total",
      { description: "Signed webhook delivery attempts." },
    ),
    triggerEvents: meter.createCounter("trigger_events_total", {
      description: "Normalized trigger events, including duplicates.",
    }),
    rateLimitRejections: meter.createCounter("rate_limit_rejections_total", {
      description: "Rejected executor rate-limit checks.",
    }),
    usageReservations: meter.createCounter("usage_reservations_total", {
      description: "Cloud execution usage reservation outcomes.",
    }),
    usageReports: meter.createCounter("usage_reports_total", {
      description: "Terminal execution usage report outcomes.",
    }),
    usageOutboxDepth: meter.createObservableGauge("usage_outbox_depth", {
      description: "Terminal usage reports awaiting successful Cloud delivery.",
    }),
  };
}

export function createExecutorTelemetryRuntime(
  telemetry: ExecutorTelemetry = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExecutorTelemetryRuntime {
  const logger = withRedaction(telemetry.logger ?? createDefaultLogger(env));
  const instruments =
    telemetry.meter === undefined
      ? undefined
      : createInstruments(telemetry.meter);
  let usageOutboxDepth = 0;
  instruments?.usageOutboxDepth.addCallback((result) => {
    result.observe(usageOutboxDepth);
  });

  return {
    logger,
    ...(telemetry.tracer === undefined ? {} : { tracer: telemetry.tracer }),
    ...(telemetry.meter === undefined ? {} : { meter: telemetry.meter }),
    startSpan(name, attributes, parentContext, options) {
      if (telemetry.tracer === undefined) return {};
      const span = telemetry.tracer.startSpan(
        name,
        {
          ...options,
          attributes: telemetryAttributes(attributes),
        },
        parentContext ?? context.active(),
      );
      return {
        span,
        context: trace.setSpan(parentContext ?? context.active(), span),
      };
    },
    recordExecution(tool, status, latencyMs) {
      const attributes = telemetryAttributes({ tool, status });
      instruments?.executions.add(1, attributes);
      instruments?.executionLatency.record(latencyMs, { tool });
    },
    recordHttpRequest(requestClass, method, statusCode, durationMs) {
      const attributes = {
        request_class: requestClass,
        method,
        status_code: statusCode,
      };
      instruments?.httpRequests.add(1, attributes);
      instruments?.httpRequestDuration.record(durationMs, attributes);
    },
    recordWebhookDeliveryAttempt(status) {
      instruments?.webhookDeliveryAttempts.add(1, { status });
    },
    recordTriggerEvent(trigger, deduped) {
      instruments?.triggerEvents.add(1, { trigger, deduped });
    },
    recordRateLimitRejection(bucket) {
      instruments?.rateLimitRejections.add(1, { bucket });
    },
    recordUsageReservation(outcome) {
      instruments?.usageReservations.add(1, { outcome });
    },
    recordUsageReport(outcome, count = 1) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError("Usage report metric count must be non-negative.");
      }
      if (count > 0) instruments?.usageReports.add(count, { outcome });
    },
    setUsageOutboxDepth(depth) {
      if (!Number.isSafeInteger(depth) || depth < 0) {
        throw new RangeError("Usage outbox depth must be non-negative.");
      }
      usageOutboxDepth = depth;
    },
  };
}

export function markSpanError(span: Span | undefined, error: unknown): void {
  if (span === undefined) return;
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute(
    "error.type",
    error instanceof Error ? error.name : "unknown",
  );
}

export function markSpanOk(span: Span | undefined): void {
  span?.setStatus({ code: SpanStatusCode.OK });
}

export async function inTelemetrySpan<T>(
  telemetry: ExecutorTelemetryRuntime,
  name: string,
  attributes: Readonly<Record<string, unknown>>,
  operation: (
    spanContext: Context | undefined,
    span: Span | undefined,
  ) => Promise<T>,
  parentContext?: Context,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  const started = telemetry.startSpan(name, attributes, parentContext, {
    kind,
  });
  try {
    const result = await operation(started.context, started.span);
    markSpanOk(started.span);
    return result;
  } catch (error) {
    markSpanError(started.span, error);
    throw error;
  } finally {
    started.span?.end();
  }
}

export interface OpenTelemetrySetup {
  enabled: boolean;
  tracer?: Tracer;
  meter?: Meter;
  shutdown(): Promise<void>;
}

function signalEndpoint(
  env: Readonly<Record<string, string | undefined>>,
  signal: "traces" | "metrics",
): string | undefined {
  const explicit =
    signal === "traces"
      ? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      : env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  if (explicit !== undefined && explicit.trim().length > 0) {
    return validatedEndpoint(explicit.trim());
  }
  const shared = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (shared === undefined || shared.length === 0) return undefined;
  const url = new URL(
    validatedEndpoint(shared.endsWith("/") ? shared : `${shared}/`),
  );
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/v1/${signal}`;
  return url.toString();
}

function validatedEndpoint(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError(
      "OpenTelemetry endpoints must be HTTP(S) URLs without credentials or fragments.",
    );
  }
  return url.toString();
}

function metricExportInterval(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const value = Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 60_000);
  return Number.isSafeInteger(value) && value > 0 ? value : 60_000;
}

/**
 * Loads and registers the SDK/exporters only when explicitly enabled. The
 * default path returns no tracer or meter and performs no exporter I/O.
 */
export async function initializeOpenTelemetry(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<OpenTelemetrySetup> {
  const enabled = env.EYEBALL_OTEL?.trim().toLowerCase();
  if (enabled !== "1" && enabled !== "true") {
    return { enabled: false, shutdown: async () => undefined };
  }

  const { OTLPMetricExporter } = await import(
    "@opentelemetry/exporter-metrics-otlp-http"
  );
  const { OTLPTraceExporter } = await import(
    "@opentelemetry/exporter-trace-otlp-http"
  );
  const { PeriodicExportingMetricReader } = await import(
    "@opentelemetry/sdk-metrics"
  );
  const { NodeSDK } = await import("@opentelemetry/sdk-node");

  const traceUrl = signalEndpoint(env, "traces");
  const metricUrl = signalEndpoint(env, "metrics");
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "eyeball-executor",
    traceExporter: new OTLPTraceExporter(
      traceUrl === undefined ? {} : { url: traceUrl },
    ),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(
          metricUrl === undefined ? {} : { url: metricUrl },
        ),
        exportIntervalMillis: metricExportInterval(env),
      }),
    ],
  });
  sdk.start();

  return {
    enabled: true,
    tracer: trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION),
    meter: metrics.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION),
    shutdown: () => sdk.shutdown(),
  };
}
