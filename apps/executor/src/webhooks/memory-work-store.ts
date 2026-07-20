import type { JobStore } from "../jobs/store.js";
import {
  createJobEnvelope,
  WEBHOOK_SELECTION_GROUP_KEY,
} from "../jobs/types.js";
import type { WebhookDeliveryStore } from "./delivery-store.js";
import {
  deterministicWebhookDeliveryId,
  type EnsureWebhookEventResult,
  type WebhookEventAdmission,
  type WebhookEventRecoveryPage,
  type WebhookEventWork,
  type WebhookWorkStore,
} from "./work-store.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function key(projectId: string, id: string): string {
  return JSON.stringify([projectId, id]);
}

function sameEvent(
  existing: WebhookEventWork,
  incoming: WebhookEventAdmission,
): boolean {
  return (
    existing.projectId === incoming.projectId &&
    existing.eventId === incoming.eventId &&
    existing.eventType === incoming.eventType &&
    existing.sourceKind === incoming.sourceKind &&
    existing.sourceId === incoming.sourceId &&
    JSON.stringify(existing.endpointIds) ===
      JSON.stringify(incoming.endpointIds) &&
    existing.createdAt === incoming.createdAt
  );
}

export class InMemoryWebhookWorkStore implements WebhookWorkStore {
  readonly #deliveryStore: WebhookDeliveryStore;
  readonly #jobStore: JobStore;
  readonly #events = new Map<string, WebhookEventWork>();
  readonly #eventDeliveries = new Map<string, readonly string[]>();
  #sequence = 0;

  constructor(deliveryStore: WebhookDeliveryStore, jobStore: JobStore) {
    this.#deliveryStore = deliveryStore;
    this.#jobStore = jobStore;
  }

  async ensureEvent(
    input: WebhookEventAdmission,
  ): Promise<EnsureWebhookEventResult> {
    if (
      input.projectId.length === 0 ||
      input.eventId.length === 0 ||
      input.sourceId.length === 0 ||
      !Number.isFinite(Date.parse(input.createdAt)) ||
      !Number.isFinite(Date.parse(input.selectionRunAfter))
    ) {
      throw new TypeError(
        "Webhook event identity, source, and timestamps are required.",
      );
    }
    const storageKey = key(input.projectId, input.eventId);
    const existing = this.#events.get(storageKey);
    if (existing !== undefined) {
      if (!sameEvent(existing, input)) {
        throw new Error(
          "Webhook event identity was reused with different work.",
        );
      }
      await this.#ensureSelectionJob(existing, input.selectionRunAfter);
      return "existing";
    }
    const { selectionRunAfter, ...eventInput } = input;
    const event = copy({ ...eventInput, sequence: ++this.#sequence });
    this.#events.set(storageKey, event);
    try {
      await this.#ensureSelectionJob(event, selectionRunAfter);
    } catch (error) {
      this.#events.delete(storageKey);
      throw error;
    }
    return "inserted";
  }

  async getEvent(
    projectId: string,
    eventId: string,
  ): Promise<WebhookEventWork | undefined> {
    const event = this.#events.get(key(projectId, eventId));
    return event === undefined ? undefined : copy(event);
  }

  async materializeEvent(input: {
    readonly projectId: string;
    readonly eventId: string;
    readonly endpointIds: readonly string[];
    readonly materializedAt: string;
  }) {
    const eventKey = key(input.projectId, input.eventId);
    const event = this.#events.get(eventKey);
    if (event === undefined) throw new Error("Unknown webhook event work.");
    if (event.materializedAt !== undefined) {
      return this.getMaterializedDeliveries(input.projectId, input.eventId);
    }
    const deliveries = [];
    const deliveryIds: string[] = [];
    const seen = new Set<string>();
    for (const endpointId of input.endpointIds) {
      if (seen.has(endpointId)) {
        throw new Error(
          "Webhook event materialization duplicated an endpoint.",
        );
      }
      seen.add(endpointId);
      const deliveryId = deterministicWebhookDeliveryId(
        input.projectId,
        input.eventId,
        endpointId,
      );
      const created = await this.#deliveryStore.createDeterministic(
        input.projectId,
        deliveryId,
        {
          endpointId,
          eventId: input.eventId,
          eventType: event.eventType,
          createdAt: event.createdAt,
        },
      );
      deliveryIds.push(deliveryId);
      deliveries.push(created);
    }
    this.#eventDeliveries.set(eventKey, deliveryIds);
    this.#events.set(eventKey, {
      ...event,
      materializedAt: new Date(input.materializedAt).toISOString(),
    });
    return copy(deliveries);
  }

  async getMaterializedDeliveries(projectId: string, eventId: string) {
    const ids = this.#eventDeliveries.get(key(projectId, eventId)) ?? [];
    const deliveries = await Promise.all(
      ids.map((deliveryId) =>
        this.#deliveryStore.getSequenced(projectId, deliveryId),
      ),
    );
    const complete = deliveries.filter(
      (delivery): delivery is NonNullable<typeof delivery> =>
        delivery !== undefined,
    );
    if (complete.length !== ids.length) {
      throw new Error("Webhook event references a missing delivery.");
    }
    return complete;
  }

  async listUnmaterialized(input: {
    readonly cursor?: number;
    readonly limit: number;
  }): Promise<WebhookEventRecoveryPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new RangeError("Webhook event recovery limit must be positive.");
    }
    const events = [...this.#events.values()]
      .filter(
        (event) =>
          event.materializedAt === undefined &&
          (input.cursor === undefined || event.sequence > input.cursor),
      )
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, input.limit)
      .map(copy);
    const last = events.at(-1);
    return {
      events,
      ...(events.length === input.limit && last !== undefined
        ? { nextCursor: last.sequence }
        : {}),
    };
  }

  async #ensureSelectionJob(
    event: WebhookEventWork,
    runAfter: string,
  ): Promise<void> {
    const ensured = await this.#jobStore.ensure(
      createJobEnvelope(
        {
          kind: "webhook.select.v1",
          payload: { projectId: event.projectId, eventId: event.eventId },
        },
        {
          runAfter,
          groupKey: WEBHOOK_SELECTION_GROUP_KEY,
          groupOrder: event.sequence,
        },
      ),
    );
    if (ensured.kind === "conflict") {
      throw new Error("Webhook selection job identity conflict.");
    }
  }
}
