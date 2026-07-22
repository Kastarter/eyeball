import type {
  ExecutorJob,
  JobEnvelope,
  JobQueueName,
  SafeJobErrorCode,
} from "./types.js";
import { sameExecutorJob } from "./types.js";

export type JobState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface StoredJob extends JobEnvelope {
  readonly sequence: number;
  readonly state: JobState;
  readonly attempts: number;
  readonly claimedBy?: string | undefined;
  readonly leaseToken?: string | undefined;
  readonly leaseExpiresAt?: string | undefined;
  readonly lastErrorCode?: SafeJobErrorCode | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | undefined;
}

export interface ClaimedJob extends StoredJob {
  readonly state: "running";
  readonly claimedBy: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export type EnsureJobResult =
  | { readonly kind: "inserted"; readonly job: StoredJob }
  | { readonly kind: "existing"; readonly job: StoredJob }
  | { readonly kind: "conflict" };

export type CancelPendingJobResult =
  | { readonly kind: "cancelled"; readonly job: StoredJob }
  | { readonly kind: "already_cancelled"; readonly job: StoredJob }
  | { readonly kind: "running"; readonly job: ClaimedJob }
  | { readonly kind: "already_terminal"; readonly job: StoredJob }
  | { readonly kind: "missing" }
  | { readonly kind: "conflict" };

export interface LeaseMutation {
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly now: string;
}

/** Durable state-machine contract shared by memory, pg, and PGlite. */
export interface JobStore {
  ensure(job: JobEnvelope): Promise<EnsureJobResult>;
  get(jobId: string): Promise<StoredJob | undefined>;
  cancelPending(input: {
    readonly jobId: string;
    readonly expectedDescription: ExecutorJob;
    readonly now: string;
  }): Promise<CancelPendingJobResult>;
  expireLeases(input: {
    queueNames: readonly JobQueueName[];
    now: string;
    limit: number;
  }): Promise<number>;
  claim(input: {
    queueName: JobQueueName;
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<readonly ClaimedJob[]>;
  renew(
    input: LeaseMutation & { readonly leaseExpiresAt: string },
  ): Promise<boolean>;
  complete(input: LeaseMutation): Promise<boolean>;
  cancelClaimed(input: LeaseMutation): Promise<boolean>;
  reschedule(
    input: LeaseMutation & { readonly runAfter: string },
  ): Promise<boolean>;
  fail(
    input: LeaseMutation & { readonly errorCode: SafeJobErrorCode },
  ): Promise<boolean>;
  release(input: LeaseMutation): Promise<boolean>;
  listAttachedTerminal(
    jobIds: readonly string[],
  ): Promise<readonly StoredJob[]>;
  reopenForRecovery(input: {
    readonly jobId: string;
    readonly expectedDescription: ExecutorJob;
    readonly runAfter: string;
  }): Promise<boolean>;
}

export function sameImmutableJob(
  left: JobEnvelope,
  right: JobEnvelope,
): boolean {
  return (
    left.jobId === right.jobId &&
    left.queueName === right.queueName &&
    sameExecutorJob(left.description, right.description) &&
    left.groupKey === right.groupKey &&
    left.groupOrder === right.groupOrder
  );
}
