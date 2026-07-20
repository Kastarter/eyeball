import { randomUUID } from "node:crypto";
import type {
  ClaimedJob,
  EnsureJobResult,
  JobStore,
  LeaseMutation,
  StoredJob,
} from "./store.js";
import { sameImmutableJob } from "./store.js";
import type {
  ExecutorJob,
  JobEnvelope,
  JobQueueName,
  SafeJobErrorCode,
} from "./types.js";
import { sameExecutorJob } from "./types.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new TypeError(`${field} must be a timestamp.`);
  return parsed;
}

function positiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Job store limit must be a positive safe integer.");
  }
}

export class InMemoryJobStore implements JobStore {
  readonly #jobs = new Map<string, StoredJob>();
  #sequence = 0;

  async ensure(job: JobEnvelope): Promise<EnsureJobResult> {
    timestamp(job.runAfter, "Job runAfter");
    const existing = this.#jobs.get(job.jobId);
    if (existing !== undefined) {
      return sameImmutableJob(existing, job)
        ? { kind: "existing", job: copy(existing) }
        : { kind: "conflict" };
    }
    const now = new Date().toISOString();
    const stored: StoredJob = {
      ...copy(job),
      sequence: ++this.#sequence,
      state: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.#jobs.set(job.jobId, stored);
    return { kind: "inserted", job: copy(stored) };
  }

  async get(jobId: string): Promise<StoredJob | undefined> {
    const job = this.#jobs.get(jobId);
    return job === undefined ? undefined : copy(job);
  }

  async expireLeases(input: {
    queueNames: readonly JobQueueName[];
    now: string;
    limit: number;
  }): Promise<number> {
    positiveLimit(input.limit);
    const now = timestamp(input.now, "Lease expiry time");
    const queueNames = new Set(input.queueNames);
    const expired = [...this.#jobs.values()]
      .filter(
        (job) =>
          job.state === "running" &&
          queueNames.has(job.queueName) &&
          job.leaseExpiresAt !== undefined &&
          Date.parse(job.leaseExpiresAt) <= now,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, input.limit);
    for (const job of expired) {
      this.#jobs.set(job.jobId, {
        ...job,
        state: "pending",
        updatedAt: input.now,
        claimedBy: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      });
    }
    return expired.length;
  }

  async claim(input: {
    queueName: JobQueueName;
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<readonly ClaimedJob[]> {
    positiveLimit(input.limit);
    const now = timestamp(input.now, "Claim time");
    if (timestamp(input.leaseExpiresAt, "Lease expiry") <= now) {
      throw new RangeError("Lease expiry must be later than claim time.");
    }
    const nonterminal = [...this.#jobs.values()].filter(
      (job) => job.state === "pending" || job.state === "running",
    );
    const eligible = [...this.#jobs.values()]
      .filter(
        (job) =>
          job.state === "pending" &&
          job.queueName === input.queueName &&
          Date.parse(job.runAfter) <= now &&
          !this.#hasEarlierGroupJob(job, nonterminal),
      )
      .sort(
        (left, right) =>
          Date.parse(left.runAfter) - Date.parse(right.runAfter) ||
          left.sequence - right.sequence,
      )
      .slice(0, input.limit);
    return eligible.map((job) => {
      const claimed: ClaimedJob = {
        ...job,
        state: "running",
        attempts: job.attempts + 1,
        claimedBy: input.workerId,
        leaseToken: randomUUID(),
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.now,
      };
      this.#jobs.set(job.jobId, claimed);
      return copy(claimed);
    });
  }

  async renew(
    input: LeaseMutation & { readonly leaseExpiresAt: string },
  ): Promise<boolean> {
    const current = this.#leased(input);
    if (current === undefined) return false;
    if (
      timestamp(input.leaseExpiresAt, "Lease expiry") <= Date.parse(input.now)
    ) {
      return false;
    }
    const currentLeaseExpiresAt = current.leaseExpiresAt;
    if (currentLeaseExpiresAt === undefined) return false;
    const leaseExpiresAt =
      Date.parse(input.leaseExpiresAt) > Date.parse(currentLeaseExpiresAt)
        ? input.leaseExpiresAt
        : currentLeaseExpiresAt;
    const updatedAt =
      Date.parse(input.now) > Date.parse(current.updatedAt)
        ? input.now
        : current.updatedAt;
    this.#jobs.set(current.jobId, {
      ...current,
      leaseExpiresAt,
      updatedAt,
    });
    return true;
  }

  async complete(input: LeaseMutation): Promise<boolean> {
    return this.#finish(input, "succeeded");
  }

  async reschedule(
    input: LeaseMutation & { readonly runAfter: string },
  ): Promise<boolean> {
    timestamp(input.runAfter, "Job runAfter");
    const current = this.#leased(input);
    if (current === undefined) return false;
    this.#jobs.set(current.jobId, {
      ...current,
      state: "pending",
      runAfter: new Date(input.runAfter).toISOString(),
      claimedBy: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: input.now,
      completedAt: undefined,
    });
    return true;
  }

  async fail(
    input: LeaseMutation & { readonly errorCode: SafeJobErrorCode },
  ): Promise<boolean> {
    return this.#finish(input, "failed", input.errorCode);
  }

  async release(input: LeaseMutation): Promise<boolean> {
    const current = this.#leased(input);
    if (current === undefined) return false;
    this.#jobs.set(current.jobId, {
      ...current,
      state: "pending",
      claimedBy: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: input.now,
    });
    return true;
  }

  async listAttachedTerminal(
    jobIds: readonly string[],
  ): Promise<readonly StoredJob[]> {
    return jobIds.flatMap((jobId) => {
      const job = this.#jobs.get(jobId);
      return job !== undefined &&
        (job.state === "succeeded" || job.state === "failed")
        ? [copy(job)]
        : [];
    });
  }

  async reopenForRecovery(input: {
    readonly jobId: string;
    readonly expectedDescription: ExecutorJob;
    readonly runAfter: string;
  }): Promise<boolean> {
    const current = this.#jobs.get(input.jobId);
    if (
      current === undefined ||
      (current.state !== "succeeded" && current.state !== "failed") ||
      !sameExecutorJob(current.description, input.expectedDescription)
    ) {
      return false;
    }
    timestamp(input.runAfter, "Recovery runAfter");
    this.#jobs.set(current.jobId, {
      ...current,
      state: "pending",
      runAfter: new Date(input.runAfter).toISOString(),
      claimedBy: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      lastErrorCode: undefined,
      completedAt: undefined,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  #hasEarlierGroupJob(
    job: StoredJob,
    nonterminal: readonly StoredJob[],
  ): boolean {
    if (job.groupKey === undefined || job.groupOrder === undefined)
      return false;
    const groupOrder = job.groupOrder;
    return nonterminal.some(
      (candidate) =>
        candidate.jobId !== job.jobId &&
        candidate.queueName === job.queueName &&
        candidate.groupKey === job.groupKey &&
        candidate.groupOrder !== undefined &&
        (candidate.groupOrder < groupOrder ||
          (candidate.groupOrder === groupOrder &&
            candidate.sequence < job.sequence)),
    );
  }

  #leased(input: LeaseMutation): StoredJob | undefined {
    const current = this.#jobs.get(input.jobId);
    return current?.state === "running" &&
      current.claimedBy === input.workerId &&
      current.leaseToken === input.leaseToken &&
      current.leaseExpiresAt !== undefined &&
      Date.parse(current.leaseExpiresAt) >
        timestamp(input.now, "Lease mutation time")
      ? current
      : undefined;
  }

  #finish(
    input: LeaseMutation,
    state: "succeeded" | "failed",
    errorCode?: SafeJobErrorCode,
  ): boolean {
    const current = this.#leased(input);
    if (current === undefined) return false;
    this.#jobs.set(current.jobId, {
      ...current,
      state,
      claimedBy: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      ...(errorCode === undefined
        ? { lastErrorCode: undefined }
        : { lastErrorCode: errorCode }),
      completedAt: input.now,
      updatedAt: input.now,
    });
    return true;
  }
}
