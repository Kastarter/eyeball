import { randomUUID } from "node:crypto";
import { defaultCatalog } from "@eyeball/catalog";
import { type CredentialProvider, EyeballError } from "@eyeball/core";
import {
  defaultToolkitAdapters,
  InMemoryAgentStore,
  RemoteVoiceSessionDriver,
  TwilioAdapter,
  VoiceAgentsAdapter,
  voiceWorkerTokenFromEnv,
  voiceWorkerUrlFromEnv,
} from "@eyeball/toolkits";
import { AdapterRegistry } from "./adapters/index.js";
import {
  type ApiKeyAuthenticator,
  createConfiguredApiKeyAuthenticator,
} from "./api-key-authenticator.js";
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
  apiKeyAuthenticator?: ApiKeyAuthenticator;
  /** In-process test/deployment seam shared by remote composition and adapters. */
  fetchImpl?: typeof fetch;
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
  apiKeyAuthenticator: ApiKeyAuthenticator;
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
  fetchImpl?: typeof fetch,
): {
  adapters: AdapterRegistry;
  driver?: RemoteVoiceSessionDriver;
  bind(engine: ExecutionEngine): void;
} {
  const workerUrl = voiceWorkerUrlFromEnv(env);
  let engine: ExecutionEngine | undefined;
  const token = voiceWorkerTokenFromEnv(env);
  const driver =
    workerUrl === undefined
      ? undefined
      : new RemoteVoiceSessionDriver({
          baseUrl: workerUrl,
          ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
          ...(token === undefined ? {} : { token }),
          onEvent: ({ request, event }) => {
            if (!request.agent.webhooks.events.includes(event.data.type))
              return;
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
  const agentStore = new InMemoryAgentStore();
  const voiceAgents = new VoiceAgentsAdapter({
    store: agentStore,
    ...(driver === undefined ? {} : { sessionDriver: driver }),
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
      if (response.status === "failed") {
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
  const voiceWorker = configuredVoiceWorker(env, catalog, options.fetchImpl);
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
        ...(options.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
      });
      voiceWorker.bind(engine);
      const triggerPollingScheduler = new TriggerPollingScheduler({
        service: engine.triggerService,
        logger: telemetry.logger,
      });
      return {
        engine,
        apiKeyAuthenticator,
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
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
    });
    voiceWorker.bind(engine);
    const triggerPollingScheduler = new TriggerPollingScheduler({
      service: engine.triggerService,
      logger: telemetry.logger,
    });
    return {
      engine,
      apiKeyAuthenticator,
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
