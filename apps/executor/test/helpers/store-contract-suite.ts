import {
  createExecutionId,
  createTriggerSubscriptionId,
  type ExecuteRequest,
  type ExecutionId,
  type ExecutionRecord,
  type TriggerSubscriptionId,
  type WebhookDelivery,
} from "@eyeball/core";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  ExecutionAllocation,
  ExecutionStore,
  StoredTriggerSubscription,
  TriggerStateStore,
  TriggerSubscriptionStore,
  UsageOutboxStore,
  WebhookDeliveryStore,
  WebhookEndpointStore,
} from "../../src/index.js";

export interface StoreContractStores {
  executionStore: ExecutionStore;
  webhookEndpointStore: WebhookEndpointStore;
  webhookDeliveryStore: WebhookDeliveryStore;
  triggerSubscriptionStore: TriggerSubscriptionStore;
  triggerStateStore: TriggerStateStore;
  usageOutboxStore: UsageOutboxStore;
}

export interface StoreContractImplementation {
  name: string;
  stores(): Promise<StoreContractStores>;
}

class MutableClock {
  #now: Date;

  constructor(now: string) {
    this.#now = new Date(now);
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(milliseconds: number): void {
    this.#now = new Date(this.#now.getTime() + milliseconds);
  }
}

let namespaceSequence = 0;

function namespace(label: string): string {
  namespaceSequence += 1;
  return `${label.replaceAll(/[^a-z0-9]/giu, "_")}_${namespaceSequence}`;
}

function allocation(
  projectId: string,
  executionId: ExecutionId,
  clock: MutableClock,
  options: {
    key?: string;
    requestHash?: string;
    expiresInMs?: number;
    userId?: string;
  } = {},
): ExecutionAllocation {
  const request: ExecuteRequest = {
    tool: "gmail.send_email",
    userId: options.userId ?? "user_contract",
    input: {
      to: ["buyer@example.com"],
      subject: executionId,
      body: "Hello",
    },
    mode: "sync",
  };
  const createdAt = clock.now().toISOString();
  return {
    projectId,
    request,
    record: {
      executionId,
      tool: request.tool,
      toolVersion: "1.0.0",
      catalogVersion: "1.1",
      userId: request.userId,
      status: "pending",
      createdAt,
    },
    ...(options.key === undefined
      ? {}
      : {
          idempotency: {
            scope: {
              key: options.key,
              tool: request.tool,
              userId: request.userId,
              connectionId: "default" as const,
              catalogMajor: "1",
            },
            requestHash: options.requestHash ?? `hash:${options.key}`,
            expiresAt: new Date(
              clock.now().getTime() +
                (options.expiresInMs ?? 24 * 60 * 60 * 1_000),
            ).toISOString(),
          },
        }),
  };
}

function running(
  record: ExecutionRecord & { status: "pending" },
): ExecutionRecord & { status: "running" } {
  return {
    ...record,
    status: "running",
    startedAt: new Date(Date.parse(record.createdAt) + 1).toISOString(),
  };
}

function succeeded(
  record: ExecutionRecord & { status: "running" },
): ExecutionRecord & { status: "succeeded" } {
  return {
    ...record,
    status: "succeeded",
    output: { ok: true },
    latencyMs: 2,
    completedAt: new Date(Date.parse(record.createdAt) + 2).toISOString(),
  };
}

function subscription(
  subscriptionId: TriggerSubscriptionId,
  projectId: string,
  userId: string,
  createdAt: string,
): StoredTriggerSubscription {
  return {
    subscriptionId,
    projectId,
    userId,
    trigger: "gmail.email_received",
    connectionId: "conn_contract",
    webhookEndpointIds: ["whe_contract"],
    filters: { from: "seller@example.com" },
    pollIntervalSeconds: 60,
    status: "active",
    ingestSecretHash: `sha256:${subscriptionId}`,
    createdAt,
    updatedAt: createdAt,
  };
}

export function registerStoreContractSuite(
  implementations: readonly StoreContractImplementation[],
): void {
  describe.each(implementations)("$name store contracts", (implementation) => {
    let stores: StoreContractStores;

    beforeAll(async () => {
      stores = await implementation.stores();
    });

    describe("executions", () => {
      it("persists detail, transitions, resolved connections, and terminal waits", async () => {
        const scope = namespace(implementation.name);
        const projectId = `project_${scope}`;
        const clock = new MutableClock("2026-07-18T00:00:00.000Z");
        const executionId = createExecutionId(`${scope}_crud`);
        const pendingAllocation = allocation(projectId, executionId, clock, {
          key: `key_${scope}`,
        });
        const allocated =
          await stores.executionStore.allocate(pendingAllocation);
        expect(allocated.kind).toBe("allocated");
        expect(await stores.executionStore.get(projectId, executionId)).toEqual(
          pendingAllocation.record,
        );
        expect(
          await stores.executionStore.getDetail(projectId, executionId),
        ).toMatchObject({
          projectId,
          input: pendingAllocation.request.input,
          mode: "sync",
          idempotencyKey: `key_${scope}`,
        });

        await stores.executionStore.setResolvedConnection(
          projectId,
          executionId,
          "conn_resolved",
        );
        expect(
          await stores.executionStore.getDetail(projectId, executionId),
        ).toMatchObject({ connectionId: "conn_resolved" });

        const runningRecord = running(pendingAllocation.record);
        await stores.executionStore.update(projectId, runningRecord);
        const terminalPromise = stores.executionStore.waitForTerminal(
          projectId,
          executionId,
        );
        const terminal = succeeded(runningRecord);
        await stores.executionStore.update(projectId, terminal);
        await expect(terminalPromise).resolves.toEqual(terminal);
      });

      it("replays, conflicts, and expires idempotency using the supplied clock", async () => {
        const scope = namespace(implementation.name);
        const projectId = `project_${scope}`;
        const clock = new MutableClock("2026-07-18T01:00:00.000Z");
        const first = allocation(
          projectId,
          createExecutionId(`${scope}_first`),
          clock,
          { key: `idem_${scope}`, requestHash: "same", expiresInMs: 1_000 },
        );
        await expect(
          stores.executionStore.allocate(first),
        ).resolves.toMatchObject({ kind: "allocated" });
        const replay = allocation(
          projectId,
          createExecutionId(`${scope}_replay`),
          clock,
          { key: `idem_${scope}`, requestHash: "same", expiresInMs: 1_000 },
        );
        await expect(
          stores.executionStore.inspectAllocation(replay),
        ).resolves.toMatchObject({
          kind: "replay",
          record: { executionId: first.record.executionId },
        });
        await expect(
          stores.executionStore.allocate(replay),
        ).resolves.toMatchObject({
          kind: "replay",
          record: { executionId: first.record.executionId },
        });
        const conflict = allocation(
          projectId,
          createExecutionId(`${scope}_conflict`),
          clock,
          {
            key: `idem_${scope}`,
            requestHash: "different",
            expiresInMs: 1_000,
          },
        );
        await expect(
          stores.executionStore.inspectAllocation(conflict),
        ).resolves.toEqual({ kind: "conflict" });
        await expect(stores.executionStore.allocate(conflict)).resolves.toEqual(
          { kind: "conflict" },
        );

        clock.advance(1_000);
        const expired = allocation(
          projectId,
          createExecutionId(`${scope}_expired`),
          clock,
          {
            key: `idem_${scope}`,
            requestHash: "different",
            expiresInMs: 1_000,
          },
        );
        await expect(
          stores.executionStore.allocate(expired),
        ).resolves.toMatchObject({
          kind: "allocated",
          record: { executionId: expired.record.executionId },
        });
      });

      it("atomically allocates one execution for concurrent idempotency claims", async () => {
        const scope = namespace(implementation.name);
        const projectId = `project_${scope}`;
        const clock = new MutableClock("2026-07-18T02:00:00.000Z");
        const claims = await Promise.all([
          stores.executionStore.allocate(
            allocation(projectId, createExecutionId(`${scope}_race_a`), clock, {
              key: `race_${scope}`,
              requestHash: "same",
            }),
          ),
          stores.executionStore.allocate(
            allocation(projectId, createExecutionId(`${scope}_race_b`), clock, {
              key: `race_${scope}`,
              requestHash: "same",
            }),
          ),
        ]);
        expect(claims.map(({ kind }) => kind).sort()).toEqual([
          "allocated",
          "replay",
        ]);
      });

      it("filters and paginates from a stable project-scoped anchor", async () => {
        const scope = namespace(implementation.name);
        const projectId = `project_${scope}`;
        const clock = new MutableClock("2026-07-18T03:00:00.000Z");
        const oldest = allocation(
          projectId,
          createExecutionId(`${scope}_oldest`),
          clock,
          { userId: "user_a" },
        );
        await stores.executionStore.allocate(oldest);
        clock.advance(1);
        const newest = allocation(
          projectId,
          createExecutionId(`${scope}_newest`),
          clock,
          { userId: "user_a" },
        );
        await stores.executionStore.allocate(newest);
        const firstPage = await stores.executionStore.list(projectId, {
          userId: "user_a",
          limit: 1,
        });
        expect(
          firstPage.executions.map(({ executionId }) => executionId),
        ).toEqual([newest.record.executionId]);
        expect(firstPage.nextCursor).toBeDefined();

        clock.advance(1);
        const inserted = allocation(
          projectId,
          createExecutionId(`${scope}_inserted`),
          clock,
          { userId: "user_a" },
        );
        await stores.executionStore.allocate(inserted);
        const secondPage = await stores.executionStore.list(projectId, {
          userId: "user_a",
          cursor: firstPage.nextCursor as string,
          limit: 1,
        });
        expect(
          secondPage.executions.map(({ executionId }) => executionId),
        ).toEqual([oldest.record.executionId]);
        expect(
          await stores.executionStore.list(`other_${projectId}`, { limit: 10 }),
        ).toEqual({ executions: [] });
      });
    });

    describe("usage outbox", () => {
      it("retains retryable reports until they are marked sent", async () => {
        const scope = namespace(implementation.name);
        const executionId = createExecutionId(`${scope}_usage`);
        const enqueuedAt = "2026-07-18T03:30:00.000Z";
        const payload = {
          projectId: `project_${scope}`,
          executionId,
          idempotencyKey: `usage_${scope}`,
          dimension: "execution" as const,
          quantity: 1 as const,
          occurredAt: enqueuedAt,
        };
        await stores.usageOutboxStore.enqueue(payload, enqueuedAt);
        await stores.usageOutboxStore.enqueue(payload, enqueuedAt);
        expect(await stores.usageOutboxStore.depth()).toBe(1);
        await expect(
          stores.usageOutboxStore.enqueue(
            { ...payload, idempotencyKey: `different_${scope}` },
            enqueuedAt,
          ),
        ).rejects.toThrow(/conflict/iu);

        const ready = await stores.usageOutboxStore.listReady(enqueuedAt, 50);
        expect(ready).toHaveLength(1);
        expect(ready[0]).toMatchObject({ state: "pending", attempts: 0 });
        const retryAt = "2026-07-18T03:30:01.000Z";
        await stores.usageOutboxStore.markFailed(
          [{ executionId, nextRetryAt: retryAt }],
          enqueuedAt,
        );
        await expect(
          stores.usageOutboxStore.listReady(enqueuedAt, 50),
        ).resolves.toEqual([]);
        await expect(
          stores.usageOutboxStore.listReady(enqueuedAt, 50, true),
        ).resolves.toMatchObject([{ state: "failed", attempts: 1 }]);
        await stores.usageOutboxStore.markSent([executionId], retryAt);
        expect(await stores.usageOutboxStore.depth()).toBe(0);
        await expect(
          stores.usageOutboxStore.listReady(retryAt, 50),
        ).resolves.toEqual([]);
      });
    });

    describe("webhook endpoints", () => {
      it("reveals secrets only on create or rotate and scopes CRUD by project", async () => {
        const scope = namespace(implementation.name);
        const projectId = `project_${scope}`;
        const created = await stores.webhookEndpointStore.create(projectId, {
          url: `https://hooks.example.com/${scope}`,
          events: ["execution.completed"],
          active: true,
          createdAt: "2026-07-18T04:00:00.000Z",
        });
        expect(created.secret).toMatch(/^whsec_/u);
        expect(
          await stores.webhookEndpointStore.get(projectId, created.endpointId),
        ).not.toHaveProperty("secret");
        expect(
          await stores.webhookEndpointStore.getForDelivery(
            projectId,
            created.endpointId,
          ),
        ).toMatchObject({ secret: created.secret });
        expect(
          await stores.webhookEndpointStore.list(projectId, { limit: 10 }),
        ).not.toHaveProperty("webhooks.0.secret");
        expect(
          await stores.webhookEndpointStore.get(
            `other_${projectId}`,
            created.endpointId,
          ),
        ).toBeUndefined();

        const updated = await stores.webhookEndpointStore.update(
          projectId,
          created.endpointId,
          { active: false, updatedAt: "2026-07-18T04:01:00.000Z" },
        );
        expect(updated).toMatchObject({ active: false });
        const rotated = await stores.webhookEndpointStore.rotateSecret(
          projectId,
          created.endpointId,
          "2026-07-18T04:02:00.000Z",
        );
        expect(rotated?.secret).toMatch(/^whsec_/u);
        expect(rotated?.secret).not.toBe(created.secret);
        expect(
          await stores.webhookEndpointStore.delete(
            `other_${projectId}`,
            created.endpointId,
          ),
        ).toBe(false);
        expect(
          await stores.webhookEndpointStore.delete(
            projectId,
            created.endpointId,
          ),
        ).toBe(true);
      });

      it("paginates newest endpoints first", async () => {
        const scope = namespace(implementation.name);
        const projectId = `project_${scope}`;
        const first = await stores.webhookEndpointStore.create(projectId, {
          url: `https://hooks.example.com/${scope}/first`,
          events: ["execution.failed"],
          active: true,
          createdAt: "2026-07-18T05:00:00.000Z",
        });
        const second = await stores.webhookEndpointStore.create(projectId, {
          url: `https://hooks.example.com/${scope}/second`,
          events: ["execution.succeeded"],
          active: true,
          createdAt: "2026-07-18T05:00:01.000Z",
        });
        const page = await stores.webhookEndpointStore.list(projectId, {
          limit: 1,
        });
        expect(page.webhooks[0]?.endpointId).toBe(second.endpointId);
        expect(page.nextCursor).toBeDefined();
        await expect(
          stores.webhookEndpointStore.list(projectId, {
            limit: 1,
            cursor: page.nextCursor as string,
          }),
        ).resolves.toMatchObject({
          webhooks: [{ endpointId: first.endpointId }],
        });
      });
    });

    describe("webhook deliveries", () => {
      it("atomically appends attempts with status and exposes the delivery log", async () => {
        const scope = namespace(implementation.name);
        const projectId = `project_${scope}`;
        const created = await stores.webhookDeliveryStore.create(projectId, {
          endpointId: `whe_${scope}`,
          eventId: `evt_${scope}`,
          eventType: "execution.succeeded",
          createdAt: "2026-07-18T06:00:00.000Z",
        });
        const delivering: WebhookDelivery = {
          ...created,
          status: "delivering",
        };
        await stores.webhookDeliveryStore.update(projectId, delivering);
        const attempt = {
          attempt: 1,
          attemptedAt: "2026-07-18T06:00:01.000Z",
          completedAt: "2026-07-18T06:00:02.000Z",
          statusCode: 200,
        };
        const succeededDelivery: WebhookDelivery = {
          ...delivering,
          status: "succeeded",
          attempts: [attempt],
          completedAt: attempt.completedAt,
        };
        await stores.webhookDeliveryStore.update(projectId, succeededDelivery);
        await expect(
          stores.webhookDeliveryStore.get(projectId, created.deliveryId),
        ).resolves.toEqual(succeededDelivery);
        await expect(
          stores.webhookDeliveryStore.list(projectId, created.endpointId, {
            limit: 10,
          }),
        ).resolves.toEqual({ deliveries: [succeededDelivery] });
        expect(
          await stores.webhookDeliveryStore.get(
            `other_${projectId}`,
            created.deliveryId,
          ),
        ).toBeUndefined();
      });

      it("rejects non-append delivery attempt mutations", async () => {
        const scope = namespace(implementation.name);
        const projectId = `project_${scope}`;
        const created = await stores.webhookDeliveryStore.create(projectId, {
          endpointId: `whe_${scope}`,
          eventId: `evt_${scope}`,
          eventType: "execution.failed",
          createdAt: "2026-07-18T07:00:00.000Z",
        });
        await expect(
          stores.webhookDeliveryStore.update(projectId, {
            ...created,
            status: "succeeded",
            attempts: [],
          }),
        ).rejects.toThrow("Invalid webhook delivery transition");
      });
    });

    describe("trigger subscriptions", () => {
      it("persists public and internal records with project and user scoping", async () => {
        const scope = namespace(implementation.name);
        const projectId = `project_${scope}`;
        const first = subscription(
          createTriggerSubscriptionId(`${scope}_first`),
          projectId,
          "user_a",
          "2026-07-18T08:00:00.000Z",
        );
        const second = subscription(
          createTriggerSubscriptionId(`${scope}_second`),
          projectId,
          "user_b",
          "2026-07-18T08:00:01.000Z",
        );
        const created = await stores.triggerSubscriptionStore.create(first);
        await stores.triggerSubscriptionStore.create(second);
        expect(created).not.toHaveProperty("ingestSecretHash");
        expect(
          await stores.triggerSubscriptionStore.getInternal(
            first.subscriptionId,
          ),
        ).toMatchObject({ ingestSecretHash: first.ingestSecretHash });
        expect(
          await stores.triggerSubscriptionStore.get(
            `other_${projectId}`,
            first.subscriptionId,
          ),
        ).toBeUndefined();
        const rotatedAt = "2026-07-18T08:01:00.000Z";
        const rotatedHash = `rotated:${first.subscriptionId}`;
        await expect(
          stores.triggerSubscriptionStore.rotateIngestSecret(
            `other_${projectId}`,
            first.subscriptionId,
            rotatedHash,
            rotatedAt,
          ),
        ).resolves.toBeUndefined();
        await expect(
          stores.triggerSubscriptionStore.rotateIngestSecret(
            projectId,
            first.subscriptionId,
            rotatedHash,
            rotatedAt,
          ),
        ).resolves.toMatchObject({
          subscriptionId: first.subscriptionId,
          updatedAt: rotatedAt,
        });
        expect(
          await stores.triggerSubscriptionStore.getInternal(
            first.subscriptionId,
          ),
        ).toMatchObject({ ingestSecretHash: rotatedHash });
        await expect(
          stores.triggerSubscriptionStore.list(projectId, {
            userId: "user_a",
            limit: 10,
          }),
        ).resolves.toMatchObject({
          subscriptions: [{ subscriptionId: first.subscriptionId }],
        });
        expect(
          (await stores.triggerSubscriptionStore.listActive()).map(
            ({ subscriptionId }) => subscriptionId,
          ),
        ).toEqual(
          expect.arrayContaining([first.subscriptionId, second.subscriptionId]),
        );
        expect(
          await stores.triggerSubscriptionStore.delete(
            `other_${projectId}`,
            first.subscriptionId,
          ),
        ).toBe(false);
        expect(
          await stores.triggerSubscriptionStore.delete(
            projectId,
            first.subscriptionId,
          ),
        ).toBe(true);
      });

      it("paginates subscriptions from a stable cursor", async () => {
        const scope = namespace(implementation.name);
        const projectId = `project_${scope}`;
        const oldest = subscription(
          createTriggerSubscriptionId(`${scope}_oldest`),
          projectId,
          "user_cursor",
          "2026-07-18T09:00:00.000Z",
        );
        const newest = subscription(
          createTriggerSubscriptionId(`${scope}_newest`),
          projectId,
          "user_cursor",
          "2026-07-18T09:00:01.000Z",
        );
        await stores.triggerSubscriptionStore.create(oldest);
        await stores.triggerSubscriptionStore.create(newest);
        const firstPage = await stores.triggerSubscriptionStore.list(
          projectId,
          {
            limit: 1,
          },
        );
        expect(firstPage.subscriptions[0]?.subscriptionId).toBe(
          newest.subscriptionId,
        );
        await expect(
          stores.triggerSubscriptionStore.list(projectId, {
            limit: 1,
            cursor: firstPage.nextCursor as string,
          }),
        ).resolves.toMatchObject({
          subscriptions: [{ subscriptionId: oldest.subscriptionId }],
        });
      });
    });

    describe("trigger state and dedup", () => {
      it("persists cursors and deletes cursor plus dedup state", async () => {
        const scope = namespace(implementation.name);
        const subscriptionId = createTriggerSubscriptionId(`${scope}_state`);
        await stores.triggerStateStore.put({
          subscriptionId,
          cursor: "cursor:1",
          nextPollAt: "2026-07-18T10:01:00.000Z",
          updatedAt: "2026-07-18T10:00:00.000Z",
        });
        await expect(
          stores.triggerStateStore.get(subscriptionId),
        ).resolves.toEqual({
          subscriptionId,
          cursor: "cursor:1",
          nextPollAt: "2026-07-18T10:01:00.000Z",
          updatedAt: "2026-07-18T10:00:00.000Z",
        });
        await stores.triggerStateStore.delete(subscriptionId);
        expect(
          await stores.triggerStateStore.get(subscriptionId),
        ).toBeUndefined();
      });

      it("lets exactly one concurrent dedup claim win and reclaims after TTL", async () => {
        const scope = namespace(implementation.name);
        const subscriptionId = createTriggerSubscriptionId(`${scope}_dedup`);
        const now = "2026-07-18T11:00:00.000Z";
        const expiresAt = "2026-07-18T11:00:01.000Z";
        const results = await Promise.all([
          stores.triggerStateStore.claimProviderEvent(
            subscriptionId,
            "provider-event-1",
            now,
            expiresAt,
          ),
          stores.triggerStateStore.claimProviderEvent(
            subscriptionId,
            "provider-event-1",
            now,
            expiresAt,
          ),
        ]);
        expect(results.sort()).toEqual([false, true]);
        await expect(
          stores.triggerStateStore.claimProviderEvent(
            subscriptionId,
            "provider-event-1",
            expiresAt,
            "2026-07-18T11:00:02.000Z",
          ),
        ).resolves.toBe(true);
      });
    });
  });
}
