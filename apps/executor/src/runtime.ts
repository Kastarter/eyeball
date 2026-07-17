import { defaultCatalog } from "@eyeball/catalog";
import type { CredentialProvider } from "@eyeball/core";
import { createConfiguredCredentialProvider } from "./credential-provider.js";
import { ExecutionEngine, type RuntimeCatalog } from "./engine.js";
import {
  createPgStoreBundle,
  type PostgresStoreSet,
} from "./stores/postgres/factory.js";
import { TriggerPollingScheduler, TriggerService } from "./triggers/service.js";
import { WebhookDeliverer } from "./webhooks/deliverer.js";

export interface CreateExecutorRuntimeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  catalog?: RuntimeCatalog;
  credentialProvider?: CredentialProvider;
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
  const databaseUrl = env.EYEBALL_DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    const engine = new ExecutionEngine({ env, catalog, credentialProvider });
    const triggerPollingScheduler = new TriggerPollingScheduler({
      service: engine.triggerService,
    });
    return {
      engine,
      triggerPollingScheduler,
      close: async () => triggerPollingScheduler.stop(),
    };
  }

  const persistence = await (
    options.persistenceFactory ??
    ((connectionString: string) =>
      createPgStoreBundle({ connectionString, maxConnections: 5 }))
  )(databaseUrl);
  try {
    const webhookDeliverer = new WebhookDeliverer({
      endpointStore: persistence.webhookEndpointStore,
      deliveryStore: persistence.webhookDeliveryStore,
    });
    const triggerService = new TriggerService({
      catalog,
      credentialProvider,
      webhookDeliverer,
      subscriptionStore: persistence.triggerSubscriptionStore,
      stateStore: persistence.triggerStateStore,
      env,
    });
    const engine = new ExecutionEngine({
      env,
      catalog,
      credentialProvider,
      store: persistence.executionStore,
      webhookDeliverer,
      triggerService,
    });
    const triggerPollingScheduler = new TriggerPollingScheduler({
      service: engine.triggerService,
    });
    return {
      engine,
      triggerPollingScheduler,
      persistence,
      close: async () => {
        triggerPollingScheduler.stop();
        await persistence.close();
      },
    };
  } catch (error) {
    await persistence.close();
    throw error;
  }
}
