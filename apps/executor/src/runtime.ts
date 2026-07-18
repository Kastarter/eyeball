import { defaultCatalog } from "@eyeball/catalog";
import type { CredentialProvider } from "@eyeball/core";
import {
  defaultToolkitAdapters,
  RemoteVoiceSessionDriver,
  VoiceAgentsAdapter,
  voiceWorkerTokenFromEnv,
  voiceWorkerUrlFromEnv,
} from "@eyeball/toolkits";
import { AdapterRegistry } from "./adapters/index.js";
import { createConfiguredCredentialProvider } from "./credential-provider.js";
import { ExecutionEngine, type RuntimeCatalog } from "./engine.js";
import {
  createPgStoreBundle,
  type PostgresStoreSet,
} from "./stores/postgres/factory.js";
import {
  createExecutorTelemetryRuntime,
  type ExecutorTelemetry,
  initializeOpenTelemetry,
} from "./telemetry/index.js";
import { TriggerPollingScheduler, TriggerService } from "./triggers/service.js";
import { WebhookDeliverer } from "./webhooks/deliverer.js";

export interface CreateExecutorRuntimeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  catalog?: RuntimeCatalog;
  credentialProvider?: CredentialProvider;
  telemetry?: ExecutorTelemetry;
  /** Test/deployment seam; the stock factory uses pg with a five-connection pool. */
  persistenceFactory?: (
    connectionString: string,
  ) => Promise<ExecutorPersistence>;
}

export interface ExecutorPersistence extends PostgresStoreSet {
  close(): Promise<void>;
}

export interface ExecutorRuntime {
  engine: ExecutionEngine;
  triggerPollingScheduler: TriggerPollingScheduler;
  persistence?: ExecutorPersistence;
  close(): Promise<void>;
}

async function drainRuntime(
  engine: ExecutionEngine,
  triggerPollingScheduler: TriggerPollingScheduler,
): Promise<void> {
  await triggerPollingScheduler.onIdle();
  await engine.queue.onIdle();
  await engine.webhookDeliverer.onIdle();
}

function configuredVoiceWorker(
  env: Readonly<Record<string, string | undefined>>,
  catalog: RuntimeCatalog,
): {
  adapters?: AdapterRegistry;
  driver?: RemoteVoiceSessionDriver;
  bind(engine: ExecutionEngine): void;
} {
  const workerUrl = voiceWorkerUrlFromEnv(env);
  if (workerUrl === undefined) return { bind: () => undefined };

  let engine: ExecutionEngine | undefined;
  const token = voiceWorkerTokenFromEnv(env);
  const driver = new RemoteVoiceSessionDriver({
    baseUrl: workerUrl,
    ...(token === undefined ? {} : { token }),
    onEvent: ({ request, event }) => {
      if (!request.agent.webhooks.events.includes(event.data.type)) return;
      engine?.webhookDeliverer.enqueueVoiceSessionEvent({
        projectId: request.scope.projectId,
        endpointIds: request.agent.webhooks.endpointIds,
        event,
      });
    },
    onTranscript: ({ request, transcript }) => {
      if (!request.agent.webhooks.transcript) return;
      engine?.webhookDeliverer.enqueueVoiceTranscript({
        projectId: request.scope.projectId,
        endpointIds: request.agent.webhooks.endpointIds,
        transcript,
      });
    },
  });
  const voiceAgents = new VoiceAgentsAdapter({
    sessionDriver: driver,
    resolveTool: (name) => catalog.getTool(name),
  });
  return {
    adapters: new AdapterRegistry(
      defaultToolkitAdapters.map((adapter) =>
        adapter.toolkitSlug === "voice-agents" ? voiceAgents : adapter,
      ),
    ),
    driver,
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
    options.credentialProvider ?? createConfiguredCredentialProvider({ env });
  const voiceWorker = configuredVoiceWorker(env, catalog);
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
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    try {
      const engine = new ExecutionEngine({
        env,
        catalog,
        ...(voiceWorker.adapters === undefined
          ? {}
          : { adapters: voiceWorker.adapters }),
        credentialProvider,
        telemetryRuntime: telemetry,
      });
      voiceWorker.bind(engine);
      const triggerPollingScheduler = new TriggerPollingScheduler({
        service: engine.triggerService,
        logger: telemetry.logger,
      });
      return {
        engine,
        triggerPollingScheduler,
        close: async () => {
          triggerPollingScheduler.stop();
          try {
            await voiceWorker.driver?.close();
            await drainRuntime(engine, triggerPollingScheduler);
          } finally {
            await otel.shutdown();
          }
        },
      };
    } catch (error) {
      await voiceWorker.driver?.close();
      await otel.shutdown();
      throw error;
    }
  }

  let persistence: ExecutorPersistence | undefined;
  try {
    persistence = await (
      options.persistenceFactory ??
      ((connectionString: string) =>
        createPgStoreBundle({ connectionString, maxConnections: 5 }))
    )(databaseUrl);
    const initializedPersistence = persistence;
    const webhookDeliverer = new WebhookDeliverer({
      endpointStore: initializedPersistence.webhookEndpointStore,
      deliveryStore: initializedPersistence.webhookDeliveryStore,
      telemetry,
    });
    const triggerService = new TriggerService({
      catalog,
      credentialProvider,
      webhookDeliverer,
      subscriptionStore: initializedPersistence.triggerSubscriptionStore,
      stateStore: initializedPersistence.triggerStateStore,
      telemetry,
      env,
    });
    const engine = new ExecutionEngine({
      env,
      catalog,
      ...(voiceWorker.adapters === undefined
        ? {}
        : { adapters: voiceWorker.adapters }),
      credentialProvider,
      store: initializedPersistence.executionStore,
      webhookDeliverer,
      triggerService,
      telemetryRuntime: telemetry,
    });
    voiceWorker.bind(engine);
    const triggerPollingScheduler = new TriggerPollingScheduler({
      service: engine.triggerService,
      logger: telemetry.logger,
    });
    return {
      engine,
      triggerPollingScheduler,
      persistence: initializedPersistence,
      close: async () => {
        triggerPollingScheduler.stop();
        try {
          await voiceWorker.driver?.close();
          await drainRuntime(engine, triggerPollingScheduler);
        } finally {
          try {
            await initializedPersistence.close();
          } finally {
            await otel.shutdown();
          }
        }
      },
    };
  } catch (error) {
    await voiceWorker.driver?.close();
    await persistence?.close();
    await otel.shutdown();
    throw error;
  }
}
