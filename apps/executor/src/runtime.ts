import { defaultCatalog } from "@eyeball/catalog";
import type { CredentialProvider } from "@eyeball/core";
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
        credentialProvider,
        telemetryRuntime: telemetry,
      });
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
            await drainRuntime(engine, triggerPollingScheduler);
          } finally {
            await otel.shutdown();
          }
        },
      };
    } catch (error) {
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
      credentialProvider,
      store: initializedPersistence.executionStore,
      webhookDeliverer,
      triggerService,
      telemetryRuntime: telemetry,
    });
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
    await persistence?.close();
    await otel.shutdown();
    throw error;
  }
}
