import { randomUUID } from "node:crypto";
import type { Clock, ExecutorLogger, FetchImplementation } from "./adapters.js";
import type { ResolvedCredential } from "./credentials.js";
import type { ConnectionId } from "./types/execution.js";
import type {
  JsonValue,
  QualifiedTriggerName,
  TriggerDefinition,
} from "./types/tool.js";
import type { WebhookDeliveryStatus } from "./webhooks.js";

export type TriggerSubscriptionId = `trgsub_${string}`;
export type TriggerEventArrivalId = `trgevt_${string}`;
export type TriggerSubscriptionStatus = "active" | "paused";
export type TriggerWebhookEventType = `trigger.${QualifiedTriggerName}`;

const TRIGGER_SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TRIGGER_EVENT_ARRIVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** Creates a `trgsub_*` ID; a seed makes tests deterministic. */
export function createTriggerSubscriptionId(
  seed?: string,
): TriggerSubscriptionId {
  const body = seed ?? randomUUID().replaceAll("-", "");
  if (!TRIGGER_SUBSCRIPTION_ID_PATTERN.test(body)) {
    throw new Error(
      "Trigger subscription ID seed must be 1-128 characters using letters, digits, underscores, or hyphens.",
    );
  }
  return `trgsub_${body}`;
}

export function isTriggerSubscriptionId(
  value: string,
): value is TriggerSubscriptionId {
  return (
    value.startsWith("trgsub_") &&
    TRIGGER_SUBSCRIPTION_ID_PATTERN.test(value.slice(7))
  );
}

/** Creates a metadata-history `trgevt_*` arrival ID; a seed makes tests deterministic. */
export function createTriggerEventArrivalId(
  seed?: string,
): TriggerEventArrivalId {
  const body = seed ?? randomUUID().replaceAll("-", "");
  if (!TRIGGER_EVENT_ARRIVAL_ID_PATTERN.test(body)) {
    throw new Error(
      "Trigger event arrival ID seed must be 1-128 characters using letters, digits, underscores, or hyphens.",
    );
  }
  return `trgevt_${body}`;
}

export function isTriggerEventArrivalId(
  value: string,
): value is TriggerEventArrivalId {
  return (
    value.startsWith("trgevt_") &&
    TRIGGER_EVENT_ARRIVAL_ID_PATTERN.test(value.slice(7))
  );
}

/** Public, credential-free subscription record. Provider cursors and secrets stay internal. */
export interface TriggerSubscription {
  subscriptionId: TriggerSubscriptionId;
  projectId: string;
  userId: string;
  trigger: QualifiedTriggerName;
  connectionId?: ConnectionId;
  webhookEndpointIds: readonly string[];
  filters?: Readonly<Record<string, JsonValue>>;
  /** Polling triggers only; omitted for push subscriptions. */
  pollIntervalSeconds?: number;
  status: TriggerSubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

/** Push subscriptions reveal their unguessable ingest URL only in the create response. */
export interface CreatedTriggerSubscription extends TriggerSubscription {
  ingestUrl?: string;
}

/** Push ingest URL returned only when its secret is rotated. */
export interface RotatedTriggerIngestSecret {
  subscriptionId: TriggerSubscriptionId;
  ingestUrl: string;
  rotatedAt: string;
}

export interface TriggerSubscriptionPage {
  subscriptions: readonly TriggerSubscription[];
  nextCursor?: string;
}

/**
 * Payload-bearing canonical event data nested inside the signed webhook envelope.
 * Queryable history uses `TriggerEventRecord`, which intentionally cannot expose
 * provider payload bodies, provider event IDs, credentials, or signing material.
 */
export interface TriggerEventData {
  subscriptionId: TriggerSubscriptionId;
  trigger: QualifiedTriggerName;
  userId: string;
  connectionId?: ConnectionId;
  providerEventId: string;
  occurredAt: string;
  payload: Readonly<Record<string, JsonValue>>;
}

export type TriggerEventDeliveryMode = "push" | "polling";
export type TriggerEventDedupStatus = "accepted" | "duplicate";
export type TriggerEventDeliveryStatus =
  | "not_enqueued"
  | "admission_failed"
  | "selecting"
  | "no_targets"
  | "pending"
  | "delivering"
  | "succeeded"
  | "failed"
  | "partial";

export interface TriggerEventDeliveryTarget {
  endpointId: string;
  deliveryId: string;
  status: WebhookDeliveryStatus;
}

/** Metadata-only, project-authorized history for one normalized provider arrival. */
export interface TriggerEventRecord {
  arrivalId: TriggerEventArrivalId;
  eventId: string;
  subscriptionId: TriggerSubscriptionId;
  trigger: QualifiedTriggerName;
  deliveryMode: TriggerEventDeliveryMode;
  receivedAt: string;
  occurredAt: string;
  dedupStatus: TriggerEventDedupStatus;
  deliveryStatus: TriggerEventDeliveryStatus;
  requestedWebhookEndpointIds: readonly string[];
  deliveryTargets: readonly TriggerEventDeliveryTarget[];
  expiresAt: string;
}

export interface TriggerEventPage {
  triggerEvents: readonly TriggerEventRecord[];
  nextCursor?: string;
}

export interface TriggerWebhookEvent {
  id: string;
  type: TriggerWebhookEventType;
  createdAt: string;
  projectId: string;
  data: TriggerEventData;
}

/** Stable provider identity plus a payload normalized to the canonical event schema. */
export interface ProviderTriggerEvent {
  providerEventId: string;
  occurredAt: string;
  payload: Readonly<Record<string, JsonValue>>;
}

export interface TriggerAdapterContext {
  projectId: string;
  userId: string;
  trigger: TriggerDefinition;
  subscription: TriggerSubscription;
  credential: ResolvedCredential;
  baseUrl: string;
  fetchImpl: FetchImplementation;
  clock: Clock;
  logger: ExecutorLogger;
}

export interface TriggerPollResult {
  events: readonly ProviderTriggerEvent[];
  cursor?: string;
}

export type TriggerPushResult =
  | { kind: "challenge"; challenge: string }
  | { kind: "events"; events: readonly ProviderTriggerEvent[] };

export interface TriggerAdapter {
  readonly toolkitSlug: string;
  poll?(
    context: TriggerAdapterContext,
    cursor: string | undefined,
  ): Promise<TriggerPollResult>;
  ingestPush?(
    context: TriggerAdapterContext,
    rawBody: string,
    headers: Headers,
  ): Promise<TriggerPushResult>;
}
