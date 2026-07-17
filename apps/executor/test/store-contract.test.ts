import { MockCredentialProvider } from "@eyeball/core";
import { afterAll, expect, it } from "vitest";
import {
  createExecutorRuntime,
  createPgliteStoreBundle,
  InMemoryExecutionStore,
  InMemoryTriggerStateStore,
  InMemoryTriggerSubscriptionStore,
  InMemoryWebhookDeliveryStore,
  InMemoryWebhookEndpointStore,
  type PgliteStoreBundle,
} from "../src/index.js";
import {
  registerStoreContractSuite,
  type StoreContractStores,
} from "./helpers/store-contract-suite.js";

let pgliteBundlePromise: Promise<PgliteStoreBundle> | undefined;

function pgliteStores(): Promise<PgliteStoreBundle> {
  pgliteBundlePromise ??= createPgliteStoreBundle();
  return pgliteBundlePromise;
}

afterAll(async () => {
  if (pgliteBundlePromise !== undefined) {
    await (await pgliteBundlePromise).close();
  }
});

registerStoreContractSuite([
  {
    name: "in-memory",
    stores: async (): Promise<StoreContractStores> => ({
      executionStore: new InMemoryExecutionStore(),
      webhookEndpointStore: new InMemoryWebhookEndpointStore(),
      webhookDeliveryStore: new InMemoryWebhookDeliveryStore(),
      triggerSubscriptionStore: new InMemoryTriggerSubscriptionStore(),
      triggerStateStore: new InMemoryTriggerStateStore(),
    }),
  },
  {
    name: "PGlite",
    stores: pgliteStores,
  },
]);

it("keeps zero-config runtime stores in memory", async () => {
  const runtime = await createExecutorRuntime({
    env: {},
    credentialProvider: new MockCredentialProvider([]),
  });
  expect(runtime.persistence).toBeUndefined();
  expect(runtime.engine.store).toBeInstanceOf(InMemoryExecutionStore);
  expect(runtime.engine.webhookDeliverer.endpointStore).toBeInstanceOf(
    InMemoryWebhookEndpointStore,
  );
  expect(runtime.engine.triggerService.stateStore).toBeInstanceOf(
    InMemoryTriggerStateStore,
  );
  await runtime.close();
});

it("wires every durable store when EYEBALL_DATABASE_URL is set", async () => {
  const bundle = await pgliteStores();
  const runtime = await createExecutorRuntime({
    env: { EYEBALL_DATABASE_URL: "postgresql://contract.invalid/eyeball" },
    credentialProvider: new MockCredentialProvider([]),
    persistenceFactory: async () => bundle,
  });
  expect(runtime.persistence).toBe(bundle);
  expect(runtime.engine.store).toBe(bundle.executionStore);
  expect(runtime.engine.webhookDeliverer.endpointStore).toBe(
    bundle.webhookEndpointStore,
  );
  expect(runtime.engine.webhookDeliverer.deliveryStore).toBe(
    bundle.webhookDeliveryStore,
  );
  expect(runtime.engine.triggerService.subscriptionStore).toBe(
    bundle.triggerSubscriptionStore,
  );
  expect(runtime.engine.triggerService.stateStore).toBe(
    bundle.triggerStateStore,
  );
});
