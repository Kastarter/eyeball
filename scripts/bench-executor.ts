#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createExecutorTelemetryRuntime } from "../apps/executor/src/telemetry/index.js";
import { WebhookDeliverer } from "../apps/executor/src/webhooks/deliverer.js";
import { InMemoryWebhookDeliveryStore } from "../apps/executor/src/webhooks/delivery-store.js";
import { InMemoryWebhookEndpointStore } from "../apps/executor/src/webhooks/endpoint-store.js";
import {
  type Clock,
  createExecutionId,
  createFileId,
  type ExecutionRecord,
  noopLogger,
} from "../packages/core/src/index.js";
import {
  createInProcessDevStack,
  type InProcessDevStackOptions,
  type InProcessDevStackRuntime,
} from "./dev-stack.js";

const DEFAULT_WARMUP_ITERATIONS = 200;
const DEFAULT_MEASURED_ITERATIONS = 2_000;
const MAX_CONCURRENCY = 32;
const RSS_ABORT_BYTES = 1_500 * 1024 * 1024;
const ATTACHMENT_BYTES = 1024 * 1024;
const RATE_LIMIT_CAPACITY = "1000000";
const FIXED_TIME = "2026-07-19T09:00:00.000Z";

const BENCHMARK_ENV = Object.freeze({
  NODE_ENV: "test",
  EYEBALL_OTEL: undefined,
  EYEBALL_RATE_LIMIT_REQUESTS_PER_MINUTE: RATE_LIMIT_CAPACITY,
  EYEBALL_RATE_LIMIT_REQUEST_BURST: RATE_LIMIT_CAPACITY,
  EYEBALL_RATE_LIMIT_EXECUTE_PER_MINUTE: RATE_LIMIT_CAPACITY,
  EYEBALL_RATE_LIMIT_EXECUTE_BURST: RATE_LIMIT_CAPACITY,
  EYEBALL_RATE_LIMIT_DAILY_EXECUTIONS: "off",
});

type BenchmarkPhase = "warmup" | "measured";

export interface ExecutorBenchmarkConfig {
  warmupIterations: number;
  measuredIterations: number;
  rssAbortBytes: number;
  attachmentBytes: number;
  captureVmStat: boolean;
  baselineDate: string;
}

export interface LatencySummary {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ExecutorBenchmarkScenario {
  id: string;
  label: string;
  concurrency: number;
  warmupIterations: number;
  measuredIterations: number;
  latencyMs: LatencySummary;
  throughputRps: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  rssDeltaBytes: number;
  rssPeakBytes: number;
  gcCount: number | null;
}

export interface StageTiming {
  stage: string;
  p50Microseconds: number;
  shareOfRootP50: number;
}

export interface StageAttribution {
  warmupIterations: number;
  measuredIterations: number;
  rootP50Microseconds: number;
  stages: StageTiming[];
  topCostCenter: string;
  note: string;
}

export interface VmStatSnapshot {
  afterScenario: string;
  capturedAt: string;
  available: boolean;
  pageSizeBytes?: number;
  pages?: Readonly<Record<string, number>>;
  processRssBytes: number;
  hostFreeMemoryBytes: number;
}

export interface ExecutorBenchmarkReport {
  schemaVersion: 1;
  baselineDate: string;
  generatedAt: string;
  methodology: "in-process app.request with in-process Mockhouse fetch injection";
  environment: {
    node: string;
    v8: string;
    platform: string;
    release: string;
    architecture: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryBytes: number;
    nodeOptions: string;
    attributionSdkVersion: string;
    otelEnabledForBaseline: false;
    gcObservable: boolean;
    maxInFlight: 32;
    rssAbortBytes: number;
    attachmentBytes: number;
    rateLimitOverrides: Readonly<Record<string, string>>;
  };
  scenarios: ExecutorBenchmarkScenario[];
  stageAttribution: StageAttribution;
  comparison: {
    syncExecuteP95Ms: number;
    rawMockP95Ms: number;
    estimatedAppLayerOverheadP95Ms: number;
  };
  vmStat: VmStatSnapshot[];
}

interface BenchmarkWorkload {
  operation(phase: BenchmarkPhase, index: number): Promise<void>;
  beforeBatch?(
    phase: BenchmarkPhase,
    firstIndex: number,
    batchSize: number,
  ): Promise<void> | void;
  afterWarmup?(): Promise<void>;
  settle?(): Promise<void>;
  teardown?(): Promise<void>;
  memorySampleEvery?: number;
}

interface ScenarioDefinition {
  id: string;
  label: string;
  concurrency: number;
  create(): Promise<BenchmarkWorkload>;
}

interface IterationRun {
  latencyMs: number[];
  hookNanoseconds: bigint;
  peakRssBytes: number;
}

class ManualClock implements Clock {
  #milliseconds = Date.parse(FIXED_TIME);

  now(): Date {
    return new Date(this.#milliseconds);
  }

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }
}

class GcCounter {
  readonly observable =
    (
      PerformanceObserver as unknown as {
        supportedEntryTypes?: readonly string[];
      }
    ).supportedEntryTypes?.includes("gc") ?? false;
  #count = 0;
  readonly #observer: PerformanceObserver | undefined;

  constructor() {
    if (!this.observable) return;
    this.#observer = new PerformanceObserver((list) => {
      this.#count += list.getEntries().length;
    });
    this.#observer.observe({ entryTypes: ["gc"] });
  }

  get count(): number {
    return this.#count;
  }

  disconnect(): void {
    this.#observer?.disconnect();
  }
}

function validatedInteger(
  value: number,
  name: string,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(
      `${name} must be a safe integer of at least ${minimum}.`,
    );
  }
  return value;
}

function validBaselineDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError("baselineDate must use YYYY-MM-DD format.");
  }
  return value;
}

export function createExecutorBenchmarkConfig(
  overrides: Partial<ExecutorBenchmarkConfig> = {},
): ExecutorBenchmarkConfig {
  return {
    warmupIterations: validatedInteger(
      overrides.warmupIterations ?? DEFAULT_WARMUP_ITERATIONS,
      "warmupIterations",
      0,
    ),
    measuredIterations: validatedInteger(
      overrides.measuredIterations ?? DEFAULT_MEASURED_ITERATIONS,
      "measuredIterations",
      1,
    ),
    rssAbortBytes: validatedInteger(
      overrides.rssAbortBytes ?? RSS_ABORT_BYTES,
      "rssAbortBytes",
      1,
    ),
    attachmentBytes: validatedInteger(
      overrides.attachmentBytes ?? ATTACHMENT_BYTES,
      "attachmentBytes",
      1,
    ),
    captureVmStat: overrides.captureVmStat ?? true,
    baselineDate: validBaselineDate(
      overrides.baselineDate ?? new Date().toISOString().slice(0, 10),
    ),
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function dependencyVersion(packageName: string): string {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve(`${packageName}/package.json`);
  const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version?: unknown;
  };
  if (typeof metadata.version !== "string") {
    throw new Error(`${packageName} package metadata omitted its version.`);
  }
  return metadata.version;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) throw new Error("Cannot summarize zero samples.");
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  const value = sorted[Math.min(index, sorted.length - 1)];
  if (value === undefined)
    throw new Error("Percentile index was out of bounds.");
  return value;
}

function summarizeLatency(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50: round(percentile(sorted, 0.5), 3),
    p95: round(percentile(sorted, 0.95), 3),
    p99: round(percentile(sorted, 0.99), 3),
    max: round(sorted.at(-1) ?? 0, 3),
  };
}

function currentRss(): number {
  return process.memoryUsage().rss;
}

function assertRssWithinLimit(limit: number, scenario: string): number {
  const rss = currentRss();
  if (rss > limit) {
    throw new Error(
      `${scenario} aborted: RSS ${rss} exceeded the ${limit}-byte safety ceiling.`,
    );
  }
  return rss;
}

function immediate(): Promise<void> {
  return new Promise((resolveImmediate) => setImmediate(resolveImmediate));
}

async function forceGarbageCollection(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc !== undefined) {
    gc();
    gc();
  }
  await immediate();
}

async function runIterations(options: {
  scenario: string;
  phase: BenchmarkPhase;
  count: number;
  concurrency: number;
  workload: BenchmarkWorkload;
  rssLimitBytes: number;
  collectLatency: boolean;
}): Promise<IterationRun> {
  if (
    options.concurrency < 1 ||
    options.concurrency > MAX_CONCURRENCY ||
    !Number.isInteger(options.concurrency)
  ) {
    throw new RangeError(
      `Concurrency must be between 1 and ${MAX_CONCURRENCY}.`,
    );
  }
  const latencyMs: number[] = [];
  let hookNanoseconds = 0n;
  let peakRssBytes = assertRssWithinLimit(
    options.rssLimitBytes,
    options.scenario,
  );
  const sampleEvery = Math.max(1, options.workload.memorySampleEvery ?? 25);
  for (let firstIndex = 0; firstIndex < options.count; ) {
    const batchSize = Math.min(options.concurrency, options.count - firstIndex);
    if (options.workload.beforeBatch !== undefined) {
      const hookStarted = process.hrtime.bigint();
      await options.workload.beforeBatch(options.phase, firstIndex, batchSize);
      hookNanoseconds += process.hrtime.bigint() - hookStarted;
    }
    await Promise.all(
      Array.from({ length: batchSize }, async (_unused, offset) => {
        const index = firstIndex + offset;
        const started = process.hrtime.bigint();
        await options.workload.operation(options.phase, index);
        const elapsed = process.hrtime.bigint() - started;
        if (options.collectLatency) {
          latencyMs.push(Number(elapsed) / 1_000_000);
        }
      }),
    );
    firstIndex += batchSize;
    if (firstIndex % sampleEvery === 0 || firstIndex === options.count) {
      peakRssBytes = Math.max(
        peakRssBytes,
        assertRssWithinLimit(options.rssLimitBytes, options.scenario),
      );
    }
  }
  return { latencyMs, hookNanoseconds, peakRssBytes };
}

async function measureScenario(
  definition: ScenarioDefinition,
  workload: BenchmarkWorkload,
  config: ExecutorBenchmarkConfig,
  gcCounter: GcCounter,
): Promise<ExecutorBenchmarkScenario> {
  await runIterations({
    scenario: definition.id,
    phase: "warmup",
    count: config.warmupIterations,
    concurrency: definition.concurrency,
    workload,
    rssLimitBytes: config.rssAbortBytes,
    collectLatency: false,
  });
  await workload.settle?.();
  await workload.afterWarmup?.();
  await forceGarbageCollection();

  const rssBeforeBytes = assertRssWithinLimit(
    config.rssAbortBytes,
    definition.id,
  );
  const gcBefore = gcCounter.count;
  const wallStarted = process.hrtime.bigint();
  const measured = await runIterations({
    scenario: definition.id,
    phase: "measured",
    count: config.measuredIterations,
    concurrency: definition.concurrency,
    workload,
    rssLimitBytes: config.rssAbortBytes,
    collectLatency: true,
  });
  const wallElapsed = process.hrtime.bigint() - wallStarted;
  await workload.settle?.();
  await immediate();
  const rssAfterBytes = assertRssWithinLimit(
    config.rssAbortBytes,
    definition.id,
  );
  const effectiveNanoseconds =
    wallElapsed > measured.hookNanoseconds
      ? wallElapsed - measured.hookNanoseconds
      : wallElapsed;

  return {
    id: definition.id,
    label: definition.label,
    concurrency: definition.concurrency,
    warmupIterations: config.warmupIterations,
    measuredIterations: config.measuredIterations,
    latencyMs: summarizeLatency(measured.latencyMs),
    throughputRps: round(
      config.measuredIterations /
        (Number(effectiveNanoseconds) / 1_000_000_000),
      1,
    ),
    rssBeforeBytes,
    rssAfterBytes,
    rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
    rssPeakBytes: Math.max(measured.peakRssBytes, rssAfterBytes),
    gcCount: gcCounter.observable ? gcCounter.count - gcBefore : null,
  };
}

function deterministicEngineOptions(
  scenario: string,
  extra: InProcessDevStackOptions["engineOptions"] = {},
): NonNullable<InProcessDevStackOptions["engineOptions"]> {
  let executionIndex = 0;
  let fileIndex = 0;
  const label = scenario.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
  return {
    executionIdFactory: () => {
      executionIndex += 1;
      return createExecutionId(
        `bench${label}${String(executionIndex).padStart(8, "0")}`,
      );
    },
    fileIdFactory: () => {
      fileIndex += 1;
      return createFileId(`bench${label}${String(fileIndex).padStart(8, "0")}`);
    },
    ...extra,
  };
}

async function benchmarkStack(
  scenario: string,
  engineOptions: InProcessDevStackOptions["engineOptions"] = {},
): Promise<InProcessDevStackRuntime> {
  return createInProcessDevStack({
    apiKey: `ey_bench_${scenario}`,
    projectId: `proj_bench_${scenario}`,
    userId: `user_bench_${scenario}`,
    env: BENCHMARK_ENV,
    engineOptions: deterministicEngineOptions(scenario, engineOptions),
  });
}

function authorization(
  stack: InProcessDevStackRuntime,
): Record<string, string> {
  return { Authorization: `Bearer ${stack.apiKey}` };
}

function resetGmailFixture(stack: InProcessDevStackRuntime): void {
  const gmail = stack.mockhouseProviders.find(({ slug }) => slug === "gmail");
  if (gmail === undefined) {
    throw new Error("In-process Mockhouse did not mount Gmail.");
  }
  gmail.reset();
}

function measuredKey(
  scenario: string,
  phase: BenchmarkPhase,
  index: number,
): string {
  return `bench:${scenario}:${phase}:${String(index).padStart(6, "0")}`;
}

async function responseObject(
  response: Response,
  expectedStatus: number,
  operation: string,
): Promise<Record<string, unknown>> {
  const body = (await response.json()) as unknown;
  if (
    response.status !== expectedStatus ||
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    throw new Error(
      `${operation} returned HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body as Record<string, unknown>;
}

async function executeGmail(options: {
  stack: InProcessDevStackRuntime;
  idempotencyKey: string;
  mode: "sync" | "async";
  attachments?: readonly Record<string, unknown>[];
}): Promise<Record<string, unknown>> {
  const response = await options.stack.executorApp.request("/v1/execute", {
    method: "POST",
    headers: {
      ...authorization(options.stack),
      "Content-Type": "application/json",
      "Idempotency-Key": options.idempotencyKey,
    },
    body: JSON.stringify({
      tool: "gmail.send_email",
      userId: options.stack.userId,
      mode: options.mode,
      input: {
        to: ["recipient@example.com"],
        subject: "Executor performance fixture",
        body: "Deterministic in-process Gmail execution fixture.",
        ...(options.attachments === undefined
          ? {}
          : { attachments: options.attachments }),
      },
    }),
  });
  return responseObject(
    response,
    options.mode === "sync" ? 200 : 202,
    `${options.mode} Gmail execute`,
  );
}

function assertSucceeded(
  body: Readonly<Record<string, unknown>>,
  label: string,
) {
  if (body.status !== "succeeded") {
    throw new Error(`${label} did not succeed: ${JSON.stringify(body)}`);
  }
}

function settleStack(stack: InProcessDevStackRuntime): Promise<void> {
  return Promise.all([
    stack.executorEngine.queue.onIdle(),
    stack.executorEngine.webhookDeliverer.onIdle(),
  ]).then(() => undefined);
}

function stackWorkload(
  stack: InProcessDevStackRuntime,
  operation: BenchmarkWorkload["operation"],
  extras: Omit<BenchmarkWorkload, "operation"> = {},
): BenchmarkWorkload {
  return {
    operation,
    settle: () => settleStack(stack),
    teardown: () => settleStack(stack),
    ...extras,
  };
}

function healthScenario(): ScenarioDefinition {
  return {
    id: "health_http_floor",
    label: "Health HTTP floor",
    concurrency: 1,
    async create() {
      const stack = await benchmarkStack("health");
      return stackWorkload(stack, async () => {
        const response = await stack.executorApp.request("/health");
        if (response.status !== 200) {
          throw new Error(`Health returned HTTP ${response.status}.`);
        }
        await response.arrayBuffer();
      });
    },
  };
}

function syncExecuteScenario(concurrency: 1 | 8 | 32): ScenarioDefinition {
  const id = `sync_execute_gmail_c${concurrency}`;
  return {
    id,
    label: `Sync Gmail execute (${concurrency} in flight)`,
    concurrency,
    async create() {
      const stack = await benchmarkStack(id);
      return stackWorkload(
        stack,
        async (phase, index) => {
          const body = await executeGmail({
            stack,
            idempotencyKey: measuredKey(id, phase, index),
            mode: "sync",
          });
          assertSucceeded(body, id);
        },
        { beforeBatch: () => resetGmailFixture(stack) },
      );
    },
  };
}

function replayScenario(): ScenarioDefinition {
  const id = "sync_idempotency_replay";
  const replayKey = "bench:sync-idempotency-replay:fixed";
  return {
    id,
    label: "Sync idempotency replay",
    concurrency: 1,
    async create() {
      const stack = await benchmarkStack("replay");
      assertSucceeded(
        await executeGmail({ stack, idempotencyKey: replayKey, mode: "sync" }),
        "replay seed",
      );
      return stackWorkload(
        stack,
        async () => {
          const body = await executeGmail({
            stack,
            idempotencyKey: replayKey,
            mode: "sync",
          });
          assertSucceeded(body, id);
        },
        { beforeBatch: () => resetGmailFixture(stack) },
      );
    },
  };
}

function asyncExecuteScenario(): ScenarioDefinition {
  const id = "async_submit_poll_terminal";
  return {
    id,
    label: "Async submit + terminal poll",
    concurrency: 1,
    async create() {
      const stack = await benchmarkStack("async");
      return stackWorkload(
        stack,
        async (phase, index) => {
          const submitted = await executeGmail({
            stack,
            idempotencyKey: measuredKey(id, phase, index),
            mode: "async",
          });
          const executionId = submitted.executionId;
          if (typeof executionId !== "string") {
            throw new Error("Async submit omitted executionId.");
          }
          for (let poll = 0; poll < 100; poll += 1) {
            const response = await stack.executorApp.request(
              `/v1/executions/${encodeURIComponent(executionId)}`,
              { headers: authorization(stack) },
            );
            const terminal = await responseObject(
              response,
              200,
              "async execution poll",
            );
            if (terminal.status === "succeeded") return;
            if (terminal.status === "failed") {
              throw new Error(
                `Async execution failed: ${JSON.stringify(terminal)}`,
              );
            }
            if (terminal.status === "cancelled") {
              throw new Error(
                `Async execution was cancelled: ${JSON.stringify(terminal)}`,
              );
            }
            await Promise.resolve();
          }
          throw new Error(
            "Async execution did not reach terminal within 100 polls.",
          );
        },
        { beforeBatch: () => resetGmailFixture(stack) },
      );
    },
  };
}

function attachmentScenario(
  config: ExecutorBenchmarkConfig,
): ScenarioDefinition {
  const id = "sync_execute_1mb_attachment";
  return {
    id,
    label: "Sync Gmail execute + 1 MiB staged file",
    concurrency: 1,
    async create() {
      const stack = await benchmarkStack("attachment");
      const bytes = Buffer.alloc(config.attachmentBytes, 0x61);
      const staged = await responseObject(
        await stack.executorApp.request("/v1/files", {
          method: "POST",
          headers: {
            ...authorization(stack),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "benchmark.bin",
            mimeType: "application/octet-stream",
            content: bytes.toString("base64"),
          }),
        }),
        201,
        "stage benchmark attachment",
      );
      const attachment = {
        fileId: staged.fileId,
        name: staged.name,
        mimeType: staged.mimeType,
      };
      return stackWorkload(
        stack,
        async (phase, index) => {
          const body = await executeGmail({
            stack,
            idempotencyKey: measuredKey(id, phase, index),
            mode: "sync",
            attachments: [attachment],
          });
          assertSucceeded(body, id);
        },
        {
          memorySampleEvery: 1,
          beforeBatch: () => resetGmailFixture(stack),
        },
      );
    },
  };
}

async function gmailConnectionId(
  stack: InProcessDevStackRuntime,
): Promise<string> {
  const response = await responseObject(
    await stack.executorApp.request("/v1/connections", {
      headers: authorization(stack),
    }),
    200,
    "list benchmark connections",
  );
  const connections = response.connections;
  if (!Array.isArray(connections)) {
    throw new Error("Connection list omitted connections.");
  }
  const gmail = connections.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "toolkit" in candidate &&
      candidate.toolkit === "gmail",
  );
  if (
    typeof gmail !== "object" ||
    gmail === null ||
    !("connectionId" in gmail) ||
    typeof gmail.connectionId !== "string"
  ) {
    throw new Error("Benchmark Gmail connection was not found.");
  }
  return gmail.connectionId;
}

function triggerPollScenario(): ScenarioDefinition {
  const id = "gmail_trigger_poll_tick";
  return {
    id,
    label: "Gmail trigger poll tick",
    concurrency: 1,
    async create() {
      const clock = new ManualClock();
      const stack = await benchmarkStack("trigger", { clock });
      const endpoint = await responseObject(
        await stack.executorApp.request("/v1/webhooks", {
          method: "POST",
          headers: {
            ...authorization(stack),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: "https://receiver.example.test/hook",
            events: ["trigger.gmail.email_received"],
          }),
        }),
        201,
        "create trigger benchmark endpoint",
      );
      const connectionId = await gmailConnectionId(stack);
      const subscription = await responseObject(
        await stack.executorApp.request("/v1/subscriptions", {
          method: "POST",
          headers: {
            ...authorization(stack),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            trigger: "gmail.email_received",
            userId: stack.userId,
            connectionId,
            webhookEndpointIds: [endpoint.endpointId],
            pollIntervalSeconds: 60,
          }),
        }),
        201,
        "create trigger benchmark subscription",
      );
      if (typeof subscription.subscriptionId !== "string") {
        throw new Error("Trigger benchmark subscription omitted its ID.");
      }
      return stackWorkload(
        stack,
        async () => {
          const result = await stack.executorEngine.triggerService.runDue();
          if (
            result.polled !== 1 ||
            result.emitted !== 0 ||
            result.failed !== 0
          ) {
            throw new Error(
              `Unexpected trigger poll result: ${JSON.stringify(result)}`,
            );
          }
        },
        { beforeBatch: () => clock.advance(60_000) },
      );
    },
  };
}

function webhookScenario(): ScenarioDefinition {
  const id = "webhook_delivery_attempt";
  return {
    id,
    label: "Signed webhook delivery attempt",
    concurrency: 1,
    async create() {
      const clock = new ManualClock();
      let eventIndex = 0;
      let deliveryIndex = 0;
      let received = 0;
      const endpointStore = new InMemoryWebhookEndpointStore({
        endpointIdFactory: () => "whe_benchmark",
        secretFactory: () => "whsec_benchmark_fixed_secret",
      });
      const deliveryStore = new InMemoryWebhookDeliveryStore({
        deliveryIdFactory: () => {
          deliveryIndex += 1;
          return `whd_benchmark_${String(deliveryIndex).padStart(8, "0")}`;
        },
      });
      const deliverer = new WebhookDeliverer({
        endpointStore,
        deliveryStore,
        clock,
        retryDelaysMs: [0],
        attemptConcurrency: 1,
        eventIdFactory: () => {
          eventIndex += 1;
          return `evt_benchmark_${String(eventIndex).padStart(8, "0")}`;
        },
        telemetry: createExecutorTelemetryRuntime(
          { logger: noopLogger },
          { NODE_ENV: "test" },
        ),
        fetchImpl: (async (input, init) => {
          const request = new Request(input, init);
          if (request.url !== "https://receiver.example.test/hook") {
            throw new Error(`Unexpected webhook receiver URL: ${request.url}`);
          }
          await request.text();
          received += 1;
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      });
      await endpointStore.create("proj_bench_webhook", {
        url: "https://receiver.example.test/hook",
        events: ["execution.completed"],
        active: true,
        createdAt: clock.now().toISOString(),
      });

      return {
        async operation(phase, index) {
          const before = received;
          const executionId = createExecutionId(
            `benchwebhook${phase}${String(index).padStart(8, "0")}`,
          );
          const record: ExecutionRecord = {
            executionId,
            tool: "gmail.send_email",
            toolVersion: "1.1.0",
            catalogVersion: "1.1",
            status: "succeeded",
            userId: "user_bench_webhook",
            createdAt: clock.now().toISOString(),
            startedAt: clock.now().toISOString(),
            completedAt: clock.now().toISOString(),
            output: {
              messageId: "gmail_msg_benchmark",
              acceptedRecipients: ["recipient@example.com"],
            },
            latencyMs: 1,
          };
          deliverer.enqueueExecution("proj_bench_webhook", record);
          await deliverer.onIdle();
          if (received !== before + 1) {
            throw new Error(
              "Webhook receiver did not observe exactly one attempt.",
            );
          }
          clock.advance(1_000);
        },
        settle: () => deliverer.onIdle(),
        teardown: () => deliverer.onIdle(),
      };
    },
  };
}

function rawMockScenario(): ScenarioDefinition {
  const id = "raw_mock_gmail_send";
  const raw = Buffer.from(
    [
      "From: sender@example.com",
      "To: recipient@example.com",
      "Subject: Executor performance fixture",
      "",
      "Deterministic raw Mockhouse control request.",
    ].join("\r\n"),
    "utf8",
  ).toString("base64url");
  return {
    id,
    label: "Raw in-process Gmail mock call",
    concurrency: 1,
    async create() {
      const stack = await benchmarkStack("rawmock");
      return stackWorkload(
        stack,
        async () => {
          const body = await responseObject(
            await stack.mockhouseApp.request(
              "/gmail/gmail/v1/users/me/messages/send",
              {
                method: "POST",
                headers: {
                  Authorization: "Bearer fixture:valid",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ raw }),
              },
            ),
            200,
            "raw Gmail mock send",
          );
          if (typeof body.id !== "string") {
            throw new Error("Raw Gmail mock response omitted message ID.");
          }
        },
        { beforeBatch: () => resetGmailFixture(stack) },
      );
    },
  };
}

function hrTimeMicroseconds(span: ReadableSpan): number {
  return span.duration[0] * 1_000_000 + span.duration[1] / 1_000;
}

function sumSpanDurations(
  spans: readonly ReadableSpan[],
  predicate: (span: ReadableSpan) => boolean,
): number {
  return spans.reduce(
    (total, span) => total + (predicate(span) ? hrTimeMicroseconds(span) : 0),
    0,
  );
}

function summarizeStageAttribution(
  spans: readonly ReadableSpan[],
  config: ExecutorBenchmarkConfig,
): StageAttribution {
  const roots = spans.filter((span) => span.name === "eyeball.execute");
  if (roots.length !== config.measuredIterations) {
    throw new Error(
      `Expected ${config.measuredIterations} execution roots, received ${roots.length}.`,
    );
  }
  const byTrace = new Map<string, ReadableSpan[]>();
  for (const span of spans) {
    const traceId = span.spanContext().traceId;
    const existing = byTrace.get(traceId);
    if (existing === undefined) byTrace.set(traceId, [span]);
    else existing.push(span);
  }

  const samples: Record<string, number[]> = {
    validate: [],
    idempotency: [],
    credentials: [],
    dispatch: [],
    normalize: [],
    store: [],
    unattributed: [],
  };
  const rootDurations: number[] = [];
  for (const root of roots) {
    const traceSpans = byTrace.get(root.spanContext().traceId) ?? [];
    const rootDuration = hrTimeMicroseconds(root);
    rootDurations.push(rootDuration);
    const validate = sumSpanDurations(
      traceSpans,
      (span) => span.name === "eyeball.execute.validate",
    );
    const idempotency = sumSpanDurations(
      traceSpans,
      (span) => span.name === "eyeball.execute.idempotency",
    );
    const credentialInclusive = sumSpanDurations(
      traceSpans,
      (span) => span.name === "eyeball.execute.credentials",
    );
    const credentialStore = sumSpanDurations(
      traceSpans,
      (span) =>
        span.name === "eyeball.execute.store" &&
        span.attributes["eyeball.store.operation"] === "set_connection",
    );
    const credentials = Math.max(0, credentialInclusive - credentialStore);
    const dispatch = sumSpanDurations(
      traceSpans,
      (span) => span.name === "eyeball.execute.adapter-dispatch",
    );
    const normalize = sumSpanDurations(
      traceSpans,
      (span) => span.name === "eyeball.execute.normalize",
    );
    const store = sumSpanDurations(
      traceSpans,
      (span) => span.name === "eyeball.execute.store",
    );
    const accounted =
      validate + idempotency + credentials + dispatch + normalize + store;
    samples.validate?.push(validate);
    samples.idempotency?.push(idempotency);
    samples.credentials?.push(credentials);
    samples.dispatch?.push(dispatch);
    samples.normalize?.push(normalize);
    samples.store?.push(store);
    samples.unattributed?.push(Math.max(0, rootDuration - accounted));
  }

  const rootP50Microseconds = percentile(
    rootDurations.sort((left, right) => left - right),
    0.5,
  );
  const stages = Object.entries(samples).map(([stage, values]) => {
    const p50Microseconds = percentile(
      values.sort((left, right) => left - right),
      0.5,
    );
    return {
      stage,
      p50Microseconds: round(p50Microseconds, 1),
      shareOfRootP50: round(
        rootP50Microseconds === 0
          ? 0
          : (p50Microseconds / rootP50Microseconds) * 100,
        1,
      ),
    };
  });
  const top = stages
    .filter(({ stage }) => stage !== "unattributed")
    .sort((left, right) => right.p50Microseconds - left.p50Microseconds)[0];
  if (top === undefined)
    throw new Error("Stage attribution produced no stages.");
  return {
    warmupIterations: config.warmupIterations,
    measuredIterations: config.measuredIterations,
    rootP50Microseconds: round(rootP50Microseconds, 1),
    stages,
    topCostCenter: top.stage,
    note: "OTel in-memory tracing is enabled only for attribution. Nested set_connection time is charged to store, not credentials; unattributed includes root-only orchestration and tracing overhead.",
  };
}

async function runStageAttribution(
  config: ExecutorBenchmarkConfig,
  gcCounter: GcCounter,
): Promise<{ attribution: StageAttribution; teardown(): Promise<void> }> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const telemetry = createExecutorTelemetryRuntime(
    {
      tracer: provider.getTracer("eyeball-executor-benchmark"),
      logger: noopLogger,
    },
    { NODE_ENV: "test" },
  );
  const stack = await benchmarkStack("attribution", {
    telemetryRuntime: telemetry,
  });
  const definition: ScenarioDefinition = {
    id: "stage_attribution_sync_execute",
    label: "Traced sync Gmail execute",
    concurrency: 1,
    create: async () => {
      throw new Error("Attribution workload is already constructed.");
    },
  };
  const workload = stackWorkload(
    stack,
    async (phase, index) => {
      const body = await executeGmail({
        stack,
        idempotencyKey: measuredKey("attribution", phase, index),
        mode: "sync",
      });
      assertSucceeded(body, "stage attribution");
    },
    {
      beforeBatch: () => resetGmailFixture(stack),
      async afterWarmup() {
        await provider.forceFlush();
        exporter.reset();
      },
    },
  );
  await measureScenario(definition, workload, config, gcCounter);
  await provider.forceFlush();
  const attribution = summarizeStageAttribution(
    exporter.getFinishedSpans(),
    config,
  );
  return {
    attribution,
    async teardown() {
      await workload.teardown?.();
      await provider.shutdown();
    },
  };
}

function vmStatSnapshot(
  afterScenario: string,
  enabled: boolean,
): VmStatSnapshot {
  const base = {
    afterScenario,
    capturedAt: new Date().toISOString(),
    processRssBytes: currentRss(),
    hostFreeMemoryBytes: freemem(),
  };
  if (!enabled || process.platform !== "darwin") {
    return { ...base, available: false };
  }
  try {
    const output = execFileSync("/usr/bin/vm_stat", [], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=2048",
        PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });
    const pageSize = Number(/page size of (\d+) bytes/u.exec(output)?.[1]);
    const pages: Record<string, number> = {};
    for (const line of output.split("\n")) {
      const match = /^Pages ([^:]+):\s+(\d+)\./u.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        pages[match[1].trim().replaceAll(" ", "_")] = Number(match[2]);
      }
    }
    return {
      ...base,
      available: Number.isFinite(pageSize),
      ...(Number.isFinite(pageSize) ? { pageSizeBytes: pageSize, pages } : {}),
    };
  } catch {
    return { ...base, available: false };
  }
}

function scenarioDefinitions(
  config: ExecutorBenchmarkConfig,
): ScenarioDefinition[] {
  return [
    healthScenario(),
    rawMockScenario(),
    syncExecuteScenario(1),
    replayScenario(),
    asyncExecuteScenario(),
    attachmentScenario(config),
    syncExecuteScenario(8),
    syncExecuteScenario(32),
    triggerPollScenario(),
    webhookScenario(),
  ];
}

export async function runExecutorBenchmark(
  overrides: Partial<ExecutorBenchmarkConfig> = {},
): Promise<ExecutorBenchmarkReport> {
  const config = createExecutorBenchmarkConfig(overrides);
  const gcCounter = new GcCounter();
  const scenarios: ExecutorBenchmarkScenario[] = [];
  const vmStat: VmStatSnapshot[] = [];
  try {
    await forceGarbageCollection();
    vmStat.push(vmStatSnapshot("start", config.captureVmStat));
    for (const definition of scenarioDefinitions(config)) {
      await forceGarbageCollection();
      let workload: BenchmarkWorkload | undefined = await definition.create();
      try {
        scenarios.push(
          await measureScenario(definition, workload, config, gcCounter),
        );
      } finally {
        await workload.teardown?.();
        workload = undefined;
      }
      await forceGarbageCollection();
      vmStat.push(vmStatSnapshot(definition.id, config.captureVmStat));
    }

    await forceGarbageCollection();
    const attributed = await runStageAttribution(config, gcCounter);
    let stageAttribution: StageAttribution;
    try {
      stageAttribution = attributed.attribution;
    } finally {
      await attributed.teardown();
    }
    await forceGarbageCollection();
    vmStat.push(vmStatSnapshot("stage_attribution", config.captureVmStat));

    const sync = scenarios.find(({ id }) => id === "sync_execute_gmail_c1");
    const raw = scenarios.find(({ id }) => id === "raw_mock_gmail_send");
    if (sync === undefined || raw === undefined) {
      throw new Error("Benchmark comparison scenarios are missing.");
    }
    const cpu = cpus();
    return {
      schemaVersion: 1,
      baselineDate: config.baselineDate,
      generatedAt: new Date().toISOString(),
      methodology:
        "in-process app.request with in-process Mockhouse fetch injection",
      environment: {
        node: process.version,
        v8: process.versions.v8,
        platform: platform(),
        release: release(),
        architecture: process.arch,
        cpuModel: cpu[0]?.model ?? "unknown",
        cpuCount: cpu.length,
        totalMemoryBytes: totalmem(),
        // biome-ignore lint/suspicious/noUndeclaredEnvVars: the report records the process launch guard rather than a task input.
        nodeOptions: process.env.NODE_OPTIONS ?? "",
        attributionSdkVersion: dependencyVersion(
          "@opentelemetry/sdk-trace-base",
        ),
        otelEnabledForBaseline: false,
        gcObservable: gcCounter.observable,
        maxInFlight: MAX_CONCURRENCY,
        rssAbortBytes: config.rssAbortBytes,
        attachmentBytes: config.attachmentBytes,
        rateLimitOverrides: {
          EYEBALL_RATE_LIMIT_REQUESTS_PER_MINUTE: RATE_LIMIT_CAPACITY,
          EYEBALL_RATE_LIMIT_REQUEST_BURST: RATE_LIMIT_CAPACITY,
          EYEBALL_RATE_LIMIT_EXECUTE_PER_MINUTE: RATE_LIMIT_CAPACITY,
          EYEBALL_RATE_LIMIT_EXECUTE_BURST: RATE_LIMIT_CAPACITY,
          EYEBALL_RATE_LIMIT_DAILY_EXECUTIONS: "off",
        },
      },
      scenarios,
      stageAttribution,
      comparison: {
        syncExecuteP95Ms: sync.latencyMs.p95,
        rawMockP95Ms: raw.latencyMs.p95,
        estimatedAppLayerOverheadP95Ms: round(
          Math.max(0, sync.latencyMs.p95 - raw.latencyMs.p95),
          3,
        ),
      },
      vmStat,
    };
  } finally {
    gcCounter.disconnect();
  }
}

function pad(value: string, width: number, alignRight = false): string {
  return alignRight ? value.padStart(width) : value.padEnd(width);
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function formatExecutorBenchmark(
  report: ExecutorBenchmarkReport,
): string {
  const headers = [
    "Scenario",
    "C",
    "p50 ms",
    "p95 ms",
    "p99 ms",
    "max ms",
    "req/s",
    "RSS Δ MiB",
    "RSS peak MiB",
    "GC",
  ];
  const rows = report.scenarios.map((scenario) => [
    scenario.label,
    String(scenario.concurrency),
    scenario.latencyMs.p50.toFixed(3),
    scenario.latencyMs.p95.toFixed(3),
    scenario.latencyMs.p99.toFixed(3),
    scenario.latencyMs.max.toFixed(3),
    scenario.throughputRps.toFixed(1),
    mib(scenario.rssDeltaBytes),
    mib(scenario.rssPeakBytes),
    scenario.gcCount === null ? "n/a" : String(scenario.gcCount),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (row: readonly string[]) =>
    row
      .map((value, index) =>
        pad(value, widths[index] ?? value.length, index > 0),
      )
      .join(" | ");
  const divider = widths.map((width) => "-".repeat(width)).join("-|- ");
  const stageRows = report.stageAttribution.stages
    .map(
      (stage) =>
        `${pad(stage.stage, 12)} | ${pad(stage.p50Microseconds.toFixed(1), 10, true)} µs | ${pad(`${stage.shareOfRootP50.toFixed(1)}%`, 7, true)}`,
    )
    .join("\n");
  return [
    `Executor baseline ${report.baselineDate}`,
    line(headers),
    divider,
    ...rows.map(line),
    "",
    `Stage attribution (root p50 ${report.stageAttribution.rootP50Microseconds.toFixed(1)} µs; top: ${report.stageAttribution.topCostCenter})`,
    "Stage        |     p50 µs |   share",
    "-------------|------------|--------",
    stageRows,
  ].join("\n");
}

export async function writeExecutorBenchmarkReport(
  report: ExecutorBenchmarkReport,
  outputPath: string,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function cliValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function cliInteger(name: string): number | undefined {
  const value = cliValue(name);
  return value === undefined ? undefined : Number(value);
}

async function main(): Promise<void> {
  const baselineDate = cliValue("date");
  const warmupIterations = cliInteger("warmup");
  const measuredIterations = cliInteger("iterations");
  const report = await runExecutorBenchmark({
    ...(baselineDate === undefined ? {} : { baselineDate }),
    ...(warmupIterations === undefined ? {} : { warmupIterations }),
    ...(measuredIterations === undefined ? {} : { measuredIterations }),
    captureVmStat: cliValue("vm-stat") !== "off",
  });
  const output = resolve(
    cliValue("output") ?? `docs/perf/baseline-${report.baselineDate}.json`,
  );
  await writeExecutorBenchmarkReport(report, output);
  process.stdout.write(
    `${formatExecutorBenchmark(report)}\n\nJSON: ${output}\n`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  await main();
}
