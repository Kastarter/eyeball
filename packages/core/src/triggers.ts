import { randomUUID } from "node:crypto";
import type { Clock, ExecutorLogger, FetchImplementation } from "./adapters.js";
import type { ResolvedCredential } from "./credentials.js";
import type { ConnectionId } from "./types/execution.js";
import type {
  JsonValue,
  QualifiedTriggerName,
  TriggerDefinition,
} from "./types/tool.js";

export type TriggerSubscriptionId = `trgsub_${string}`;
export type TriggerSubscriptionStatus = "active" | "paused";
export type TriggerWebhookEventType = `trigger.${QualifiedTriggerName}`;

const TRIGGER_SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

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

/** Canonical event data nested inside the standard signed webhook envelope. */
export interface TriggerEventData {
  subscriptionId: TriggerSubscriptionId;
  trigger: QualifiedTriggerName;
  userId: string;
  connectionId?: ConnectionId;
  providerEventId: string;
  occurredAt: string;
  payload: Readonly<Record<string, JsonValue>>;
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
