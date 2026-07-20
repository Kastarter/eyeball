import { createHash } from "node:crypto";

export type JobQueueName =
  | "execution"
  | "webhook-selection"
  | "webhook-delivery";

export interface ExecutionRunJob {
  readonly kind: "execution.run.v1";
  readonly payload: {
    readonly projectId: string;
    readonly executionId: string;
  };
}

export interface WebhookSelectJob {
  readonly kind: "webhook.select.v1";
  readonly payload: {
    readonly projectId: string;
    readonly eventId: string;
  };
}

export interface WebhookDeliverJob {
  readonly kind: "webhook.deliver.v1";
  readonly payload: {
    readonly projectId: string;
    readonly deliveryId: string;
  };
}

export type ExecutorJob =
  | ExecutionRunJob
  | WebhookSelectJob
  | WebhookDeliverJob;

export interface JobEnvelope<J extends ExecutorJob = ExecutorJob> {
  readonly jobId: string;
  readonly queueName: JobQueueName;
  readonly description: J;
  readonly groupKey?: string;
  readonly groupOrder?: number;
  readonly runAfter: string;
}

export interface SubmitJobOptions {
  readonly runAfter?: string;
  readonly groupKey?: string;
  readonly groupOrder?: number;
}

export type SafeJobErrorCode =
  | "handler_rejected"
  | "invalid_job_version"
  | "invalid_job_payload"
  | "job_conflict"
  | "lease_lost"
  | "recovery_unavailable";

const JOB_ID_PREFIX = "job_v1_";
const GROUP_KEY_PREFIX = "grp_v1_";

/** Non-secret singleton group used to serialize webhook event materialization. */
export const WEBHOOK_SELECTION_GROUP_KEY = "webhook-selection-v1";

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Returns the deterministic opaque identifier for one logical executor job. */
export function executorJobId(job: ExecutorJob): string {
  const identity =
    job.kind === "execution.run.v1"
      ? [job.kind, job.payload.projectId, job.payload.executionId]
      : job.kind === "webhook.select.v1"
        ? [job.kind, job.payload.projectId, job.payload.eventId]
        : [job.kind, job.payload.projectId, job.payload.deliveryId];
  return `${JOB_ID_PREFIX}${digest(identity)}`;
}

/** Returns an opaque ordered-delivery group for a project/endpoint pair. */
export function webhookEndpointGroupKey(
  projectId: string,
  endpointId: string,
): string {
  return `${GROUP_KEY_PREFIX}${digest([projectId, endpointId])}`;
}

export function queueNameForJob(job: ExecutorJob): JobQueueName {
  switch (job.kind) {
    case "execution.run.v1":
      return "execution";
    case "webhook.select.v1":
      return "webhook-selection";
    case "webhook.deliver.v1":
      return "webhook-delivery";
  }
}

/** Compares serialized job descriptions without depending on JSON key order. */
export function sameExecutorJob(
  left: ExecutorJob,
  right: ExecutorJob,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "execution.run.v1":
      return (
        right.kind === left.kind &&
        left.payload.projectId === right.payload.projectId &&
        left.payload.executionId === right.payload.executionId
      );
    case "webhook.select.v1":
      return (
        right.kind === left.kind &&
        left.payload.projectId === right.payload.projectId &&
        left.payload.eventId === right.payload.eventId
      );
    case "webhook.deliver.v1":
      return (
        right.kind === left.kind &&
        left.payload.projectId === right.payload.projectId &&
        left.payload.deliveryId === right.payload.deliveryId
      );
  }
}

function hasIdPayload(
  value: unknown,
  id: "executionId" | "eventId" | "deliveryId",
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Readonly<Record<string, unknown>>;
  return (
    typeof payload.projectId === "string" &&
    payload.projectId.length > 0 &&
    typeof payload[id] === "string" &&
    payload[id].length > 0 &&
    Object.keys(payload).length === 2
  );
}

/** Runtime guard for rows that may predate the current worker binary. */
export function isExecutorJob(value: unknown): value is ExecutorJob {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  if (typeof candidate.kind !== "string" || !("payload" in candidate)) {
    return false;
  }
  switch (candidate.kind) {
    case "execution.run.v1":
      return hasIdPayload(candidate.payload, "executionId");
    case "webhook.select.v1":
      return hasIdPayload(candidate.payload, "eventId");
    case "webhook.deliver.v1":
      return hasIdPayload(candidate.payload, "deliveryId");
    default:
      return false;
  }
}

export function createJobEnvelope(
  job: ExecutorJob,
  options: SubmitJobOptions = {},
  now = new Date(),
): JobEnvelope {
  const runAfter = options.runAfter ?? now.toISOString();
  if (!Number.isFinite(Date.parse(runAfter))) {
    throw new TypeError("Job runAfter must be a valid timestamp.");
  }
  if (
    options.groupOrder !== undefined &&
    (!Number.isSafeInteger(options.groupOrder) || options.groupOrder < 0)
  ) {
    throw new RangeError("Job groupOrder must be a non-negative safe integer.");
  }
  if (options.groupKey !== undefined && options.groupKey.length === 0) {
    throw new TypeError("Job groupKey must not be empty.");
  }
  if ((options.groupKey === undefined) !== (options.groupOrder === undefined)) {
    throw new TypeError(
      "Job groupKey and groupOrder must be supplied together.",
    );
  }
  return {
    jobId: executorJobId(job),
    queueName: queueNameForJob(job),
    description: structuredClone(job),
    ...(options.groupKey === undefined
      ? {}
      : {
          groupKey: options.groupKey,
          groupOrder: options.groupOrder,
        }),
    runAfter: new Date(runAfter).toISOString(),
  };
}
