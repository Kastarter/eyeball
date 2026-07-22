import type { JobHandlerRegistry } from "./jobs/handlers.js";
import type { JobStore } from "./jobs/store.js";
import type { ExecutorJob, SubmitJobOptions } from "./jobs/types.js";

export interface JobSubmission {
  /** Resolves after the job is inserted or an identical deterministic job exists. */
  readonly accepted: Promise<void>;
  /** Resolves at logical completion and rejects on permanent failure or handoff. */
  readonly completed: Promise<void>;
}

export interface TaskQueue<J extends ExecutorJob = ExecutorJob> {
  readonly jobStore: JobStore;
  /** Rejects when this process is not admitting work to the queue. */
  checkReadiness(signal?: AbortSignal): Promise<void>;
  submit(job: J, options?: SubmitJobOptions): JobSubmission;
  /** Compatibility convenience with completion, rather than admission, semantics. */
  enqueue(job: J, options?: SubmitJobOptions): Promise<void>;
  onIdle(): Promise<void>;
}

export interface ManagedTaskQueue<J extends ExecutorJob = ExecutorJob>
  extends TaskQueue<J> {
  bindHandlers(handlers: JobHandlerRegistry): void;
  start(): void;
  stopClaiming(): Promise<void>;
  drainOwned(): Promise<void>;
  handoffPending(): Promise<void>;
}

export * from "./jobs/handlers.js";
export * from "./jobs/memory-store.js";
export * from "./jobs/recovery.js";
export * from "./jobs/store.js";
export * from "./jobs/types.js";
export * from "./jobs/worker.js";
