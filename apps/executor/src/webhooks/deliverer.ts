import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createWebhookSignature,
  type ExecutionRecord,
  type QualifiedTriggerName,
  type TranscriptArtifact,
  type TriggerEventData,
  type TriggerWebhookEvent,
  type VoiceAgentSessionEvent,
  type VoiceSessionWebhookEvent,
  type VoiceTranscriptWebhookEvent,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_HEADER_ALIAS,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_HEADER_ALIAS,
  type WebhookDelivery,
  type WebhookDeliveryAttempt,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookSubscriptionEventType,
} from "@eyeball/core";
import type { Clock, ExecutorLogger } from "../adapters/index.js";
import { systemClock } from "../adapters/index.js";
import {
  InMemoryTaskQueue,
  type JobHandlerContext,
  type JobHandlerResult,
  type TaskQueue,
  WEBHOOK_SELECTION_GROUP_KEY,
  webhookEndpointGroupKey,
} from "../queue.js";
import type { ExecutionStore } from "../store.js";
import {
  createExecutorTelemetryRuntime,
  type ExecutorTelemetryRuntime,
  markSpanError,
  markSpanOk,
} from "../telemetry/index.js";
import {
  InMemoryWebhookDeliveryStore,
  type WebhookDeliveryStore,
} from "./delivery-store.js";
import {
  InMemoryWebhookEndpointStore,
  type StoredWebhookEndpoint,
  type WebhookEndpointStore,
} from "./endpoint-store.js";
import { InMemoryWebhookWorkStore } from "./memory-work-store.js";
import type {
  WebhookEventSourceKind,
  WebhookEventWork,
  WebhookWorkStore,
} from "./work-store.js";

export const DEFAULT_WEBHOOK_RETRY_DELAYS_MS = [
  0,
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
] as const;
export const DEFAULT_WEBHOOK_ATTEMPT_TIMEOUT_MS = 10_000;

/** @deprecated Retry waiting is now represented by durable job runAfter values. */
export type WebhookSleep = (milliseconds: number) => Promise<void>;

export interface WebhookDelivererOptions {
  endpointStore?: WebhookEndpointStore;
  deliveryStore?: WebhookDeliveryStore;
  workStore?: WebhookWorkStore;
  executionStore?: ExecutionStore;
  queue?: TaskQueue;
  fetchImpl?: typeof globalThis.fetch;
  clock?: Clock;
  /** @deprecated Durable retries no longer sleep inside a handler. */
  sleep?: WebhookSleep;
  telemetry?: ExecutorTelemetryRuntime;
  /** @deprecated Pass telemetry from ExecutionEngine instead. */
  logger?: ExecutorLogger;
  retryDelaysMs?: readonly number[];
  attemptConcurrency?: number;
  attemptTimeoutMs?: number;
  eventIdFactory?: () => string;
}

export interface EnqueueVoiceSessionEventInput {
  projectId: string;
  endpointIds: readonly string[];
  event: VoiceAgentSessionEvent;
}

export interface EnqueueVoiceTranscriptInput {
  projectId: string;
  endpointIds: readonly string[];
  transcript: TranscriptArtifact;
  createdAt?: string;
}

export interface EnqueueTriggerEventInput {
  projectId: string;
  endpointIds: readonly string[];
  trigger: QualifiedTriggerName;
  data: TriggerEventData;
  createdAt?: string;
  /** Stable provider-derived ID when one is available. */
  eventId?: string;
}

function eventId(): string {
  return `evt_${randomUUID().replaceAll("-", "")}`;
}

function withoutNextRetry(
  delivery: WebhookDelivery,
): Omit<WebhookDelivery, "nextRetryAt"> {
  const { nextRetryAt: _nextRetryAt, ...result } = delivery;
  return result;
}

function subscribed(
  events: readonly WebhookSubscriptionEventType[],
  eventType: WebhookEventType,
): boolean {
  if (
    (eventType === "execution.succeeded" || eventType === "execution.failed") &&
    events.includes("execution.completed")
  ) {
    return true;
  }
  if (eventType.startsWith("trigger.") && events.includes("trigger.*")) {
    return true;
  }
  return events.includes(eventType);
}

function terminalExecution(
  record: ExecutionRecord,
): record is ExecutionRecord & { status: "succeeded" | "failed" } {
  return record.status === "succeeded" || record.status === "failed";
}

function validRetryDelays(delays: readonly number[]): readonly number[] {
  if (
    delays.length === 0 ||
    delays[0] !== 0 ||
    delays.some((delay) => !Number.isSafeInteger(delay) || delay < 0)
  ) {
    throw new TypeError(
      "Webhook retry delays must start at zero and contain non-negative safe integers.",
    );
  }
  return [...delays];
}

function validAttemptTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      "Webhook attempt timeout must be a positive safe integer.",
    );
  }
  return value;
}

class WebhookAttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Webhook request timed out after ${timeoutMs}ms.`);
    this.name = "WebhookAttemptTimeoutError";
  }
}

/**
 * Durable signed webhook dispatcher. Event materialization is serialized, HTTP
 * work is bounded at four by default, and hashed project/endpoint queue groups
 * retain concurrency one across replicas.
 */
export class WebhookDeliverer {
  readonly endpointStore: WebhookEndpointStore;
  readonly deliveryStore: WebhookDeliveryStore;
  readonly workStore: WebhookWorkStore;
  readonly retryDelaysMs: readonly number[];
  readonly queue: TaskQueue;
  readonly #fetchImpl: typeof globalThis.fetch;
  readonly #clock: Clock;
  readonly #logger: ExecutorLogger;
  readonly #telemetry: ExecutorTelemetryRuntime;
  readonly #attemptTimeoutMs: number;
  readonly #eventIdFactory: () => string;
  readonly #retryWake: WebhookSleep | undefined;
  readonly #executionStore: ExecutionStore | undefined;
  readonly #volatileEvents = new Map<string, WebhookEvent>();
  readonly #admissions = new Set<Promise<void>>();
  readonly #ownedQueue?: InMemoryTaskQueue;

  constructor(options: WebhookDelivererOptions = {}) {
    this.endpointStore =
      options.endpointStore ?? new InMemoryWebhookEndpointStore();
    this.deliveryStore =
      options.deliveryStore ?? new InMemoryWebhookDeliveryStore();
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#clock = options.clock ?? systemClock;
    this.#telemetry =
      options.telemetry ??
      createExecutorTelemetryRuntime(
        options.logger === undefined ? {} : { logger: options.logger },
      );
    this.#logger = this.#telemetry.logger;
    this.retryDelaysMs = validRetryDelays(
      options.retryDelaysMs ?? DEFAULT_WEBHOOK_RETRY_DELAYS_MS,
    );
    this.#attemptTimeoutMs = validAttemptTimeout(
      options.attemptTimeoutMs ?? DEFAULT_WEBHOOK_ATTEMPT_TIMEOUT_MS,
    );
    this.#eventIdFactory = options.eventIdFactory ?? eventId;
    this.#retryWake = options.sleep;
    this.#executionStore = options.executionStore;
    let ownedQueue: InMemoryTaskQueue | undefined;
    if (options.queue === undefined) {
      ownedQueue = new InMemoryTaskQueue({
        clock: this.#clock,
        logger: this.#logger,
        webhookDeliveryConcurrency: options.attemptConcurrency ?? 4,
      });
      this.queue = ownedQueue;
    } else {
      this.queue = options.queue;
    }
    this.workStore =
      options.workStore ??
      new InMemoryWebhookWorkStore(this.deliveryStore, this.queue.jobStore);
    if (ownedQueue !== undefined) {
      ownedQueue.bindHandlers({
        "execution.run.v1": async () => ({ type: "complete" }),
        "webhook.select.v1": (payload, context) =>
          this.handleWebhookSelectJob(payload, context),
        "webhook.deliver.v1": (payload, context) =>
          this.handleWebhookDeliverJob(payload, context),
      });
      ownedQueue.start();
      this.#ownedQueue = ownedQueue;
    }
  }

  /**
   * Durably admits a terminal execution event and its ID-only selection job.
   *
   * @param projectId Authenticated project boundary.
   * @param record Terminal execution snapshot.
   * @param stableEventId Preallocated recovery identity when available.
   */
  async enqueueExecution(
    projectId: string,
    record: ExecutionRecord,
    stableEventId?: string,
  ): Promise<void> {
    const snapshot = structuredClone(record);
    if (!terminalExecution(snapshot)) {
      throw new Error("Only terminal executions can emit webhook events.");
    }
    const event: WebhookEvent = {
      id: stableEventId ?? this.#eventIdFactory(),
      type:
        snapshot.status === "succeeded"
          ? "execution.succeeded"
          : "execution.failed",
      createdAt: snapshot.completedAt ?? this.#now().toISOString(),
      projectId,
      data: snapshot,
    };
    await this.#admit(event, null, "execution", snapshot.executionId);
  }

  /** Durably admits an observed voice-session event for selected endpoints. */
  async enqueueVoiceSessionEvent(
    input: EnqueueVoiceSessionEventInput,
  ): Promise<void> {
    const snapshot = structuredClone(input);
    const event: VoiceSessionWebhookEvent = {
      id: snapshot.event.id,
      type: "voice.session.event",
      createdAt: snapshot.event.createdAt,
      projectId: snapshot.projectId,
      data: snapshot.event,
    };
    await this.#admit(
      event,
      snapshot.endpointIds,
      "voice-session-event",
      snapshot.event.id,
    );
  }

  /** Durably admits a voice transcript event for selected endpoints. */
  async enqueueVoiceTranscript(
    input: EnqueueVoiceTranscriptInput,
  ): Promise<void> {
    const snapshot = structuredClone(input);
    const event: VoiceTranscriptWebhookEvent = {
      id: snapshot.transcript.id,
      type: "voice.transcript.ready",
      createdAt: snapshot.createdAt ?? this.#now().toISOString(),
      projectId: snapshot.projectId,
      data: snapshot.transcript,
    };
    await this.#admit(
      event,
      snapshot.endpointIds,
      "voice-transcript",
      snapshot.transcript.id,
    );
  }

  /** Durably admits a normalized trigger event for selected endpoints. */
  async enqueueTriggerEvent(input: EnqueueTriggerEventInput): Promise<void> {
    const snapshot = structuredClone(input);
    const event: TriggerWebhookEvent = {
      id: snapshot.eventId ?? this.#eventIdFactory(),
      type: `trigger.${snapshot.trigger}`,
      createdAt: snapshot.createdAt ?? this.#now().toISOString(),
      projectId: snapshot.projectId,
      data: snapshot.data,
    };
    await this.#admit(event, snapshot.endpointIds, "trigger", event.id);
  }

  /** Waits for event admission, selection, delivery, and future retries. */
  async onIdle(): Promise<void> {
    while (this.#admissions.size > 0) {
      await Promise.allSettled([...this.#admissions]);
    }
    await this.queue.onIdle();
  }

  async handleWebhookSelectJob(
    payload: Readonly<{ projectId: string; eventId: string }>,
    _context: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const eventWork = await this.workStore.getEvent(
      payload.projectId,
      payload.eventId,
    );
    if (eventWork === undefined) {
      this.#logger.warn("webhook.selection_missing", {
        projectId: payload.projectId,
      });
      return { type: "complete" };
    }
    let deliveries = await this.workStore.getMaterializedDeliveries(
      payload.projectId,
      payload.eventId,
    );
    if (eventWork.materializedAt === undefined) {
      const endpoints = await this.#selectedEndpoints(
        payload.projectId,
        eventWork.eventType,
        eventWork.endpointIds,
      );
      deliveries = await this.workStore.materializeEvent({
        projectId: payload.projectId,
        eventId: payload.eventId,
        endpointIds: endpoints.map((endpoint) => endpoint.endpointId),
        materializedAt: this.#now().toISOString(),
      });
    }
    if (deliveries.length === 0) {
      this.#volatileEvents.delete(
        this.#eventKey(payload.projectId, payload.eventId),
      );
    }
    await Promise.all(
      deliveries.map(async ({ sequence, delivery }) => {
        const submission = this.queue.submit(
          {
            kind: "webhook.deliver.v1",
            payload: {
              projectId: payload.projectId,
              deliveryId: delivery.deliveryId,
            },
          },
          {
            groupKey: webhookEndpointGroupKey(
              payload.projectId,
              delivery.endpointId,
            ),
            groupOrder: sequence,
            runAfter: delivery.nextRetryAt ?? this.#now().toISOString(),
          },
        );
        void submission.completed.catch(() => {
          this.#logger.error("webhook.delivery_job_failed", {
            deliveryId: delivery.deliveryId,
            endpointId: delivery.endpointId,
          });
        });
        await submission.accepted;
      }),
    );
    return { type: "complete" };
  }

  async handleWebhookDeliverJob(
    payload: Readonly<{ projectId: string; deliveryId: string }>,
    context: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    let delivery = await this.deliveryStore.get(
      payload.projectId,
      payload.deliveryId,
    );
    if (
      delivery === undefined ||
      delivery.status === "succeeded" ||
      delivery.status === "failed"
    ) {
      return { type: "complete" };
    }
    const now = this.#now();
    if (
      delivery.nextRetryAt !== undefined &&
      Date.parse(delivery.nextRetryAt) > now.valueOf()
    ) {
      return { type: "reschedule", runAfter: delivery.nextRetryAt };
    }
    if (delivery.status === "delivering") {
      await this.deliveryStore.resetForRecovery(
        payload.projectId,
        payload.deliveryId,
      );
      delivery =
        (await this.deliveryStore.get(payload.projectId, payload.deliveryId)) ??
        delivery;
    }
    const eventWork = await this.workStore.getEvent(
      payload.projectId,
      delivery.eventId,
    );
    const event =
      eventWork === undefined ? undefined : await this.#resolveEvent(eventWork);
    const endpoint = await this.endpointStore.getForDelivery(
      payload.projectId,
      delivery.endpointId,
    );
    if (eventWork === undefined || event === undefined || !endpoint?.active) {
      await this.deliveryStore.markRecoveryFailed(
        payload.projectId,
        payload.deliveryId,
        this.#now().toISOString(),
      );
      this.#logger.warn("webhook.delivery_unrecoverable", {
        deliveryId: payload.deliveryId,
      });
      await this.#releaseEventIfTerminal(payload.projectId, delivery.eventId);
      return { type: "complete" };
    }
    delivery = { ...withoutNextRetry(delivery), status: "delivering" };
    await this.deliveryStore.update(payload.projectId, delivery);

    const attemptNumber = delivery.attempts.length + 1;
    const attemptedAt = this.#now();
    const timestamp = String(Math.floor(attemptedAt.valueOf() / 1_000));
    const rawBody = JSON.stringify(event);
    const signature = createWebhookSignature({
      payload: rawBody,
      secret: endpoint.secret,
      timestamp,
    });
    let statusCode: number | undefined;
    let attemptError: unknown;
    const attemptSpan = this.#telemetry.startSpan(
      "eyeball.webhook.delivery_attempt",
      {
        "eyeball.webhook.endpoint.id": delivery.endpointId,
        "eyeball.webhook.delivery.id": delivery.deliveryId,
        "eyeball.webhook.attempt": attemptNumber,
        "eyeball.webhook.event_type": delivery.eventType,
      },
    );
    try {
      statusCode = await this.#request({
        url: endpoint.url,
        eventId: delivery.eventId,
        rawBody,
        timestamp,
        signature,
        signal: context.signal,
      });
    } catch (error) {
      attemptError = error;
    }
    if (statusCode !== undefined) {
      attemptSpan.span?.setAttribute("http.response.status_code", statusCode);
    }
    const telemetryStatus =
      statusCode !== undefined && statusCode >= 200 && statusCode < 300
        ? "succeeded"
        : statusCode !== undefined
          ? "http_error"
          : attemptError instanceof WebhookAttemptTimeoutError
            ? "timeout"
            : "transport_error";
    attemptSpan.span?.setAttribute("eyeball.webhook.status", telemetryStatus);
    if (telemetryStatus === "succeeded") markSpanOk(attemptSpan.span);
    else markSpanError(attemptSpan.span, attemptError);
    attemptSpan.span?.end();
    this.#telemetry.recordWebhookDeliveryAttempt(telemetryStatus);
    this.#logger.info("webhook.delivery_attempt", {
      endpointId: delivery.endpointId,
      attempt: attemptNumber,
      status: telemetryStatus,
      ...(statusCode === undefined ? {} : { statusCode }),
    });

    const completedAt = this.#now();
    const attempt: WebhookDeliveryAttempt = {
      attempt: attemptNumber,
      attemptedAt: attemptedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(statusCode !== undefined
        ? {}
        : {
            error:
              attemptError instanceof WebhookAttemptTimeoutError
                ? attemptError.message
                : "Webhook request failed before receiving an HTTP response.",
          }),
    };
    const attempts = [...delivery.attempts, attempt];
    try {
      if (statusCode !== undefined && statusCode >= 200 && statusCode < 300) {
        await this.deliveryStore.update(payload.projectId, {
          ...withoutNextRetry(delivery),
          status: "succeeded",
          attempts,
          completedAt: completedAt.toISOString(),
        });
        await this.#releaseEventIfTerminal(payload.projectId, delivery.eventId);
        return { type: "complete" };
      }
      const nextDelay = this.retryDelaysMs[attemptNumber];
      if (nextDelay === undefined) {
        await this.deliveryStore.update(payload.projectId, {
          ...withoutNextRetry(delivery),
          status: "failed",
          attempts,
          completedAt: completedAt.toISOString(),
        });
        await this.#releaseEventIfTerminal(payload.projectId, delivery.eventId);
        this.#logger.warn("webhook.delivery_exhausted", {
          deliveryId: delivery.deliveryId,
          endpointId: delivery.endpointId,
          attempts: attempts.length,
        });
        return { type: "complete" };
      }
      const runAfter = new Date(
        completedAt.valueOf() + nextDelay,
      ).toISOString();
      await this.deliveryStore.update(payload.projectId, {
        ...withoutNextRetry(delivery),
        status: "pending",
        attempts,
        nextRetryAt: runAfter,
      });
      this.#scheduleRetryWake(nextDelay);
      return { type: "reschedule", runAfter };
    } catch {
      return {
        type: "reschedule",
        runAfter: new Date(this.#now().valueOf() + 1_000).toISOString(),
      };
    }
  }

  async #admit(
    event: WebhookEvent,
    endpointIds: readonly string[] | null,
    sourceKind: WebhookEventSourceKind,
    sourceId: string,
  ): Promise<void> {
    const retainedVolatileEvent =
      sourceKind === "execution" && this.#executionStore !== undefined
        ? false
        : this.#rememberEvent(event);
    const selectionRunAfter = this.#now().toISOString();
    const admission = this.workStore
      .ensureEvent({
        projectId: event.projectId,
        eventId: event.id,
        eventType: event.type,
        sourceKind,
        sourceId,
        endpointIds: endpointIds === null ? null : [...new Set(endpointIds)],
        createdAt: event.createdAt,
        selectionRunAfter,
      })
      .catch((error: unknown) => {
        if (retainedVolatileEvent) {
          this.#volatileEvents.delete(
            this.#eventKey(event.projectId, event.id),
          );
        }
        throw error;
      })
      .then(async () => {
        const eventWork = await this.workStore.getEvent(
          event.projectId,
          event.id,
        );
        if (eventWork === undefined) {
          throw new Error("Webhook event disappeared after durable admission.");
        }
        const submission = this.queue.submit(
          {
            kind: "webhook.select.v1",
            payload: { projectId: event.projectId, eventId: event.id },
          },
          {
            groupKey: WEBHOOK_SELECTION_GROUP_KEY,
            groupOrder: eventWork.sequence,
            runAfter: selectionRunAfter,
          },
        );
        void submission.completed.catch(() => {
          this.#logger.error("webhook.selection_job_failed", {
            projectId: event.projectId,
          });
        });
        await submission.accepted;
      });
    this.#admissions.add(admission);
    void admission.then(
      () => this.#admissions.delete(admission),
      () => this.#admissions.delete(admission),
    );
    await admission;
  }

  async #selectedEndpoints(
    projectId: string,
    eventType: WebhookEventType,
    endpointIds: readonly string[] | null,
  ): Promise<readonly StoredWebhookEndpoint[]> {
    const endpoints =
      endpointIds === null
        ? await this.endpointStore.listForDelivery(projectId)
        : (
            await Promise.all(
              endpointIds.map((endpointId) =>
                this.endpointStore.getForDelivery(projectId, endpointId),
              ),
            )
          ).filter(
            (endpoint): endpoint is StoredWebhookEndpoint =>
              endpoint !== undefined,
          );
    return endpoints.filter(
      (endpoint) => endpoint.active && subscribed(endpoint.events, eventType),
    );
  }

  #rememberEvent(event: WebhookEvent): boolean {
    const key = this.#eventKey(event.projectId, event.id);
    const existing = this.#volatileEvents.get(key);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, event)) {
        throw new Error(
          "Webhook event identity was reused with different data.",
        );
      }
      return false;
    }
    this.#volatileEvents.set(key, structuredClone(event));
    return true;
  }

  async #resolveEvent(
    eventWork: WebhookEventWork,
  ): Promise<WebhookEvent | undefined> {
    if (
      eventWork.sourceKind === "execution" &&
      this.#executionStore !== undefined
    ) {
      const record = await this.#executionStore.get(
        eventWork.projectId,
        eventWork.sourceId as ExecutionRecord["executionId"],
      );
      if (record === undefined || !terminalExecution(record)) return undefined;
      const type =
        record.status === "succeeded"
          ? "execution.succeeded"
          : "execution.failed";
      if (type !== eventWork.eventType) return undefined;
      return {
        id: eventWork.eventId,
        type,
        createdAt: eventWork.createdAt,
        projectId: eventWork.projectId,
        data: structuredClone(record),
      };
    }
    const event = this.#volatileEvents.get(
      this.#eventKey(eventWork.projectId, eventWork.eventId),
    );
    if (
      event === undefined ||
      event.type !== eventWork.eventType ||
      event.createdAt !== eventWork.createdAt
    ) {
      return undefined;
    }
    return structuredClone(event);
  }

  async #releaseEventIfTerminal(
    projectId: string,
    eventId: string,
  ): Promise<void> {
    const deliveries = await this.workStore.getMaterializedDeliveries(
      projectId,
      eventId,
    );
    if (
      deliveries.every(
        ({ delivery }) =>
          delivery.status === "succeeded" || delivery.status === "failed",
      )
    ) {
      this.#volatileEvents.delete(this.#eventKey(projectId, eventId));
    }
  }

  #eventKey(projectId: string, eventId: string): string {
    return JSON.stringify([projectId, eventId]);
  }

  async #request(input: {
    readonly url: string;
    readonly eventId: string;
    readonly rawBody: string;
    readonly timestamp: string;
    readonly signature: string;
    readonly signal: AbortSignal;
  }): Promise<number> {
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new WebhookAttemptTimeoutError(this.#attemptTimeoutMs));
      }, this.#attemptTimeoutMs);
    });
    try {
      const response = await Promise.race([
        this.#fetchImpl(input.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [WEBHOOK_ID_HEADER]: input.eventId,
            [WEBHOOK_TIMESTAMP_HEADER]: input.timestamp,
            [WEBHOOK_SIGNATURE_HEADER]: input.signature,
            [WEBHOOK_TIMESTAMP_HEADER_ALIAS]: input.timestamp,
            [WEBHOOK_SIGNATURE_HEADER_ALIAS]: input.signature,
          },
          body: input.rawBody,
          signal: controller.signal,
          redirect: "manual",
        }),
        timedOut,
      ]);
      return response.status;
    } finally {
      input.signal.removeEventListener("abort", abort);
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  #scheduleRetryWake(milliseconds: number): void {
    if (this.#retryWake === undefined || this.#ownedQueue === undefined) return;
    void this.#retryWake(milliseconds).then(
      () => this.#ownedQueue?.runOnce(),
      () => undefined,
    );
  }

  #now(): Date {
    const now = this.#clock.now();
    if (Number.isNaN(now.valueOf())) {
      throw new Error("Webhook clock returned an invalid date.");
    }
    return new Date(now.valueOf());
  }
}
