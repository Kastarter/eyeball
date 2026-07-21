import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExecutionId,
  createFileId,
  type ExecutionRecord,
  MockCredentialProvider,
} from "@eyeball/core";
import { afterAll, expect, it, vi } from "vitest";
import {
  createExecutorApp,
  createExecutorRuntime,
  createJobEnvelope,
  createPgliteStoreBundle,
  executorJobId,
  InMemoryExecutionStore,
  InMemoryFileStore,
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

function errorChainText(error: unknown): string {
  const seen = new Set<Error>();
  const values: string[] = [];
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === "cause") continue;
      const value = Reflect.get(current, key) as unknown;
      if (typeof value === "string") values.push(value);
      if (value instanceof Uint8Array) values.push([...value].join(","));
      if (Array.isArray(value)) values.push(value.map(String).join(","));
    }
    current = current.cause;
  }
  return values.join("\n");
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
        fileStore: new InMemoryFileStore(),
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
  expect(runtime.engine.fileStore).toBeInstanceOf(InMemoryFileStore);
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
    expect(runtime.engine.fileStore).toBe(bundle.fileStore);
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

it("sweeps expired durable files in fixed-clock batches before startup", async () => {
  const bundle = await createPgliteStoreBundle();
  const sweep = vi
    .spyOn(bundle.fileStore, "sweepExpired")
    .mockResolvedValueOnce(100)
    .mockResolvedValueOnce(2);
  const now = new Date("2026-07-18T08:30:00.000Z");
  const runtime = await createExecutorRuntime({
    env: { EYEBALL_DATABASE_URL: "postgresql://contract.invalid/eyeball" },
    credentialProvider: new MockCredentialProvider([]),
    persistenceFactory: async () => bundle,
    clock: { now: () => new Date(now) },
  });
  try {
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenNthCalledWith(1, {
      limit: 100,
      now: now.toISOString(),
    });
    expect(sweep).toHaveBeenNthCalledWith(2, {
      limit: 100,
      now: now.toISOString(),
    });
  } finally {
    await runtime.close();
  }
});

it("physically reclaims expired durable files while the runtime stays healthy", async () => {
  const bundle = await createPgliteStoreBundle();
  const projectId = "project_online_file_sweep";
  const fileId = createFileId("online_file_sweep");
  let now = Date.parse("2026-07-18T08:30:00.000Z");
  const runtime = await createExecutorRuntime({
    env: { EYEBALL_DATABASE_URL: "postgresql://contract.invalid/eyeball" },
    credentialProvider: new MockCredentialProvider([]),
    persistenceFactory: async () => bundle,
    clock: { now: () => new Date(now) },
    fileSweepIntervalMs: 5,
  });
  try {
    await bundle.fileStore.put(projectId, {
      createdAt: new Date(now).toISOString(),
      meta: {
        fileId,
        name: "online-sweep.bin",
        mimeType: "application/octet-stream",
        size: 3,
        expiresAt: new Date(now + 1_000).toISOString(),
      },
      content: Uint8Array.from([1, 2, 3]),
    });
    const before = await bundle.client.query<{ present: boolean }>(
      "select exists(select 1 from staged_files where project_id = $1 and file_id = $2) as present",
      [projectId, fileId],
    );
    expect(before.rows[0]?.present).toBe(true);

    now += 1_000;
    await vi.waitFor(
      async () => {
        const after = await bundle.client.query<{ present: boolean }>(
          "select exists(select 1 from staged_files where project_id = $1 and file_id = $2) as present",
          [projectId, fileId],
        );
        expect(after.rows[0]?.present).toBe(false);
      },
      { interval: 10, timeout: 1_000 },
    );
  } finally {
    await runtime.close();
  }
});

it("migrates staged file content as bytea with metadata and expiry columns", async () => {
  const bundle = await pgliteStores();
  const result = await bundle.client.query<{
    column_name: string;
    data_type: string;
  }>(
    `select column_name, data_type
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'staged_files'
      order by ordinal_position`,
  );
  expect(result.rows).toEqual([
    { column_name: "sequence", data_type: "bigint" },
    { column_name: "project_id", data_type: "text" },
    { column_name: "file_id", data_type: "text" },
    { column_name: "name", data_type: "text" },
    { column_name: "mime_type", data_type: "text" },
    { column_name: "size", data_type: "bigint" },
    { column_name: "content", data_type: "bytea" },
    { column_name: "created_at", data_type: "timestamp with time zone" },
    { column_name: "expires_at", data_type: "timestamp with time zone" },
  ]);
});

it("does not retain staged bytes when a Postgres insert fails", async () => {
  const bundle = await createPgliteStoreBundle();
  const sentinel = "file-write-plaintext-sentinel";
  const content = Uint8Array.from(Buffer.from(sentinel, "utf8"));
  try {
    await bundle.client.exec("drop table staged_files");
    let captured: unknown;
    try {
      await bundle.fileStore.put("project_failed_file_write", {
        createdAt: "2026-07-18T09:00:00.000Z",
        meta: {
          fileId: createFileId("failed_file_write"),
          name: "failed-write.bin",
          mimeType: "application/octet-stream",
          size: content.byteLength,
          expiresAt: "2026-07-18T10:00:00.000Z",
        },
        content,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    const safeError = captured as Error;
    expect(safeError.message).toBe("Staged-file persistence failed.");
    expect(safeError.cause).toBeUndefined();
    const chain = errorChainText(safeError);
    expect(chain).not.toContain(sentinel);
    expect(chain).not.toContain([...content].join(","));
    expect(chain).not.toContain([...content].join(", "));
    expect(chain).not.toContain(
      [...content].map((byte) => byte.toString(16).padStart(2, "0")).join(" "),
    );
  } finally {
    await bundle.close();
  }
});

it("keeps uploaded staged bytes available across a PGlite restart until exact expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eyeball-file-restart-"));
  const apiKey = "ey_file_restart";
  const projectId = "project_file_restart";
  let now = Date.parse("2026-07-18T09:00:00.000Z");
  const clock = { now: () => new Date(now) };
  let first: PgliteStoreBundle | undefined;
  try {
    first = await createPgliteStoreBundle({ dataDir: directory });
    const firstEngine = new (await import("../src/engine.js")).ExecutionEngine({
      fileStore: first.fileStore,
      clock,
      fileTtlMs: 1_000,
      fileIdFactory: () => createFileId("restart_round_trip"),
    });
    const firstApp = createExecutorApp({
      engine: firstEngine,
      apiKeys: { [apiKey]: projectId },
    });
    const uploaded = await firstApp.request("/v1/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "restart.bin",
        mimeType: "application/octet-stream",
        content: Buffer.from([0, 1, 2, 254, 255]).toString("base64"),
      }),
    });
    expect(uploaded.status).toBe(201);
    await first.close();
    first = undefined;

    const restored = await createPgliteStoreBundle({ dataDir: directory });
    try {
      const { ExecutionEngine } = await import("../src/engine.js");
      const restoredEngine = new ExecutionEngine({
        fileStore: restored.fileStore,
        clock,
        fileTtlMs: 1_000,
      });
      const restoredApp = createExecutorApp({
        engine: restoredEngine,
        apiKeys: { [apiKey]: projectId },
      });
      const resolved = await restoredEngine.getFile(
        projectId,
        "file_restart_round_trip",
      );
      expect(resolved.meta).toMatchObject({
        fileId: "file_restart_round_trip",
        name: "restart.bin",
        size: 5,
      });
      expect(resolved.content).toEqual(Uint8Array.from([0, 1, 2, 254, 255]));
      const metadata = await restoredApp.request(
        "/v1/files/file_restart_round_trip",
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      expect(metadata.status).toBe(200);

      now += 1_000;
      const expired = await restoredApp.request(
        "/v1/files/file_restart_round_trip",
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      expect(expired.status).toBe(404);
      await expect(expired.json()).resolves.toMatchObject({
        error: { code: "not_found" },
      });
    } finally {
      await restored.close();
    }
  } finally {
    await first?.close();
    await rm(directory, { recursive: true, force: true });
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
