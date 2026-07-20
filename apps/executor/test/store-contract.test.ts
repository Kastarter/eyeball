import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExecutionId,
  type ExecutionRecord,
  MockCredentialProvider,
} from "@eyeball/core";
import { afterAll, expect, it } from "vitest";
import {
  createExecutorRuntime,
  createJobEnvelope,
  createPgliteStoreBundle,
  executorJobId,
  InMemoryExecutionStore,
  InMemoryJobStore,
  InMemoryTriggerStateStore,
  InMemoryTriggerSubscriptionStore,
  InMemoryUsageOutboxStore,
  InMemoryWebhookDeliveryStore,
  InMemoryWebhookEndpointStore,
  InMemoryWebhookWorkStore,
  noopLogger,
  type PgliteStoreBundle,
  recoverExecutorJobs,
  webhookEndpointGroupKey,
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
    stores: async (): Promise<StoreContractStores> => {
      const webhookDeliveryStore = new InMemoryWebhookDeliveryStore();
      const jobStore = new InMemoryJobStore();
      return {
        executionStore: new InMemoryExecutionStore(),
        webhookEndpointStore: new InMemoryWebhookEndpointStore(),
        webhookDeliveryStore,
        webhookWorkStore: new InMemoryWebhookWorkStore(
          webhookDeliveryStore,
          jobStore,
        ),
        triggerSubscriptionStore: new InMemoryTriggerSubscriptionStore(),
        triggerStateStore: new InMemoryTriggerStateStore(),
        usageOutboxStore: new InMemoryUsageOutboxStore(),
        jobStore,
      };
    },
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
  const bundle = await createPgliteStoreBundle();
  const runtime = await createExecutorRuntime({
    env: { EYEBALL_DATABASE_URL: "postgresql://contract.invalid/eyeball" },
    credentialProvider: new MockCredentialProvider([]),
    persistenceFactory: async () => bundle,
  });
  try {
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
  } finally {
    await runtime.close();
  }
});

it("keeps durable webhook work reference-only", async () => {
  const bundle = await pgliteStores();
  const result = await bundle.client.query<{
    column_name: string;
    table_name: string;
  }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name in ('webhook_events', 'webhook_delivery_work')
      order by table_name, ordinal_position`,
  );
  const eventColumns = result.rows
    .filter(({ table_name }) => table_name === "webhook_events")
    .map(({ column_name }) => column_name);
  expect(eventColumns).toEqual([
    "sequence",
    "project_id",
    "event_id",
    "event_type",
    "source_kind",
    "source_id",
    "endpoint_ids",
    "created_at",
    "materialized_at",
  ]);
  expect(
    result.rows.some(
      ({ table_name }) => table_name === "webhook_delivery_work",
    ),
  ).toBe(false);
});

it("rebuilds execution, selection, and scheduled delivery jobs after a PGlite restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eyeball-job-recovery-"));
  const projectId = "project_restart_recovery";
  const executionId = createExecutionId("restart_recovery");
  const createdAt = "2026-07-18T05:00:00.000Z";
  const retryAt = "2026-07-18T05:10:00.000Z";
  const pending: ExecutionRecord & { status: "pending" } = {
    executionId,
    tool: "fixture.run",
    toolVersion: "1.0.0",
    catalogVersion: "2.0",
    status: "pending",
    userId: "user_restart_recovery",
    createdAt,
  };
  let first: PgliteStoreBundle | undefined;
  try {
    first = await createPgliteStoreBundle({ dataDir: directory });
    await first.executionStore.allocate({
      projectId,
      record: pending,
      request: {
        tool: pending.tool,
        userId: pending.userId,
        input: { message: "persisted" },
        mode: "async",
      },
      recovery: {
        webhookEventId: "evt_restart_execution",
        resumeContext: {
          version: 1,
          tool: pending.tool,
          toolVersion: pending.toolVersion,
          toolkitSlug: "fixture",
          requiredScopes: [],
          concurrencyBucketKey: `${projectId}:fixture`,
        },
      },
    });
    await first.webhookWorkStore.ensureEvent({
      projectId,
      eventId: "evt_restart_selection",
      eventType: "execution.succeeded",
      sourceKind: "execution",
      sourceId: executionId,
      endpointIds: [],
      createdAt,
      selectionRunAfter: createdAt,
    });
    await first.webhookWorkStore.ensureEvent({
      projectId,
      eventId: "evt_restart_delivery",
      eventType: "execution.failed",
      sourceKind: "execution",
      sourceId: executionId,
      endpointIds: ["whe_restart"],
      createdAt,
      selectionRunAfter: createdAt,
    });
    const [materialized] = await first.webhookWorkStore.materializeEvent({
      projectId,
      eventId: "evt_restart_delivery",
      endpointIds: ["whe_restart"],
      materializedAt: "2026-07-18T05:00:01.000Z",
    });
    if (materialized === undefined) {
      throw new Error("Expected a materialized webhook delivery.");
    }
    const delivering = {
      ...materialized.delivery,
      status: "delivering" as const,
    };
    await first.webhookDeliveryStore.update(projectId, delivering);
    await first.webhookDeliveryStore.update(projectId, {
      ...delivering,
      status: "pending",
      attempts: [
        {
          attempt: 1,
          attemptedAt: "2026-07-18T05:00:02.000Z",
          completedAt: "2026-07-18T05:00:03.000Z",
          statusCode: 503,
        },
      ],
      nextRetryAt: retryAt,
    });
    await first.close();
    first = undefined;

    const restored = await createPgliteStoreBundle({ dataDir: directory });
    try {
      const clock = { now: () => new Date("2026-07-18T05:01:00.000Z") };
      const recovery = {
        jobStore: restored.jobStore,
        executionStore: restored.executionStore,
        webhookWorkStore: restored.webhookWorkStore,
        webhookDeliveryStore: restored.webhookDeliveryStore,
        clock,
        logger: noopLogger,
      };
      await recoverExecutorJobs(recovery);
      await recoverExecutorJobs(recovery);

      const executionJob = {
        kind: "execution.run.v1" as const,
        payload: { projectId, executionId },
      };
      const selectionJob = {
        kind: "webhook.select.v1" as const,
        payload: { projectId, eventId: "evt_restart_selection" },
      };
      const deliveryJob = {
        kind: "webhook.deliver.v1" as const,
        payload: {
          projectId,
          deliveryId: materialized.delivery.deliveryId,
        },
      };
      await expect(
        restored.jobStore.get(executorJobId(executionJob)),
      ).resolves.toMatchObject({
        state: "pending",
        description: executionJob,
      });
      await expect(
        restored.jobStore.get(executorJobId(selectionJob)),
      ).resolves.toMatchObject({
        state: "pending",
        description: selectionJob,
      });
      await expect(
        restored.jobStore.get(executorJobId(deliveryJob)),
      ).resolves.toMatchObject({
        state: "pending",
        description: deliveryJob,
        runAfter: retryAt,
        groupKey: webhookEndpointGroupKey(projectId, "whe_restart"),
        groupOrder: materialized.sequence,
      });
    } finally {
      await restored.close();
    }
  } finally {
    await first?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("leaves a webhook delivery owned by a healthy replica untouched during recovery", async () => {
  const projectId = "project_active_delivery_recovery";
  const createdAt = "2026-07-18T06:00:00.000Z";
  const now = "2026-07-18T06:00:01.000Z";
  const deliveryStore = new InMemoryWebhookDeliveryStore();
  const jobStore = new InMemoryJobStore();
  const workStore = new InMemoryWebhookWorkStore(deliveryStore, jobStore);
  await workStore.ensureEvent({
    projectId,
    eventId: "evt_active_delivery",
    eventType: "execution.succeeded",
    sourceKind: "execution",
    sourceId: "exe_active_delivery",
    endpointIds: ["whe_active"],
    createdAt,
    selectionRunAfter: createdAt,
  });
  const [materialized] = await workStore.materializeEvent({
    projectId,
    eventId: "evt_active_delivery",
    endpointIds: ["whe_active"],
    materializedAt: now,
  });
  if (materialized === undefined) {
    throw new Error("Expected a materialized webhook delivery.");
  }
  await deliveryStore.update(projectId, {
    ...materialized.delivery,
    status: "delivering",
  });
  const job = {
    kind: "webhook.deliver.v1" as const,
    payload: {
      projectId,
      deliveryId: materialized.delivery.deliveryId,
    },
  };
  const envelope = createJobEnvelope(
    job,
    {
      runAfter: createdAt,
      groupKey: webhookEndpointGroupKey(projectId, "whe_active"),
      groupOrder: materialized.sequence,
    },
    new Date(createdAt),
  );
  await jobStore.ensure(envelope);
  await jobStore.claim({
    queueName: "webhook-delivery",
    workerId: "healthy-worker",
    now,
    leaseExpiresAt: "2026-07-18T06:01:01.000Z",
    limit: 1,
  });

  await recoverExecutorJobs({
    jobStore,
    executionStore: new InMemoryExecutionStore(),
    webhookWorkStore: workStore,
    webhookDeliveryStore: deliveryStore,
    clock: { now: () => new Date(now) },
    logger: noopLogger,
  });

  await expect(
    deliveryStore.get(projectId, materialized.delivery.deliveryId),
  ).resolves.toMatchObject({ status: "delivering" });
  await expect(jobStore.get(envelope.jobId)).resolves.toMatchObject({
    state: "running",
    claimedBy: "healthy-worker",
  });
});
