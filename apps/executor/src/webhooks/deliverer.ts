import { randomUUID } from "node:crypto";
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
  type WebhookSubscriptionEventType,
} from "@eyeball/core";
import type { Clock, ExecutorLogger } from "../adapters/index.js";
import { noopLogger, systemClock } from "../adapters/index.js";
import { PromiseTaskQueue, type TaskQueue } from "../queue.js";
import {
  InMemoryWebhookDeliveryStore,
  type WebhookDeliveryStore,
} from "./delivery-store.js";
import {
  InMemoryWebhookEndpointStore,
  type StoredWebhookEndpoint,
  type WebhookEndpointStore,
} from "./endpoint-store.js";

export const DEFAULT_WEBHOOK_RETRY_DELAYS_MS = [
  0,
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
] as const;
export const DEFAULT_WEBHOOK_ATTEMPT_TIMEOUT_MS = 10_000;

export type WebhookSleep = (milliseconds: number) => Promise<void>;

export interface WebhookDelivererOptions {
  endpointStore?: WebhookEndpointStore;
  deliveryStore?: WebhookDeliveryStore;
  fetchImpl?: typeof globalThis.fetch;
  clock?: Clock;
  sleep?: WebhookSleep;
  logger?: ExecutorLogger;
  retryDelaysMs?: readonly number[];
  selectionQueue?: TaskQueue;
  attemptQueue?: TaskQueue;
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
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function eventId(): string {
  return `evt_${randomUUID().replaceAll("-", "")}`;
}

function endpointQueueKey(projectId: string, endpointId: string): string {
  return JSON.stringify([projectId, endpointId]);
}

function withoutNextRetry(
  delivery: WebhookDelivery,
): Omit<WebhookDelivery, "nextRetryAt"> {
  const { nextRetryAt: _nextRetryAt, ...result } = delivery;
  return result;
}

function subscribed(
  events: readonly WebhookSubscriptionEventType[],
  event: WebhookEvent,
): boolean {
  if (
    (event.type === "execution.succeeded" ||
      event.type === "execution.failed") &&
    events.includes("execution.completed")
  ) {
    return true;
  }
  if (event.type.startsWith("trigger.") && events.includes("trigger.*")) {
    return true;
  }
  return events.includes(event.type);
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
 * Asynchronous signed webhook dispatcher. Endpoint selection is serialized,
 * attempts use a separate bounded queue, and each endpoint owns a concurrency-1
 * queue so retries cannot reorder later events for that endpoint.
 */
export class WebhookDeliverer {
  readonly endpointStore: WebhookEndpointStore;
  readonly deliveryStore: WebhookDeliveryStore;
  readonly retryDelaysMs: readonly number[];
  readonly #fetchImpl: typeof globalThis.fetch;
  readonly #clock: Clock;
  readonly #sleep: WebhookSleep;
  readonly #logger: ExecutorLogger;
  readonly #selectionQueue: TaskQueue;
  readonly #attemptQueue: TaskQueue;
  readonly #attemptTimeoutMs: number;
  readonly #eventIdFactory: () => string;
  readonly #endpointQueues = new Map<string, TaskQueue>();

  constructor(options: WebhookDelivererOptions = {}) {
    this.endpointStore =
      options.endpointStore ?? new InMemoryWebhookEndpointStore();
    this.deliveryStore =
      options.deliveryStore ?? new InMemoryWebhookDeliveryStore();
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#logger = options.logger ?? noopLogger;
    this.retryDelaysMs = validRetryDelays(
      options.retryDelaysMs ?? DEFAULT_WEBHOOK_RETRY_DELAYS_MS,
    );
    this.#selectionQueue = options.selectionQueue ?? new PromiseTaskQueue(1);
    this.#attemptQueue =
      options.attemptQueue ??
      new PromiseTaskQueue(options.attemptConcurrency ?? 4);
    this.#attemptTimeoutMs = validAttemptTimeout(
      options.attemptTimeoutMs ?? DEFAULT_WEBHOOK_ATTEMPT_TIMEOUT_MS,
    );
    this.#eventIdFactory = options.eventIdFactory ?? eventId;
  }

  enqueueExecution(projectId: string, record: ExecutionRecord): void {
    const snapshot = structuredClone(record);
    this.#enqueueSelection(async () => {
      if (!terminalExecution(snapshot)) {
        throw new Error("Only terminal executions can emit webhook events.");
      }
      const event: WebhookEvent = {
        id: this.#eventIdFactory(),
        type:
          snapshot.status === "succeeded"
            ? "execution.succeeded"
            : "execution.failed",
        createdAt: snapshot.completedAt ?? this.#now().toISOString(),
        projectId,
        data: snapshot,
      };
      await this.#selectAndEnqueue(projectId, event);
    });
  }

  enqueueVoiceSessionEvent(input: EnqueueVoiceSessionEventInput): void {
    const snapshot = structuredClone(input);
    this.#enqueueSelection(async () => {
      const event: VoiceSessionWebhookEvent = {
        id: snapshot.event.id,
        type: "voice.session.event",
        createdAt: snapshot.event.createdAt,
        projectId: snapshot.projectId,
        data: snapshot.event,
      };
      await this.#selectAndEnqueue(
        snapshot.projectId,
        event,
        snapshot.endpointIds,
      );
    });
  }

  enqueueVoiceTranscript(input: EnqueueVoiceTranscriptInput): void {
    const snapshot = structuredClone(input);
    this.#enqueueSelection(async () => {
      const event: VoiceTranscriptWebhookEvent = {
        id: snapshot.transcript.id,
        type: "voice.transcript.ready",
        createdAt: snapshot.createdAt ?? this.#now().toISOString(),
        projectId: snapshot.projectId,
        data: snapshot.transcript,
      };
      await this.#selectAndEnqueue(
        snapshot.projectId,
        event,
        snapshot.endpointIds,
      );
    });
  }

  enqueueTriggerEvent(input: EnqueueTriggerEventInput): void {
    const snapshot = structuredClone(input);
    this.#enqueueSelection(async () => {
      const event: TriggerWebhookEvent = {
        id: this.#eventIdFactory(),
        type: `trigger.${snapshot.trigger}`,
        createdAt: snapshot.createdAt ?? this.#now().toISOString(),
        projectId: snapshot.projectId,
        data: snapshot.data,
      };
      await this.#selectAndEnqueue(
        snapshot.projectId,
        event,
        snapshot.endpointIds,
      );
    });
  }

  /** Waits for scheduled deliveries; tests and graceful shutdown use this seam. */
  async onIdle(): Promise<void> {
    await this.#selectionQueue.onIdle();
    await Promise.all(
      [...this.#endpointQueues.values()].map((queue) => queue.onIdle()),
    );
    await this.#attemptQueue.onIdle();
  }

  #enqueueSelection(task: () => Promise<void>): void {
    try {
      void this.#selectionQueue.enqueue(task).catch((error: unknown) => {
        this.#logger.error("Webhook scheduling failed.", {
          errorName: error instanceof Error ? error.name : "unknown",
        });
      });
    } catch (error) {
      this.#logger.error("Webhook scheduling failed.", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  async #selectAndEnqueue(
    projectId: string,
    event: WebhookEvent,
    endpointIds?: readonly string[],
  ): Promise<void> {
    const endpoints =
      endpointIds === undefined
        ? await this.endpointStore.listForDelivery(projectId)
        : (
            await Promise.all(
              [...new Set(endpointIds)].map((endpointId) =>
                this.endpointStore.getForDelivery(projectId, endpointId),
              ),
            )
          ).filter(
            (endpoint): endpoint is StoredWebhookEndpoint =>
              endpoint !== undefined,
          );
    const rawBody = JSON.stringify(event);

    for (const endpoint of endpoints) {
      if (!endpoint.active || !subscribed(endpoint.events, event)) continue;
      const delivery = await this.deliveryStore.create(projectId, {
        endpointId: endpoint.endpointId,
        eventId: event.id,
        eventType: event.type,
        createdAt: this.#now().toISOString(),
      });
      const queue = this.#endpointQueue(projectId, endpoint.endpointId);
      void queue
        .enqueue(() =>
          this.#deliver(projectId, endpoint, event, rawBody, delivery),
        )
        .catch((error: unknown) => {
          this.#logger.error(
            "Webhook delivery failed outside the dispatcher boundary.",
            {
              deliveryId: delivery.deliveryId,
              endpointId: endpoint.endpointId,
              errorName: error instanceof Error ? error.name : "unknown",
            },
          );
        });
    }
  }

  async #deliver(
    projectId: string,
    endpoint: StoredWebhookEndpoint,
    event: WebhookEvent,
    rawBody: string,
    initialDelivery: WebhookDelivery,
  ): Promise<void> {
    let delivery = initialDelivery;
    for (let index = 0; index < this.retryDelaysMs.length; index += 1) {
      delivery = {
        ...withoutNextRetry(delivery),
        status: "delivering",
      };
      await this.deliveryStore.update(projectId, delivery);

      const attemptedAt = this.#now();
      const timestamp = String(Math.floor(attemptedAt.valueOf() / 1_000));
      const signature = createWebhookSignature({
        payload: rawBody,
        secret: endpoint.secret,
        timestamp,
      });
      let statusCode: number | undefined;
      let errorMessage: string | undefined;
      try {
        await this.#attemptQueue.enqueue(async () => {
          statusCode = await this.#request(
            endpoint,
            event,
            rawBody,
            timestamp,
            signature,
          );
        });
      } catch (error) {
        errorMessage =
          error instanceof WebhookAttemptTimeoutError
            ? error.message
            : "Webhook request failed before receiving an HTTP response.";
      }
      const completedAt = this.#now();
      const attempt: WebhookDeliveryAttempt = {
        attempt: index + 1,
        attemptedAt: attemptedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        ...(statusCode === undefined ? {} : { statusCode }),
        ...(errorMessage === undefined ? {} : { error: errorMessage }),
      };
      const attempts = [...delivery.attempts, attempt];
      if (statusCode !== undefined && statusCode >= 200 && statusCode < 300) {
        delivery = {
          ...withoutNextRetry(delivery),
          status: "succeeded",
          attempts,
          completedAt: completedAt.toISOString(),
        };
        await this.deliveryStore.update(projectId, delivery);
        return;
      }

      const nextDelay = this.retryDelaysMs[index + 1];
      if (nextDelay === undefined) {
        delivery = {
          ...withoutNextRetry(delivery),
          status: "failed",
          attempts,
          completedAt: completedAt.toISOString(),
        };
        await this.deliveryStore.update(projectId, delivery);
        this.#logger.warn("Webhook delivery exhausted its retry policy.", {
          deliveryId: delivery.deliveryId,
          endpointId: endpoint.endpointId,
          attempts: attempts.length,
        });
        return;
      }

      const nextRetryAt = new Date(completedAt.valueOf() + nextDelay);
      delivery = {
        ...withoutNextRetry(delivery),
        status: "pending",
        attempts,
        nextRetryAt: nextRetryAt.toISOString(),
      };
      await this.deliveryStore.update(projectId, delivery);
      await this.#sleep(nextDelay);
    }
  }

  async #request(
    endpoint: StoredWebhookEndpoint,
    event: WebhookEvent,
    rawBody: string,
    timestamp: string,
    signature: string,
  ): Promise<number> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new WebhookAttemptTimeoutError(this.#attemptTimeoutMs));
      }, this.#attemptTimeoutMs);
    });
    try {
      const response = await Promise.race([
        this.#fetchImpl(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [WEBHOOK_ID_HEADER]: event.id,
            [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
            [WEBHOOK_SIGNATURE_HEADER]: signature,
            [WEBHOOK_TIMESTAMP_HEADER_ALIAS]: timestamp,
            [WEBHOOK_SIGNATURE_HEADER_ALIAS]: signature,
          },
          body: rawBody,
          signal: controller.signal,
        }),
        timedOut,
      ]);
      return response.status;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  #endpointQueue(projectId: string, endpointId: string): TaskQueue {
    const key = endpointQueueKey(projectId, endpointId);
    const existing = this.#endpointQueues.get(key);
    if (existing !== undefined) return existing;
    const created = new PromiseTaskQueue(1);
    this.#endpointQueues.set(key, created);
    return created;
  }

  #now(): Date {
    const now = this.#clock.now();
    if (Number.isNaN(now.valueOf())) {
      throw new Error("Webhook clock returned an invalid date.");
    }
    return new Date(now.valueOf());
  }
}
