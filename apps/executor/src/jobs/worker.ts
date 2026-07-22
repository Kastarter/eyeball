import { randomUUID } from "node:crypto";
import {
  type Clock,
  type ExecutorLogger,
  noopLogger,
  systemClock,
} from "@eyeball/core";
import type { JobSubmission, ManagedTaskQueue } from "../queue.js";
import type {
  JobHandlerContext,
  JobHandlerRegistry,
  JobHandlerResult,
} from "./handlers.js";
import { InMemoryJobStore } from "./memory-store.js";
import type { ClaimedJob, JobStore, StoredJob } from "./store.js";
import {
  createJobEnvelope,
  type ExecutorJob,
  isExecutorJob,
  type JobQueueName,
  queueNameForJob,
  type SubmitJobOptions,
} from "./types.js";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_POLL_MS = 100;
const ALL_QUEUES: readonly JobQueueName[] = [
  "execution",
  "webhook-selection",
  "webhook-delivery",
];

export class QueueHandoffError extends Error {
  constructor() {
    super("Durable job ownership was handed off during local shutdown.");
    this.name = "QueueHandoffError";
  }
}

export class QueueJobFailedError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("The queued job reached a permanent failed state.");
    this.name = "QueueJobFailedError";
    this.code = code;
  }
}

export class QueueJobConflictError extends Error {
  constructor() {
    super("A deterministic job ID was reused with different immutable fields.");
    this.name = "QueueJobConflictError";
  }
}

export class QueueNotAcceptingError extends Error {
  constructor() {
    super("The executor queue is not accepting new work.");
    this.name = "QueueNotAcceptingError";
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function validDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

export interface ExecutorTaskSystemOptions {
  readonly jobStore: JobStore;
  readonly clock?: Clock;
  readonly logger?: ExecutorLogger;
  readonly workerId?: string;
  readonly executionConcurrency?: number;
  readonly webhookSelectionConcurrency?: number;
  readonly webhookDeliveryConcurrency?: number;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  readonly durable?: boolean;
  readonly manual?: boolean;
}

/** Lease-fenced three-lane executor worker and scoped submission facade. */
export class ExecutorTaskSystem implements ManagedTaskQueue {
  readonly jobStore: JobStore;
  readonly workerId: string;
  readonly #clock: Clock;
  readonly #logger: ExecutorLogger;
  readonly #concurrency: Readonly<Record<JobQueueName, number>>;
  readonly #active = new Map<string, Promise<void>>();
  readonly #attached = new Map<string, Deferred>();
  readonly #idleWaiters = new Set<() => void>();
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #pollMs: number;
  readonly #durable: boolean;
  readonly #manual: boolean;
  #handlers?: JobHandlerRegistry;
  #started = false;
  #accepting = true;
  #claiming = false;
  #tick: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ExecutorTaskSystemOptions) {
    this.jobStore = options.jobStore;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? noopLogger;
    this.workerId = options.workerId ?? randomUUID();
    if (this.workerId.length === 0)
      throw new TypeError("Worker ID must not be empty.");
    this.#concurrency = {
      execution: positiveInteger(
        options.executionConcurrency ?? 4,
        "Execution concurrency",
      ),
      "webhook-selection": positiveInteger(
        options.webhookSelectionConcurrency ?? 1,
        "Webhook selection concurrency",
      ),
      "webhook-delivery": positiveInteger(
        options.webhookDeliveryConcurrency ?? 4,
        "Webhook delivery concurrency",
      ),
    };
    this.#leaseMs = validDuration(
      options.leaseMs ?? DEFAULT_LEASE_MS,
      "Lease duration",
    );
    this.#heartbeatMs = validDuration(
      options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      "Heartbeat interval",
    );
    this.#pollMs = validDuration(
      options.pollMs ?? DEFAULT_POLL_MS,
      "Poll interval",
    );
    if (this.#heartbeatMs >= this.#leaseMs) {
      throw new RangeError(
        "Heartbeat interval must be shorter than the lease duration.",
      );
    }
    this.#durable = options.durable ?? false;
    this.#manual = options.manual ?? false;
  }

  bindHandlers(handlers: JobHandlerRegistry): void {
    if (this.#started)
      throw new Error("Queue handlers must be bound before start.");
    this.#handlers = handlers;
  }

  start(): void {
    if (this.#handlers === undefined) {
      throw new Error("Every executor job handler must be bound before start.");
    }
    if (this.#started) return;
    this.#started = true;
    this.#claiming = true;
    this.#wake();
  }

  async checkReadiness(signal?: AbortSignal): Promise<void> {
    if (!this.#started || !this.#accepting || !this.#claiming) {
      throw new Error("The executor queue is not accepting work.");
    }
    await this.jobStore.checkReadiness(signal);
  }

  submit(job: ExecutorJob, options: SubmitJobOptions = {}): JobSubmission {
    if (!this.#accepting) {
      const rejected = Promise.reject(new QueueNotAcceptingError());
      void rejected.catch(() => {});
      return { accepted: rejected, completed: rejected };
    }
    const envelope = createJobEnvelope(job, options, this.#now());
    const completion = this.#attached.get(envelope.jobId) ?? deferred();
    this.#attached.set(envelope.jobId, completion);
    const accepted = this.jobStore.ensure(envelope).then((result) => {
      if (result.kind === "conflict") throw new QueueJobConflictError();
      this.#settleTerminal(result.job);
      this.#wake();
    });
    void accepted.catch((error) => {
      completion.reject(error);
      this.#attached.delete(envelope.jobId);
      this.#resolveIdle();
    });
    return { accepted, completed: completion.promise };
  }

  enqueue(job: ExecutorJob, options?: SubmitJobOptions): Promise<void> {
    return this.submit(job, options).completed;
  }

  onIdle(): Promise<void> {
    if (this.#attached.size === 0 && this.#active.size === 0)
      return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  async stopClaiming(): Promise<void> {
    this.#accepting = false;
    this.#claiming = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#tick;
  }

  async drainOwned(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.allSettled([...this.#active.values()]);
    }
  }

  async handoffPending(): Promise<void> {
    if (!this.#durable) {
      if (!this.#claiming) {
        this.#claiming = true;
        this.#wake();
      }
      await this.onIdle();
      this.#claiming = false;
      return;
    }
    const error = new QueueHandoffError();
    for (const pending of this.#attached.values()) pending.reject(error);
    this.#attached.clear();
    this.#resolveIdle();
  }

  /** Executes one deterministic expiry/observation/claim cycle for tests and recovery. */
  async runOnce(): Promise<void> {
    if (this.#handlers === undefined)
      throw new Error("Queue handlers are not bound.");
    const now = this.#now();
    await this.jobStore.expireLeases({
      queueNames: ALL_QUEUES,
      now: now.toISOString(),
      limit: 1_000,
    });
    await this.#observeAttached();
    if (!this.#claiming) return;
    for (const queueName of ALL_QUEUES) {
      const active =
        [...this.#active.values()].length === 0
          ? 0
          : [...this.#active.keys()].filter((key) =>
              key.startsWith(`${queueName}:`),
            ).length;
      const available = this.#concurrency[queueName] - active;
      if (available < 1) continue;
      const claimed = await this.jobStore.claim({
        queueName,
        workerId: this.workerId,
        now: now.toISOString(),
        leaseExpiresAt: new Date(now.valueOf() + this.#leaseMs).toISOString(),
        limit: available,
      });
      for (const job of claimed) this.#begin(job);
    }
  }

  #wake(): void {
    if (!this.#started || !this.#claiming) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    queueMicrotask(() => this.#scheduleTick());
  }

  #scheduleTick(): void {
    if (!this.#started || !this.#claiming || this.#tick !== undefined) return;
    const tick = this.runOnce()
      .catch(() => {
        this.#logger.error("queue.poll_failed", { worker: "executor" });
      })
      .finally(() => {
        if (this.#tick === tick) this.#tick = undefined;
        if (this.#claiming && !this.#manual) {
          this.#timer = setTimeout(() => this.#scheduleTick(), this.#pollMs);
          this.#timer.unref?.();
        }
      });
    this.#tick = tick;
  }

  #begin(job: ClaimedJob): void {
    const key = `${job.queueName}:${job.jobId}`;
    const work = this.#run(job).finally(() => {
      this.#active.delete(key);
      this.#resolveIdle();
      this.#wake();
    });
    this.#active.set(key, work);
  }

  async #run(job: ClaimedJob): Promise<void> {
    const handlers = this.#handlers;
    if (handlers === undefined) return;
    const controller = new AbortController();
    let leaseLost = false;
    let heartbeatRenewal: Promise<void> | undefined;
    const renewLease = async (): Promise<void> => {
      try {
        const now = this.#now();
        const renewed = await this.jobStore.renew({
          jobId: job.jobId,
          workerId: this.workerId,
          leaseToken: job.leaseToken,
          now: now.toISOString(),
          leaseExpiresAt: new Date(now.valueOf() + this.#leaseMs).toISOString(),
        });
        if (!renewed) {
          leaseLost = true;
          controller.abort(new Error("Queue lease was lost."));
        }
      } catch {
        leaseLost = true;
        controller.abort(new Error("Queue lease renewal failed."));
      }
    };
    const heartbeat = setInterval(() => {
      if (heartbeatRenewal !== undefined) return;
      heartbeatRenewal = renewLease().finally(() => {
        heartbeatRenewal = undefined;
      });
    }, this.#heartbeatMs);
    heartbeat.unref?.();
    const startedAt = this.#now().valueOf();
    let result: JobHandlerResult;
    try {
      if (
        !isExecutorJob(job.description) ||
        queueNameForJob(job.description) !== job.queueName
      ) {
        result = { type: "fail", errorCode: "invalid_job_version" };
      } else {
        const description = job.description;
        const context: JobHandlerContext = {
          jobId: job.jobId,
          queueName: job.queueName,
          leaseAttempt: job.attempts,
          signal: controller.signal,
          now: () => this.#now().toISOString(),
        };
        switch (description.kind) {
          case "execution.run.v1":
            result = await Promise.resolve().then(() =>
              handlers["execution.run.v1"](description.payload, context),
            );
            break;
          case "webhook.select.v1":
            result = await Promise.resolve().then(() =>
              handlers["webhook.select.v1"](description.payload, context),
            );
            break;
          case "webhook.deliver.v1":
            result = await Promise.resolve().then(() =>
              handlers["webhook.deliver.v1"](description.payload, context),
            );
            break;
        }
      }
    } catch {
      result = { type: "fail", errorCode: "handler_rejected" };
    } finally {
      clearInterval(heartbeat);
      await heartbeatRenewal;
    }
    if (leaseLost) return;
    const now = this.#now().toISOString();
    const mutation = {
      jobId: job.jobId,
      workerId: this.workerId,
      leaseToken: job.leaseToken,
      now,
    };
    const persisted =
      result.type === "complete"
        ? await this.jobStore.complete(mutation)
        : result.type === "cancelled"
          ? await this.jobStore.cancelClaimed(mutation)
          : result.type === "reschedule"
            ? await this.jobStore.reschedule({
                ...mutation,
                runAfter: result.runAfter,
              })
            : await this.jobStore.fail({
                ...mutation,
                errorCode: result.errorCode,
              });
    if (!persisted) {
      controller.abort(new Error("Queue result was fenced by a lost lease."));
      return;
    }
    const duration = Math.max(0, this.#now().valueOf() - startedAt);
    this.#logger.info("queue.job_finished", {
      jobId: job.jobId,
      kind: isExecutorJob(job.description) ? job.description.kind : "unknown",
      queueName: job.queueName,
      leaseAttempt: job.attempts,
      duration,
      result: result.type,
    });
    if (result.type === "complete") {
      this.#settleTerminal({
        ...job,
        state: "succeeded",
        completedAt: now,
        updatedAt: now,
      });
    } else if (result.type === "cancelled") {
      this.#settleTerminal({
        ...job,
        state: "cancelled",
        completedAt: now,
        updatedAt: now,
      });
    } else if (result.type === "fail") {
      this.#settleTerminal({
        ...job,
        state: "failed",
        lastErrorCode: result.errorCode,
        completedAt: now,
        updatedAt: now,
      });
    }
  }

  async #observeAttached(): Promise<void> {
    const ids = [...this.#attached.keys()];
    if (ids.length === 0) return;
    const terminal = await this.jobStore.listAttachedTerminal(ids);
    for (const job of terminal) this.#settleTerminal(job);
  }

  #settleTerminal(job: StoredJob): void {
    if (
      job.state !== "succeeded" &&
      job.state !== "failed" &&
      job.state !== "cancelled"
    )
      return;
    const completion = this.#attached.get(job.jobId);
    if (completion === undefined) return;
    this.#attached.delete(job.jobId);
    if (job.state === "succeeded" || job.state === "cancelled")
      completion.resolve();
    else
      completion.reject(
        new QueueJobFailedError(job.lastErrorCode ?? "handler_rejected"),
      );
    this.#resolveIdle();
  }

  #resolveIdle(): void {
    if (this.#attached.size !== 0 || this.#active.size !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  #now(): Date {
    const value = this.#clock.now();
    if (Number.isNaN(value.valueOf()))
      throw new Error("Queue clock returned an invalid date.");
    return new Date(value.valueOf());
  }
}

export interface InMemoryTaskQueueOptions
  extends Omit<ExecutorTaskSystemOptions, "jobStore" | "durable"> {
  readonly jobStore?: InMemoryJobStore;
}

/** Zero-config serializable queue with the same state machine as Postgres. */
export class InMemoryTaskQueue extends ExecutorTaskSystem {
  constructor(options: InMemoryTaskQueueOptions = {}) {
    super({
      ...options,
      jobStore: options.jobStore ?? new InMemoryJobStore(),
      durable: false,
    });
  }
}

/** @deprecated Use InMemoryTaskQueue; closure tasks are no longer supported. */
export const PromiseTaskQueue = InMemoryTaskQueue;
