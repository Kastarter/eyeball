import { createHash } from "node:crypto";
import type { WebhookEventType } from "@eyeball/core";
import type { SequencedWebhookDelivery } from "./delivery-store.js";

export interface WebhookEventWork {
  readonly sequence: number;
  readonly projectId: string;
  readonly eventId: string;
  readonly eventType: WebhookEventType;
  readonly sourceKind: WebhookEventSourceKind;
  readonly sourceId: string;
  /** null selects all eligible endpoints; [] explicitly selects none. */
  readonly endpointIds: readonly string[] | null;
  readonly createdAt: string;
  readonly materializedAt?: string;
}

export type WebhookEventSourceKind =
  | "execution"
  | "trigger"
  | "voice-session-event"
  | "voice-transcript";

export interface WebhookEventAdmission
  extends Omit<WebhookEventWork, "sequence" | "materializedAt"> {
  /** Worker-clock admission time for the atomically-created selection job. */
  readonly selectionRunAfter: string;
}

export type EnsureWebhookEventResult = "inserted" | "existing";

export interface WebhookEventRecoveryPage {
  readonly events: readonly WebhookEventWork[];
  readonly nextCursor?: number;
}

/** ID/reference-only durable work used by webhook job handlers. */
export interface WebhookWorkStore {
  /** Atomically admits the event reference and its ordered selection job. */
  ensureEvent(input: WebhookEventAdmission): Promise<EnsureWebhookEventResult>;
  getEvent(
    projectId: string,
    eventId: string,
  ): Promise<WebhookEventWork | undefined>;
  materializeEvent(input: {
    readonly projectId: string;
    readonly eventId: string;
    readonly endpointIds: readonly string[];
    readonly materializedAt: string;
  }): Promise<readonly SequencedWebhookDelivery[]>;
  getMaterializedDeliveries(
    projectId: string,
    eventId: string,
  ): Promise<readonly SequencedWebhookDelivery[]>;
  listUnmaterialized(input: {
    readonly cursor?: number;
    readonly limit: number;
  }): Promise<WebhookEventRecoveryPage>;
}

/** Stable public delivery identity for one event/endpoint materialization. */
export function deterministicWebhookDeliveryId(
  projectId: string,
  eventId: string,
  endpointId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([projectId, eventId, endpointId]))
    .digest("hex");
  return `whd_${digest}`;
}
