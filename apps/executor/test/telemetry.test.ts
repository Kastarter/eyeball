import { CatalogRegistry } from "@eyeball/catalog";
import {
  type CapabilityToolContract,
  createExecutionId,
  JSON_SCHEMA_DRAFT_2020_12,
  type JsonValue,
  MockCredentialProvider,
  noopLogger,
  type ProviderManifest,
  type ToolkitAdapter,
} from "@eyeball/core";
import {
  DataPointType,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  type AdapterContext,
  createProviderHttpClient,
} from "../src/adapters/index.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { ExecutionEngine } from "../src/engine.js";
import { createExecutorApp } from "../src/routes.js";
import {
  createExecutorTelemetryRuntime,
  createJsonLineLogger,
  type ExecutorTelemetryRuntime,
  initializeOpenTelemetry,
  REDACTED,
  redact,
} from "../src/telemetry/index.js";
import {
  InMemoryWebhookEndpointStore,
  WebhookDeliverer,
} from "../src/webhooks/index.js";

const PROJECT_ID = "proj_telemetry";
const USER_ID = "user_telemetry";
const TOOL = "echo.run";
const INPUT_SECRET = "canonical-input-top-secret";
const ACCESS_TOKEN = "fixture:credential-token-top-secret";
const WEBHOOK_SECRET = "whsec_webhook-top-secret";
const UNTRUSTED_TOOL = "privatepayload.run";
const UNTRUSTED_SUBSCRIPTION_ID = "trgsub_private_subscription_top_secret";
const STARTED_AT = "2026-07-18T10:00:00.000Z";

const echoContract: CapabilityToolContract = {
  capability: "ai_media_utilities",
  name: "run",
  description: "Return a canonical echo response for telemetry tests.",
  inputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: "urn:eyeball:test:telemetry:echo:input:1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: { message: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: "urn:eyeball:test:telemetry:echo:output:1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["echo"],
    properties: { echo: { type: "string" } },
  },
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: "1.0.0",
};

const echoManifest: ProviderManifest = {
  schemaVersion: "1.0",
  catalogVersion: "2.0",
  toolkit: {
    slug: "echo",
    displayName: "Echo",
    source: "native",
    tier: "P0",
  },
  auth: { class: "oauth2", requiredScopes: ["echo:run"] },
  endpoint: {
    baseUrl: "https://provider.example.test/v1",
    baseUrlOverrideEnv: "EYEBALL_ECHO_BASE_URL",
  },
  implements: [
    {
      capability: "ai_media_utilities",
      canonicalTool: "run",
      canonicalVersion: "1.0.0",
      operationId: TOOL,
    },
  ],
};

class EchoAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "echo";

  async execute(context: AdapterContext): Promise<JsonValue> {
    const response = await createProviderHttpClient(context)(
      "/echo?private=query-secret",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context.canonicalInput),
      },
    );
    return (await response.json()) as JsonValue;
  }
}

const clock = { now: () => new Date(STARTED_AT) };

function createEngine(
  telemetry: ExecutorTelemetryRuntime,
  webhookDeliverer?: WebhookDeliverer,
): ExecutionEngine {
  const catalog = new CatalogRegistry({
    catalogVersion: "2.0",
    contracts: [echoContract],
    manifests: [echoManifest],
  });
  const credentialProvider = new MockCredentialProvider([
    {
      match: { projectId: PROJECT_ID, userId: USER_ID, toolkitSlug: "echo" },
      credential: {
        type: "oauth2",
        accessToken: ACCESS_TOKEN,
        scopes: ["echo:run"],
      },
    },
  ]);
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    const body = (await request.json()) as { message: string };
    return new Response(JSON.stringify({ echo: body.message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return new ExecutionEngine({
    catalog,
    adapters: new AdapterRegistry([new EchoAdapter()]),
    credentialProvider,
    fetchImpl,
    clock,
    telemetryRuntime: telemetry,
    ...(webhookDeliverer === undefined ? {} : { webhookDeliverer }),
    env: { EYEBALL_ECHO_BASE_URL: "https://provider.example.test/v1" },
    executionIdFactory: () => createExecutionId("telemetry1"),
  });
}

async function execute(engine: ExecutionEngine) {
  return engine.execute({
    projectId: PROJECT_ID,
    request: {
      tool: TOOL,
      userId: USER_ID,
      input: { message: INPUT_SECRET },
      mode: "sync",
    },
  });
}

async function createWebhookHarness(telemetry: ExecutorTelemetryRuntime) {
  const endpointStore = new InMemoryWebhookEndpointStore({
    endpointIdFactory: () => "whe_telemetry",
    secretFactory: () => WEBHOOK_SECRET,
  });
  await endpointStore.create(PROJECT_ID, {
    url: "https://hooks.example.test/callback?private=query-secret",
    events: ["execution.completed"],
    active: true,
    createdAt: STARTED_AT,
  });
  const webhookDeliverer = new WebhookDeliverer({
    endpointStore,
    telemetry,
    clock,
    retryDelaysMs: [0],
    fetchImpl: async () => new Response(null, { status: 204 }),
    eventIdFactory: () => "evt_telemetry",
  });
  return webhookDeliverer;
}

class InMemoryMetricReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}

  protected async onForceFlush(): Promise<void> {}

  snapshot(): Promise<{ resourceMetrics: ResourceMetrics; errors: unknown[] }> {
    return this.collect();
  }
}

function findMetric(resourceMetrics: ResourceMetrics, name: string) {
  const metric = resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((candidate) => candidate.descriptor.name === name);
  expect(metric, `metric ${name}`).toBeDefined();
  if (metric === undefined) throw new Error(`Metric ${name} was not recorded.`);
  return metric;
}

describe("executor observability", () => {
  it("centrally redacts credentials, authorization, bodies, binary files, and nested secrets", () => {
    const longBody = "x".repeat(2_000);
    const uploadBase64 = "ZmlsZS10ZWxlbWV0cnktc2VudGluZWw=";
    const decodedUpload = new TextEncoder().encode("file-telemetry-sentinel");
    const redacted = redact({
      credentials: {
        type: "oauth2",
        accessToken: ACCESS_TOKEN,
        refresh_token: "refresh-top-secret",
      },
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        Cookie: "session=cookie-top-secret",
      },
      idempotencyKey: "idempotency-top-secret",
      input: { message: INPUT_SECRET },
      output: longBody,
      nested: {
        signingSecret: WEBHOOK_SECRET,
        ingestUrl: "https://executor.example.test/ingest/url-top-secret",
        ordinaryLongValue: longBody,
        file: {
          name: "safe.txt",
          mimeType: "text/plain",
          size: 3,
          content: new Uint8Array([1, 2, 3]),
        },
        upload: {
          content: uploadBase64,
          decoded: decodedUpload,
        },
      },
    }) as Record<string, unknown>;

    expect(redacted.credentials).toBe(REDACTED);
    expect(redacted.headers).toEqual({
      Authorization: REDACTED,
      Cookie: REDACTED,
    });
    expect(redacted.idempotencyKey).toBe(REDACTED);
    expect(redacted.input).toMatch(/^\[REDACTED:body:/u);
    expect(redacted.output).toBe("[REDACTED:body:2000 bytes]");
    expect(redacted.nested).toEqual({
      signingSecret: "[REDACTED:whse…]",
      ingestUrl: REDACTED,
      ordinaryLongValue: "[REDACTED:long-string:2000 bytes]",
      file: {
        name: "safe.txt",
        mimeType: "text/plain",
        size: 3,
        content: "[REDACTED:body:3 bytes]",
      },
      upload: {
        content: `[REDACTED:body:${Buffer.byteLength(uploadBase64)} bytes]`,
        decoded: `[REDACTED:binary:${decodedUpload.byteLength} bytes]`,
      },
    });
    const serialized = JSON.stringify(redacted);
    for (const secret of [
      ACCESS_TOKEN,
      INPUT_SECRET,
      WEBHOOK_SECRET,
      "refresh-top-secret",
      "cookie-top-secret",
      "idempotency-top-secret",
      "url-top-secret",
      uploadBase64,
      "file-telemetry-sentinel",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("emits parseable JSON execution lifecycle lines with safe operational fields", async () => {
    const lines: string[] = [];
    const logger = createJsonLineLogger({
      clock,
      sink: (line) => lines.push(line),
    });
    const telemetry = createExecutorTelemetryRuntime(
      { logger },
      { NODE_ENV: "test" },
    );
    const webhookDeliverer = await createWebhookHarness(telemetry);
    const result = await execute(createEngine(telemetry, webhookDeliverer));
    await webhookDeliverer.onIdle();

    expect(result.response.status).toBe("succeeded");
    const events = lines.map(
      (line) =>
        JSON.parse(line) as {
          level: string;
          ts: string;
          msg: string;
          fields: Record<string, unknown>;
        },
    );
    expect(events.map((event) => event.msg)).toEqual([
      "execution.received",
      "execution.dispatched",
      "execution.terminal",
      "queue.job_finished",
      "webhook.delivery_attempt",
      "queue.job_finished",
    ]);
    expect(events[0]).toEqual({
      level: "info",
      ts: STARTED_AT,
      msg: "execution.received",
      fields: {
        executionId: "exe_telemetry1",
        tool: TOOL,
        projectId: PROJECT_ID,
        mode: "sync",
        inputSizeBytes: expect.any(Number),
        inputSchemaValid: true,
        replayed: false,
      },
    });
    expect(events[2]?.fields).toMatchObject({
      status: "succeeded",
      outputSchemaValid: true,
    });
    expect(events[3]?.fields).toMatchObject({
      kind: "webhook.select.v1",
      queueName: "webhook-selection",
      leaseAttempt: 1,
      result: "complete",
    });
    expect(events[4]?.fields).toEqual({
      endpointId: "whe_telemetry",
      attempt: 1,
      status: "succeeded",
      statusCode: 204,
    });
    expect(events[5]?.fields).toMatchObject({
      kind: "webhook.deliver.v1",
      queueName: "webhook-delivery",
      leaseAttempt: 1,
      result: "complete",
    });
    const serialized = lines.join("\n");
    expect(serialized).not.toContain(INPUT_SECRET);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
  });

  it("records an execution span tree, provider HTTP span, and webhook attempt without sensitive attributes", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const telemetry = createExecutorTelemetryRuntime(
      {
        tracer: provider.getTracer("eyeball-telemetry-test"),
        logger: noopLogger,
      },
      { NODE_ENV: "test" },
    );
    const webhookDeliverer = await createWebhookHarness(telemetry);

    await execute(createEngine(telemetry, webhookDeliverer));
    await expect(
      createEngine(telemetry).execute({
        projectId: PROJECT_ID,
        request: {
          tool: UNTRUSTED_TOOL,
          userId: USER_ID,
          input: { message: INPUT_SECRET },
          mode: "sync",
        },
      }),
    ).rejects.toMatchObject({ code: "not_supported" });
    const app = createExecutorApp({ engine: createEngine(telemetry) });
    const ingest = await app.request(
      `/v1/ingest/${UNTRUSTED_SUBSCRIPTION_ID}/trgsec_private`,
      { method: "POST", body: "{}" },
    );
    expect(ingest.status).toBe(404);
    await webhookDeliverer.onIdle();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const names = spans.map((span) => span.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "eyeball.execute",
        "eyeball.execute.validate",
        "eyeball.execute.idempotency",
        "eyeball.execute.credentials",
        "eyeball.execute.adapter-dispatch",
        "eyeball.adapter.http",
        "eyeball.execute.normalize",
        "eyeball.execute.store",
        "eyeball.webhook.delivery_attempt",
      ]),
    );
    const root = spans.find((span) => span.name === "eyeball.execute");
    const dispatch = spans.find(
      (span) => span.name === "eyeball.execute.adapter-dispatch",
    );
    const http = spans.find((span) => span.name === "eyeball.adapter.http");
    const triggerIngest = spans.find(
      (span) => span.name === "eyeball.trigger.ingest",
    );
    expect(root?.parentSpanContext).toBeUndefined();
    expect(root?.attributes).toMatchObject({
      "eyeball.execution.id": "exe_telemetry1",
      "eyeball.project.id": PROJECT_ID,
      "eyeball.tool": TOOL,
      "eyeball.execution.status": "succeeded",
    });
    for (const childName of [
      "eyeball.execute.validate",
      "eyeball.execute.idempotency",
      "eyeball.execute.credentials",
      "eyeball.execute.adapter-dispatch",
      "eyeball.execute.normalize",
    ]) {
      const child = spans.find((span) => span.name === childName);
      expect(child?.parentSpanContext?.spanId, childName).toBe(
        root?.spanContext().spanId,
      );
    }
    expect(http?.parentSpanContext?.spanId).toBe(
      dispatch?.spanContext().spanId,
    );
    expect(http?.attributes).toMatchObject({
      "eyeball.toolkit": "echo",
      "eyeball.operation": "run",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "server.address": "provider.example.test",
    });
    expect(triggerIngest?.attributes).not.toHaveProperty(
      "eyeball.trigger.subscription.id",
    );
    const serialized = JSON.stringify(
      spans.map((span) => ({ name: span.name, attributes: span.attributes })),
    );
    for (const secret of [
      INPUT_SECRET,
      ACCESS_TOKEN,
      WEBHOOK_SECRET,
      "query-secret",
      UNTRUSTED_TOOL,
      UNTRUSTED_SUBSCRIPTION_ID,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    await provider.shutdown();
  });

  it("increments execution, delivery, admission, and outbox metrics in memory", async () => {
    const reader = new InMemoryMetricReader();
    const provider = new MeterProvider({ readers: [reader] });
    const telemetry = createExecutorTelemetryRuntime(
      {
        meter: provider.getMeter("eyeball-telemetry-test"),
        logger: noopLogger,
      },
      { NODE_ENV: "test" },
    );
    const webhookDeliverer = await createWebhookHarness(telemetry);

    await execute(createEngine(telemetry, webhookDeliverer));
    await webhookDeliverer.onIdle();
    telemetry.recordTriggerEvent("gmail.email_received", true);
    telemetry.recordRateLimitRejection("daily_execution_quota");
    telemetry.recordUsageReservation("allowed");
    telemetry.recordUsageReservation("fail_open");
    telemetry.recordUsageReport("accepted", 2);
    telemetry.recordUsageReport("duplicate");
    telemetry.recordUsageReport("failed");
    telemetry.setUsageOutboxDepth(3);

    const { resourceMetrics, errors } = await reader.snapshot();
    expect(errors).toEqual([]);
    const executions = findMetric(resourceMetrics, "executions_total");
    expect(executions.dataPointType).toBe(DataPointType.SUM);
    expect(executions.dataPoints).toContainEqual(
      expect.objectContaining({
        attributes: { tool: TOOL, status: "succeeded" },
        value: 1,
      }),
    );
    const latency = findMetric(resourceMetrics, "execution_latency_ms");
    expect(latency.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(latency.dataPoints[0]).toEqual(
      expect.objectContaining({
        attributes: { tool: TOOL },
        value: expect.objectContaining({ count: 1 }),
      }),
    );
    for (const [name, attributes] of [
      ["webhook_delivery_attempts_total", { status: "succeeded" }],
      [
        "trigger_events_total",
        { trigger: "gmail.email_received", deduped: true },
      ],
      ["rate_limit_rejections_total", { bucket: "daily_execution_quota" }],
    ] as const) {
      expect(findMetric(resourceMetrics, name).dataPoints).toContainEqual(
        expect.objectContaining({ attributes, value: 1 }),
      );
    }
    expect(
      findMetric(resourceMetrics, "usage_reservations_total").dataPoints,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: { outcome: "allowed" },
          value: 1,
        }),
        expect.objectContaining({
          attributes: { outcome: "fail_open" },
          value: 1,
        }),
      ]),
    );
    expect(
      findMetric(resourceMetrics, "usage_reports_total").dataPoints,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: { outcome: "accepted" },
          value: 2,
        }),
        expect.objectContaining({
          attributes: { outcome: "duplicate" },
          value: 1,
        }),
        expect.objectContaining({
          attributes: { outcome: "failed" },
          value: 1,
        }),
      ]),
    );
    const outboxDepth = findMetric(resourceMetrics, "usage_outbox_depth");
    expect(outboxDepth.dataPointType).toBe(DataPointType.GAUGE);
    expect(outboxDepth.dataPoints).toContainEqual(
      expect.objectContaining({ attributes: {}, value: 3 }),
    );
    await provider.shutdown();
  });

  it("records bounded HTTP request metrics without paths, keys, or payloads", async () => {
    const reader = new InMemoryMetricReader();
    const provider = new MeterProvider({ readers: [reader] });
    const telemetry = createExecutorTelemetryRuntime(
      {
        meter: provider.getMeter("eyeball-http-telemetry-test"),
        logger: noopLogger,
      },
      { NODE_ENV: "test" },
    );
    const apiKey = "ey_http_metrics_top_secret";
    const app = createExecutorApp({
      engine: createEngine(telemetry),
      apiKeys: { [apiKey]: PROJECT_ID },
      requestIdFactory: () => "req_http_telemetry",
    });

    expect((await app.request("/health")).status).toBe(200);
    const execution = await app.request("/v1/execute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tool: TOOL,
        userId: USER_ID,
        input: { message: INPUT_SECRET },
        mode: "sync",
      }),
    });
    expect(execution.status).toBe(200);

    const { resourceMetrics, errors } = await reader.snapshot();
    expect(errors).toEqual([]);
    const requests = findMetric(resourceMetrics, "http_requests_total");
    expect(requests.dataPoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: {
            request_class: "health",
            method: "GET",
            status_code: 200,
          },
          value: 1,
        }),
        expect.objectContaining({
          attributes: {
            request_class: "execute",
            method: "POST",
            status_code: 200,
          },
          value: 1,
        }),
      ]),
    );
    const durations = findMetric(resourceMetrics, "http_request_duration_ms");
    expect(durations.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(durations.dataPoints).toHaveLength(2);
    const serialized = JSON.stringify({ requests, durations });
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(INPUT_SECRET);
    expect(serialized).not.toContain("/v1/execute");

    await provider.shutdown();
  });

  it("keeps the OpenTelemetry SDK and exporters disabled unless explicitly enabled", async () => {
    const setup = await initializeOpenTelemetry({ NODE_ENV: "test" });
    expect(setup).toMatchObject({ enabled: false });
    expect(setup.tracer).toBeUndefined();
    expect(setup.meter).toBeUndefined();

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const telemetry = createExecutorTelemetryRuntime(
      { logger: noopLogger },
      { NODE_ENV: "test" },
    );
    await execute(createEngine(telemetry));
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()).toEqual([]);

    await setup.shutdown();
    await provider.shutdown();
  });
});
