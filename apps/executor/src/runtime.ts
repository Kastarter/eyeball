import { randomUUID } from "node:crypto";
import { defaultCatalog } from "@eyeball/catalog";
import { type CredentialProvider, EyeballError } from "@eyeball/core";
import {
  type AgentStore,
  defaultToolkitAdapters,
  InMemoryAgentStore,
  RemoteVoiceSessionDriver,
  TwilioAdapter,
  VoiceAgentsAdapter,
  type VoiceSessionGrantIssuer,
  type VoiceSessionObservationLifecycle,
  voiceWorkerTokenFromEnv,
  voiceWorkerUrlFromEnv,
} from "@eyeball/toolkits";
import { AdapterRegistry, type Clock, systemClock } from "./adapters/index.js";
import {
  type ApiKeyAuthenticator,
  createConfiguredApiKeyAuthenticator,
} from "./api-key-authenticator.js";
import { createConfiguredCredentialProvider } from "./credential-provider.js";
import { ExecutionEngine, type RuntimeCatalog } from "./engine.js";
import {
  createExecutorJobHandlerRegistry,
  ExecutorTaskSystem,
  InMemoryJobStore,
  type JobStore,
  recoverExecutorJobs,
} from "./queue.js";
import type { FileStore } from "./staged-files.js";
import {
  createPgStoreBundle,
  type PostgresStoreSet,
} from "./stores/postgres/factory.js";
import {
  createExecutorTelemetryRuntime,
  type ExecutorTelemetry,
  initializeOpenTelemetry,
} from "./telemetry/index.js";
import {
  InMemoryTriggerEventStore,
  type TriggerEventStore,
} from "./triggers/event-store.js";
import { TriggerPollingScheduler, TriggerService } from "./triggers/service.js";
import {
  CloudUsageClient,
  CloudUsageGate,
  cloudUsageConfiguration,
  InMemoryUsageOutboxStore,
  UsageOutboxFlusher,
  type UsageOutboxStore,
} from "./usage/index.js";
import {
  InMemoryVoiceSessionObserverStore,
  RemoteVoiceSessionObserver,
} from "./voice/index.js";
import {
  createConfiguredVoiceSessionGrantAuthority,
  type VoiceSessionGrantVerifier,
} from "./voice-session-grants.js";
import { WebhookDeliverer } from "./webhooks/deliverer.js";
import { InMemoryVoiceWebhookSourceStore } from "./webhooks/memory-voice-source-store.js";

export interface CreateExecutorRuntimeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  catalog?: RuntimeCatalog;
  credentialProvider?: CredentialProvider;
  apiKeyAuthenticator?: ApiKeyAuthenticator;
  /** In-process test/deployment seam shared by remote composition and adapters. */
  fetchImpl?: typeof fetch;
  telemetry?: ExecutorTelemetry;
  clock?: Clock;
  /** Test/deployment seam; the stock factory uses pg with a five-connection pool. */
  persistenceFactory?: (
    connectionString: string,
  ) => Promise<ExecutorPersistence>;
  /** Constructs the worker over the already-selected memory or Postgres store. */
  taskQueueFactory?: (input: {
    readonly jobStore: JobStore;
    readonly clock?: Clock;
    readonly telemetry: ReturnType<typeof createExecutorTelemetryRuntime>;
    readonly durable: boolean;
  }) => ExecutorTaskSystem;
  /** Test/deployment seam; durable file cleanup defaults to once per minute. */
  fileSweepIntervalMs?: number;
  /** Test/deployment seam; trigger-event cleanup defaults to once per minute. */
  triggerEventSweepIntervalMs?: number;
}

export interface ExecutorPersistence extends PostgresStoreSet {
  close(): Promise<void>;
}

export interface ExecutorRuntime {
  engine: ExecutionEngine;
  apiKeyAuthenticator: ApiKeyAuthenticator;
  voiceSessionGrantVerifier?: VoiceSessionGrantVerifier;
  triggerPollingScheduler: TriggerPollingScheduler;
  persistence?: ExecutorPersistence;
  usageOutboxFlusher?: UsageOutboxFlusher;
  voiceSessionObserver?: RemoteVoiceSessionObserver;
  close(): Promise<void>;
}

interface ConfiguredUsage {
  readonly gate: CloudUsageGate;
  readonly flusher: UsageOutboxFlusher;
  readonly drainTimeoutMs: number;
}

const FILE_SWEEP_BATCH_SIZE = 100;
const DEFAULT_FILE_SWEEP_INTERVAL_MS = 60_000;
const TRIGGER_EVENT_SWEEP_BATCH_SIZE = 100;
const DEFAULT_TRIGGER_EVENT_SWEEP_INTERVAL_MS = 60_000;

interface FileExpirySweeper {
  stop(): void;
  onIdle(): Promise<void>;
}

interface TriggerEventExpirySweeper {
  stop(): void;
  onIdle(): Promise<void>;
}

function fileSweepNow(clock: Clock): string {
  const now = clock.now();
  if (Number.isNaN(now.valueOf())) {
    throw new Error("Executor clock returned an invalid date.");
  }
  return now.toISOString();
}

async function sweepExpiredFiles(
  fileStore: FileStore,
  now: string,
  drain: boolean,
): Promise<void> {
  for (;;) {
    const deleted = await fileStore.sweepExpired({
      now,
      limit: FILE_SWEEP_BATCH_SIZE,
    });
    if (!drain || deleted < FILE_SWEEP_BATCH_SIZE) return;
  }
}

function startFileExpirySweeper(input: {
  fileStore: FileStore;
  clock: Clock;
  intervalMs: number;
  logger: ReturnType<typeof createExecutorTelemetryRuntime>["logger"];
}): FileExpirySweeper {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1) {
    throw new RangeError(
      "File expiry sweep interval must be a positive safe integer.",
    );
  }
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active !== undefined) return;
    const pending = Promise.resolve()
      .then(() =>
        sweepExpiredFiles(input.fileStore, fileSweepNow(input.clock), false),
      )
      .catch((error: unknown) => {
        input.logger.error("file.expiry_sweep_failed", {
          errorName: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        if (active === pending) active = undefined;
      });
    active = pending;
  }, input.intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    onIdle: async () => {
      await active;
    },
  };
}

async function sweepExpiredTriggerEvents(
  eventStore: TriggerEventStore,
  now: string,
  drain: boolean,
): Promise<void> {
  for (;;) {
    const deleted = await eventStore.sweepExpired({
      now,
      limit: TRIGGER_EVENT_SWEEP_BATCH_SIZE,
    });
    if (!drain || deleted < TRIGGER_EVENT_SWEEP_BATCH_SIZE) return;
  }
}

function startTriggerEventExpirySweeper(input: {
  eventStore: TriggerEventStore;
  clock: Clock;
  intervalMs: number;
  logger: ReturnType<typeof createExecutorTelemetryRuntime>["logger"];
}): TriggerEventExpirySweeper {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1) {
    throw new RangeError(
      "Trigger event expiry sweep interval must be a positive safe integer.",
    );
  }
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active !== undefined) return;
    const pending = Promise.resolve()
      .then(() =>
        sweepExpiredTriggerEvents(
          input.eventStore,
          fileSweepNow(input.clock),
          true,
        ),
      )
      .catch((error: unknown) => {
        input.logger.error("trigger_event.expiry_sweep_failed", {
          errorName: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        if (active === pending) active = undefined;
      });
    active = pending;
  }, input.intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    onIdle: async () => {
      await active;
    },
  };
}

async function drainRuntime(
  taskSystem: ExecutorTaskSystem,
  triggerPollingScheduler: TriggerPollingScheduler,
): Promise<void> {
  await taskSystem.stopClaiming();
  await triggerPollingScheduler.onIdle();
  await taskSystem.drainOwned();
  await taskSystem.handoffPending();
  await taskSystem.onIdle();
}

function configuredUsage(
  env: Readonly<Record<string, string | undefined>>,
  store: UsageOutboxStore,
  telemetry: ReturnType<typeof createExecutorTelemetryRuntime>,
  fetchImpl: typeof fetch | undefined,
  clock: Clock | undefined,
): ConfiguredUsage | undefined {
  const configuration = cloudUsageConfiguration(env);
  if (configuration === undefined) return undefined;
  const client = new CloudUsageClient({
    baseUrl: configuration.baseUrl,
    internalApiSecret: configuration.internalApiSecret,
    timeoutMs: configuration.timeoutMs,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const gate = new CloudUsageGate({
    client,
    outboxStore: store,
    telemetry,
    strict: configuration.strict,
    ...(clock === undefined ? {} : { clock }),
  });
  const flusher = new UsageOutboxFlusher({
    client,
    store,
    telemetry,
    intervalMs: configuration.flushIntervalMs,
    alertAfterAttempts: configuration.alertAfterAttempts,
    ...(clock === undefined ? {} : { clock }),
  });
  const hostedComposition = env.EYEBALL_CREDENTIALS?.trim() === "cloud";
  const explicitRelaxation =
    hostedComposition &&
    configuration.strictSource === "explicit_override" &&
    !configuration.strict;
  const enforcementMetadata = {
    enforcementMode: configuration.strict ? "strict" : "fail_open",
    resolution: configuration.strictSource,
    hostedComposition,
    explicitRelaxation,
  } as const;
  if (explicitRelaxation) {
    telemetry.logger.warn("usage.enforcement_configured", enforcementMetadata);
  } else {
    telemetry.logger.info("usage.enforcement_configured", enforcementMetadata);
  }
  return {
    gate,
    flusher,
    drainTimeoutMs: configuration.drainTimeoutMs,
  };
}

function configuredVoiceWorker(
  catalog: RuntimeCatalog,
  agentStore: AgentStore,
  driver: RemoteVoiceSessionDriver | undefined,
  observationLifecycle: VoiceSessionObservationLifecycle | undefined,
  voiceSessionGrantIssuer?: VoiceSessionGrantIssuer,
): {
  adapters: AdapterRegistry;
  driver?: RemoteVoiceSessionDriver;
  bind(engine: ExecutionEngine): void;
} {
  let engine: ExecutionEngine | undefined;
  const voiceAgents = new VoiceAgentsAdapter({
    store: agentStore,
    ...(driver === undefined ? {} : { sessionDriver: driver }),
    ...(observationLifecycle === undefined
      ? {}
      : { remoteObservationLifecycle: observationLifecycle }),
    resolveTool: (name) => catalog.getTool(name),
    executeProviderTool: async (request) => {
      if (engine === undefined) {
        throw new Error(
          "Voice provider executor was used before runtime binding.",
        );
      }
      const outcome = await engine.execute({
        projectId: request.projectId,
        idempotencyKey: `voice-provider-${randomUUID()}`,
        request: {
          tool: request.tool,
          userId: request.userId,
          connectionId: request.connectionId,
          input: request.input,
          mode: "sync",
        },
      });
      const response = outcome.response;
      if (response.status === "succeeded") return response.output;
      if (response.status === "failed" || response.status === "cancelled") {
        throw new EyeballError({
          code: response.error.code,
          message: response.error.message,
          retryable: response.error.retryable,
          ...(response.error.retryAfter === undefined
            ? {}
            : { retryAfter: response.error.retryAfter }),
          ...(response.error.provider === undefined
            ? {}
            : { providerDetail: response.error.provider }),
        });
      }
      throw new Error(
        `Nested synchronous provider execution returned ${response.status}.`,
      );
    },
    ...(voiceSessionGrantIssuer === undefined
      ? {}
      : { voiceSessionGrantIssuer }),
  });
  const twilio = new TwilioAdapter({ bindingLookup: agentStore });
  return {
    adapters: new AdapterRegistry(
      defaultToolkitAdapters.map((adapter) => {
        if (adapter.toolkitSlug === "voice-agents") return voiceAgents;
        if (adapter.toolkitSlug === "twilio") return twilio;
        return adapter;
      }),
    ),
    ...(driver === undefined ? {} : { driver }),
    bind: (boundEngine) => {
      engine = boundEngine;
    },
  };
}

/**
 * Builds the stock executor runtime. EYEBALL_DATABASE_URL enables the pg-backed
 * stores and runs committed migrations before the engine becomes available.
 */
export async function createExecutorRuntime(
  options: CreateExecutorRuntimeOptions = {},
): Promise<ExecutorRuntime> {
  const env = options.env ?? process.env;
  const catalog = options.catalog ?? defaultCatalog;
  const credentialProvider =
    options.credentialProvider ??
    createConfiguredCredentialProvider({
      env,
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
    });
  const apiKeyAuthenticator =
    options.apiKeyAuthenticator ??
    createConfiguredApiKeyAuthenticator({
      env,
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
    });
  const otel = await initializeOpenTelemetry(env);
  const configuredTracer = options.telemetry?.tracer ?? otel.tracer;
  const configuredMeter = options.telemetry?.meter ?? otel.meter;
  const telemetry = createExecutorTelemetryRuntime(
    {
      ...options.telemetry,
      ...(configuredTracer === undefined ? {} : { tracer: configuredTracer }),
      ...(configuredMeter === undefined ? {} : { meter: configuredMeter }),
    },
    env,
  );
  const databaseUrl = env.EYEBALL_DATABASE_URL?.trim();
  let persistence: ExecutorPersistence | undefined;
  let taskSystem: ExecutorTaskSystem | undefined;
  let usage: ConfiguredUsage | undefined;
  let fileExpirySweeper: FileExpirySweeper | undefined;
  let triggerEventExpirySweeper: TriggerEventExpirySweeper | undefined;
  let voiceWorker: ReturnType<typeof configuredVoiceWorker> | undefined;
  let voiceSessionObserver: RemoteVoiceSessionObserver | undefined;
  try {
    const durable = databaseUrl !== undefined && databaseUrl.length > 0;
    if (durable) {
      persistence = await (
        options.persistenceFactory ??
        ((connectionString: string) =>
          createPgStoreBundle({ connectionString, maxConnections: 5 }))
      )(databaseUrl);
    }
    const initializedPersistence = persistence;
    const agentStore =
      initializedPersistence?.agentStore ?? new InMemoryAgentStore();
    const clock = options.clock ?? systemClock;
    const triggerEventStore =
      initializedPersistence?.triggerEventStore ??
      new InMemoryTriggerEventStore();
    const voiceSessionGrantAuthority =
      createConfiguredVoiceSessionGrantAuthority({
        env,
        store: agentStore,
        clock,
      });
    telemetry.logger.info("voice.execution_auth_configured", {
      voiceWorkerExecutionAuthMode:
        voiceSessionGrantAuthority === undefined
          ? "static_pinned"
          : "session_grant",
      grantStateDurability: durable ? "postgres" : "process_local",
      observerStateDurability: durable ? "postgres" : "process_local",
    });
    if (initializedPersistence !== undefined) {
      await sweepExpiredFiles(
        initializedPersistence.fileStore,
        fileSweepNow(clock),
        true,
      );
      await sweepExpiredTriggerEvents(
        triggerEventStore,
        fileSweepNow(clock),
        true,
      );
    }
    const jobStore = initializedPersistence?.jobStore ?? new InMemoryJobStore();
    taskSystem =
      options.taskQueueFactory?.({
        jobStore,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        telemetry,
        durable,
      }) ??
      new ExecutorTaskSystem({
        jobStore,
        clock,
        logger: telemetry.logger,
        durable,
      });
    if (taskSystem.jobStore !== jobStore) {
      throw new Error(
        "The task queue factory must use the runtime-selected job store.",
      );
    }
    usage = configuredUsage(
      env,
      initializedPersistence?.usageOutboxStore ??
        new InMemoryUsageOutboxStore(),
      telemetry,
      options.fetchImpl,
      options.clock,
    );
    const webhookDeliverer = new WebhookDeliverer({
      queue: taskSystem,
      voiceSourceStore:
        initializedPersistence?.voiceWebhookSourceStore ??
        new InMemoryVoiceWebhookSourceStore(),
      ...(initializedPersistence === undefined
        ? {}
        : {
            executionStore: initializedPersistence.executionStore,
            endpointStore: initializedPersistence.webhookEndpointStore,
            deliveryStore: initializedPersistence.webhookDeliveryStore,
            workStore: initializedPersistence.webhookWorkStore,
          }),
      telemetry,
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const workerUrl = voiceWorkerUrlFromEnv(env);
    const workerToken = voiceWorkerTokenFromEnv(env);
    const voiceDriver =
      workerUrl === undefined
        ? undefined
        : new RemoteVoiceSessionDriver({
            baseUrl: workerUrl,
            ...(options.fetchImpl === undefined
              ? {}
              : { fetch: options.fetchImpl }),
            ...(workerToken === undefined ? {} : { token: workerToken }),
          });
    voiceSessionObserver =
      voiceDriver === undefined
        ? undefined
        : new RemoteVoiceSessionObserver({
            store:
              initializedPersistence?.voiceObserverStore ??
              new InMemoryVoiceSessionObserverStore(),
            agentStore,
            driver: voiceDriver,
            webhookDeliverer,
            logger: telemetry.logger,
            clock,
          });
    const initializedVoiceWorker = configuredVoiceWorker(
      catalog,
      agentStore,
      voiceDriver,
      voiceSessionObserver,
      voiceSessionGrantAuthority?.issuer,
    );
    voiceWorker = initializedVoiceWorker;
    const triggerService = new TriggerService({
      catalog,
      credentialProvider,
      webhookDeliverer,
      ...(initializedPersistence === undefined
        ? {}
        : {
            subscriptionStore: initializedPersistence.triggerSubscriptionStore,
            stateStore: initializedPersistence.triggerStateStore,
          }),
      eventStore: triggerEventStore,
      telemetry,
      env,
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const engine = new ExecutionEngine({
      env,
      catalog,
      ...(initializedVoiceWorker.adapters === undefined
        ? {}
        : { adapters: initializedVoiceWorker.adapters }),
      credentialProvider,
      queue: taskSystem,
      ...(initializedPersistence === undefined
        ? {}
        : {
            store: initializedPersistence.executionStore,
            fileStore: initializedPersistence.fileStore,
          }),
      webhookDeliverer,
      triggerService,
      telemetryRuntime: telemetry,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(usage === undefined ? {} : { usageGate: usage.gate }),
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
    });
    initializedVoiceWorker.bind(engine);
    taskSystem.bindHandlers(
      createExecutorJobHandlerRegistry({ engine, webhookDeliverer }),
    );
    if (initializedPersistence !== undefined) {
      await recoverExecutorJobs({
        jobStore: initializedPersistence.jobStore,
        executionStore: initializedPersistence.executionStore,
        webhookWorkStore: initializedPersistence.webhookWorkStore,
        webhookDeliveryStore: initializedPersistence.webhookDeliveryStore,
        clock,
        logger: telemetry.logger,
        reconcileCancelledExecution: async ({ projectId, record }) => {
          await engine.reconcileTerminalExecution({ projectId, record });
        },
      });
    }
    triggerEventExpirySweeper = startTriggerEventExpirySweeper({
      eventStore: triggerEventStore,
      clock,
      intervalMs:
        options.triggerEventSweepIntervalMs ??
        DEFAULT_TRIGGER_EVENT_SWEEP_INTERVAL_MS,
      logger: telemetry.logger,
    });
    await voiceSessionObserver?.reconcileAtBoot();
    taskSystem.start();
    const runningTaskSystem = taskSystem;
    const triggerPollingScheduler = new TriggerPollingScheduler({
      service: engine.triggerService,
      logger: telemetry.logger,
    });
    usage?.flusher.start();
    if (initializedPersistence !== undefined) {
      fileExpirySweeper = startFileExpirySweeper({
        fileStore: initializedPersistence.fileStore,
        clock,
        intervalMs:
          options.fileSweepIntervalMs ?? DEFAULT_FILE_SWEEP_INTERVAL_MS,
        logger: telemetry.logger,
      });
    }
    return {
      engine,
      apiKeyAuthenticator,
      ...(voiceSessionGrantAuthority === undefined
        ? {}
        : { voiceSessionGrantVerifier: voiceSessionGrantAuthority.verifier }),
      triggerPollingScheduler,
      ...(initializedPersistence === undefined
        ? {}
        : { persistence: initializedPersistence }),
      ...(usage === undefined ? {} : { usageOutboxFlusher: usage.flusher }),
      ...(voiceSessionObserver === undefined ? {} : { voiceSessionObserver }),
      close: async () => {
        fileExpirySweeper?.stop();
        triggerEventExpirySweeper?.stop();
        triggerPollingScheduler.stop();
        usage?.flusher.stop();
        try {
          await fileExpirySweeper?.onIdle();
          await triggerEventExpirySweeper?.onIdle();
          await voiceSessionObserver?.close();
          await initializedVoiceWorker.driver?.close();
          await drainRuntime(runningTaskSystem, triggerPollingScheduler);
          await engine.usageGate.onIdle();
          if (usage !== undefined) {
            await usage.flusher.drain(usage.drainTimeoutMs);
          }
        } finally {
          try {
            await initializedPersistence?.close();
          } finally {
            await otel.shutdown();
          }
        }
      },
    };
  } catch (error) {
    fileExpirySweeper?.stop();
    triggerEventExpirySweeper?.stop();
    usage?.flusher.stop();
    await fileExpirySweeper?.onIdle();
    await triggerEventExpirySweeper?.onIdle();
    await taskSystem?.stopClaiming();
    await taskSystem?.drainOwned();
    await voiceSessionObserver?.close();
    await voiceWorker?.driver?.close();
    await persistence?.close();
    await otel.shutdown();
    throw error;
  }
}
