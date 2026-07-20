import type { Clock, ExecutorLogger } from "../adapters/index.js";
import type { ExecutionStore } from "../store.js";
import type { WebhookDeliveryStore } from "../webhooks/delivery-store.js";
import type { WebhookWorkStore } from "../webhooks/work-store.js";
import type { JobStore } from "./store.js";
import {
  createJobEnvelope,
  type ExecutorJob,
  WEBHOOK_SELECTION_GROUP_KEY,
  webhookEndpointGroupKey,
} from "./types.js";

const RECOVERY_BATCH_SIZE = 100;

export interface RecoverExecutorJobsInput {
  readonly jobStore: JobStore;
  readonly executionStore: ExecutionStore;
  readonly webhookWorkStore: WebhookWorkStore;
  readonly webhookDeliveryStore: WebhookDeliveryStore;
  readonly clock: Clock;
  readonly logger: ExecutorLogger;
  readonly batchSize?: number;
}

async function ensureRecoveryJob(
  store: JobStore,
  job: ExecutorJob,
  options: {
    readonly runAfter: string;
    readonly groupKey?: string;
    readonly groupOrder?: number;
  },
): Promise<void> {
  const envelope = createJobEnvelope(job, options, new Date(options.runAfter));
  const ensured = await store.ensure(envelope);
  if (ensured.kind === "conflict") {
    throw new Error("Recovery found a conflicting deterministic job identity.");
  }
  if (ensured.job.state === "succeeded" || ensured.job.state === "failed") {
    await store.reopenForRecovery({
      jobId: envelope.jobId,
      expectedDescription: job,
      runAfter: envelope.runAfter,
    });
  }
}

/**
 * Reconciles durable source records into deterministic ID-only jobs before the
 * worker starts. The sweep is bounded, idempotent, and safe across replicas.
 */
export async function recoverExecutorJobs(
  input: RecoverExecutorJobsInput,
): Promise<void> {
  const batchSize = input.batchSize ?? RECOVERY_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError(
      "Recovery batch size must be a positive safe integer.",
    );
  }
  const now = input.clock.now();
  if (Number.isNaN(now.valueOf())) {
    throw new Error("Recovery clock returned an invalid date.");
  }
  const nowIso = now.toISOString();
  await input.jobStore.expireLeases({
    queueNames: ["execution", "webhook-selection", "webhook-delivery"],
    now: nowIso,
    limit: batchSize,
  });

  let executionCursor: number | undefined;
  do {
    const page = await input.executionStore.listRecoveryCandidates({
      ...(executionCursor === undefined ? {} : { cursor: executionCursor }),
      limit: batchSize,
    });
    for (const candidate of page.candidates) {
      await ensureRecoveryJob(
        input.jobStore,
        {
          kind: "execution.run.v1",
          payload: {
            projectId: candidate.projectId,
            executionId: candidate.record.executionId,
          },
        },
        { runAfter: nowIso },
      );
    }
    executionCursor = page.nextCursor;
  } while (executionCursor !== undefined);

  let eventCursor: number | undefined;
  do {
    const page = await input.webhookWorkStore.listUnmaterialized({
      ...(eventCursor === undefined ? {} : { cursor: eventCursor }),
      limit: batchSize,
    });
    for (const event of page.events) {
      await ensureRecoveryJob(
        input.jobStore,
        {
          kind: "webhook.select.v1",
          payload: { projectId: event.projectId, eventId: event.eventId },
        },
        {
          runAfter: nowIso,
          groupKey: WEBHOOK_SELECTION_GROUP_KEY,
          groupOrder: event.sequence,
        },
      );
    }
    eventCursor = page.nextCursor;
  } while (eventCursor !== undefined);

  let deliveryCursor: number | undefined;
  do {
    const page = await input.webhookDeliveryStore.listUnfinished({
      ...(deliveryCursor === undefined ? {} : { cursor: deliveryCursor }),
      limit: batchSize,
    });
    for (const candidate of page.deliveries) {
      const delivery = candidate.delivery;
      const job: ExecutorJob = {
        kind: "webhook.deliver.v1",
        payload: {
          projectId: candidate.projectId,
          deliveryId: delivery.deliveryId,
        },
      };
      const runAfter =
        delivery.nextRetryAt !== undefined &&
        Date.parse(delivery.nextRetryAt) > now.valueOf()
          ? delivery.nextRetryAt
          : nowIso;
      await ensureRecoveryJob(input.jobStore, job, {
        runAfter,
        groupKey: webhookEndpointGroupKey(
          candidate.projectId,
          delivery.endpointId,
        ),
        groupOrder: candidate.sequence,
      });
    }
    deliveryCursor = page.nextCursor;
  } while (deliveryCursor !== undefined);
}
