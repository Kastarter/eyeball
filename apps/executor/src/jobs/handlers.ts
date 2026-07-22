import type { ExecutorJob, JobEnvelope, SafeJobErrorCode } from "./types.js";

export interface JobHandlerContext {
  readonly jobId: string;
  readonly queueName: JobEnvelope["queueName"];
  readonly leaseAttempt: number;
  readonly signal: AbortSignal;
  readonly now: () => string;
}

export type JobHandlerResult =
  | { readonly type: "complete" }
  | { readonly type: "cancelled" }
  | { readonly type: "reschedule"; readonly runAfter: string }
  | { readonly type: "fail"; readonly errorCode: SafeJobErrorCode };

export type JobHandler<K extends ExecutorJob["kind"]> = (
  payload: Readonly<Extract<ExecutorJob, { kind: K }>["payload"]>,
  context: JobHandlerContext,
) => Promise<JobHandlerResult>;

export type JobHandlerRegistry = {
  [K in ExecutorJob["kind"]]: JobHandler<K>;
};

export interface ExecutionJobHandlerTarget {
  runExecutionJob(
    payload: Readonly<
      Extract<ExecutorJob, { kind: "execution.run.v1" }>["payload"]
    >,
    context: JobHandlerContext,
  ): Promise<JobHandlerResult>;
}

export interface WebhookJobHandlerTarget {
  handleWebhookSelectJob(
    payload: Readonly<
      Extract<ExecutorJob, { kind: "webhook.select.v1" }>["payload"]
    >,
    context: JobHandlerContext,
  ): Promise<JobHandlerResult>;
  handleWebhookDeliverJob(
    payload: Readonly<
      Extract<ExecutorJob, { kind: "webhook.deliver.v1" }>["payload"]
    >,
    context: JobHandlerContext,
  ): Promise<JobHandlerResult>;
}

/** Binds every persisted job version to runtime-only execution dependencies. */
export function createExecutorJobHandlerRegistry(input: {
  readonly engine: ExecutionJobHandlerTarget;
  readonly webhookDeliverer: WebhookJobHandlerTarget;
}): JobHandlerRegistry {
  return {
    "execution.run.v1": (payload, context) =>
      input.engine.runExecutionJob(payload, context),
    "webhook.select.v1": (payload, context) =>
      input.webhookDeliverer.handleWebhookSelectJob(payload, context),
    "webhook.deliver.v1": (payload, context) =>
      input.webhookDeliverer.handleWebhookDeliverJob(payload, context),
  };
}
