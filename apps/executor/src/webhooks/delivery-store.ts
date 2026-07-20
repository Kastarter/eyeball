import { randomUUID } from "node:crypto";
import type {
  WebhookDelivery,
  WebhookDeliveryPage,
  WebhookDeliveryStatus,
  WebhookEventType,
} from "@eyeball/core";

export interface CreateWebhookDeliveryInput {
  endpointId: string;
  eventId: string;
  eventType: WebhookEventType;
  createdAt: string;
}

export interface ListWebhookDeliveriesInput {
  cursor?: string;
  limit: number;
}

export interface SequencedWebhookDelivery {
  readonly projectId: string;
  readonly sequence: number;
  readonly delivery: WebhookDelivery;
}

export interface WebhookDeliveryRecoveryPage {
  readonly deliveries: readonly SequencedWebhookDelivery[];
  readonly nextCursor?: number;
}

export interface WebhookDeliveryStore {
  create(
    projectId: string,
    input: CreateWebhookDeliveryInput,
  ): Promise<WebhookDelivery>;
  get(
    projectId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery | undefined>;
  update(projectId: string, delivery: WebhookDelivery): Promise<void>;
  list(
    projectId: string,
    endpointId: string,
    input: ListWebhookDeliveriesInput,
  ): Promise<WebhookDeliveryPage>;
  /** Internal deterministic creation used by atomic webhook materialization. */
  createDeterministic(
    projectId: string,
    deliveryId: string,
    input: CreateWebhookDeliveryInput,
  ): Promise<SequencedWebhookDelivery>;
  getSequenced(
    projectId: string,
    deliveryId: string,
  ): Promise<SequencedWebhookDelivery | undefined>;
  listUnfinished(input: {
    readonly cursor?: number;
    readonly limit: number;
  }): Promise<WebhookDeliveryRecoveryPage>;
  /** Recovery-only delivering -> pending reset without a fabricated attempt. */
  resetForRecovery(projectId: string, deliveryId: string): Promise<boolean>;
  /** Recovery-only terminalization for legacy rows without immutable work. */
  markRecoveryFailed(
    projectId: string,
    deliveryId: string,
    completedAt: string,
  ): Promise<boolean>;
}

export interface InMemoryWebhookDeliveryStoreOptions {
  deliveryIdFactory?: () => string;
}

export class WebhookDeliveryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookDeliveryInputError";
  }
}

export class InvalidWebhookDeliveryCursorError extends WebhookDeliveryInputError {
  constructor() {
    super("Webhook delivery cursor is invalid.");
    this.name = "InvalidWebhookDeliveryCursorError";
  }
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function deliveryId(): string {
  return `whd_${randomUUID().replaceAll("-", "")}`;
}

function storageKey(projectId: string, deliveryId: string): string {
  return JSON.stringify([projectId, deliveryId]);
}

export function validDeliveryTransition(
  previous: WebhookDeliveryStatus,
  next: WebhookDeliveryStatus,
): boolean {
  return (
    (previous === "pending" && next === "delivering") ||
    (previous === "delivering" &&
      (next === "pending" || next === "succeeded" || next === "failed"))
  );
}

export function deliveryCursorAfter(deliveryId: string): string {
  return Buffer.from(JSON.stringify({ after: deliveryId }), "utf8").toString(
    "base64url",
  );
}

export function deliveryIdFromCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("after" in parsed) ||
      typeof parsed.after !== "string" ||
      parsed.after.length === 0
    ) {
      throw new InvalidWebhookDeliveryCursorError();
    }
    return parsed.after;
  } catch (error) {
    if (error instanceof InvalidWebhookDeliveryCursorError) throw error;
    throw new InvalidWebhookDeliveryCursorError();
  }
}

export function sameDeliveryAttempt(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateCreateWebhookDelivery(
  projectId: string,
  input: CreateWebhookDeliveryInput,
): void {
  if (
    projectId.trim().length === 0 ||
    input.endpointId.trim().length === 0 ||
    input.eventId.trim().length === 0 ||
    !Number.isFinite(Date.parse(input.createdAt))
  ) {
    throw new WebhookDeliveryInputError(
      "Webhook delivery identity and timestamp are required.",
    );
  }
}

export function validateListWebhookDeliveries(
  input: ListWebhookDeliveriesInput,
): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new WebhookDeliveryInputError(
      "Webhook delivery limit must be an integer from 1 through 100.",
    );
  }
}

/** Process-local delivery log. It deliberately stores no endpoint secret or payload. */
export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  readonly #deliveries = new Map<string, WebhookDelivery>();
  readonly #sequences = new Map<string, number>();
  readonly #deliveryIdFactory: () => string;
  #sequence = 0;

  constructor(options: InMemoryWebhookDeliveryStoreOptions = {}) {
    this.#deliveryIdFactory = options.deliveryIdFactory ?? deliveryId;
  }

  async create(
    projectId: string,
    input: CreateWebhookDeliveryInput,
  ): Promise<WebhookDelivery> {
    const generatedDeliveryId = this.#deliveryIdFactory();
    if (generatedDeliveryId.trim().length === 0) {
      throw new Error("Webhook delivery ID factory returned an empty value.");
    }
    const created = await this.#create(
      projectId,
      generatedDeliveryId,
      input,
      false,
    );
    return copy(created.delivery);
  }

  async createDeterministic(
    projectId: string,
    deliveryId: string,
    input: CreateWebhookDeliveryInput,
  ): Promise<SequencedWebhookDelivery> {
    return this.#create(projectId, deliveryId, input, true);
  }

  async getSequenced(
    projectId: string,
    deliveryId: string,
  ): Promise<SequencedWebhookDelivery | undefined> {
    const key = storageKey(projectId, deliveryId);
    const delivery = this.#deliveries.get(key);
    const sequence = this.#sequences.get(key);
    return delivery === undefined || sequence === undefined
      ? undefined
      : copy({ projectId, sequence, delivery });
  }

  async get(
    projectId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery | undefined> {
    const delivery = this.#deliveries.get(storageKey(projectId, deliveryId));
    return delivery === undefined ? undefined : copy(delivery);
  }

  async update(projectId: string, delivery: WebhookDelivery): Promise<void> {
    const key = storageKey(projectId, delivery.deliveryId);
    const previous = this.#deliveries.get(key);
    if (previous === undefined) {
      throw new Error(`Unknown webhook delivery ID: ${delivery.deliveryId}`);
    }
    if (
      previous.endpointId !== delivery.endpointId ||
      previous.eventId !== delivery.eventId ||
      previous.eventType !== delivery.eventType ||
      previous.createdAt !== delivery.createdAt
    ) {
      throw new Error("Webhook delivery identity fields are immutable.");
    }
    if (!validDeliveryTransition(previous.status, delivery.status)) {
      throw new Error(
        `Invalid webhook delivery transition: ${previous.status} -> ${delivery.status}`,
      );
    }
    if (
      delivery.attempts.length < previous.attempts.length ||
      delivery.attempts.length > previous.attempts.length + 1 ||
      previous.attempts.some(
        (attempt, index) =>
          !sameDeliveryAttempt(attempt, delivery.attempts[index]),
      )
    ) {
      throw new Error("Webhook delivery attempts are append-only.");
    }
    const appended = delivery.attempts.at(-1);
    if (
      delivery.attempts.length > previous.attempts.length &&
      (appended === undefined ||
        appended.attempt !== delivery.attempts.length ||
        !Number.isFinite(Date.parse(appended.attemptedAt)) ||
        !Number.isFinite(Date.parse(appended.completedAt)))
    ) {
      throw new Error("Webhook delivery appended an invalid attempt.");
    }
    this.#deliveries.set(key, copy(delivery));
  }

  async list(
    projectId: string,
    endpointId: string,
    input: ListWebhookDeliveriesInput,
  ): Promise<WebhookDeliveryPage> {
    validateListWebhookDeliveries(input);
    const all = [...this.#deliveries.entries()]
      .filter(
        ([key, delivery]) =>
          JSON.parse(key)[0] === projectId &&
          delivery.endpointId === endpointId,
      )
      .map(([, delivery]) => delivery)
      .reverse();
    let offset = 0;
    if (input.cursor !== undefined) {
      const after = deliveryIdFromCursor(input.cursor);
      const index = all.findIndex((delivery) => delivery.deliveryId === after);
      if (index === -1) throw new InvalidWebhookDeliveryCursorError();
      offset = index + 1;
    }
    const deliveries = all
      .slice(offset, offset + input.limit)
      .map((delivery) => copy(delivery));
    const nextOffset = offset + deliveries.length;
    const last = deliveries.at(-1);
    return {
      deliveries,
      ...(nextOffset < all.length && last !== undefined
        ? { nextCursor: deliveryCursorAfter(last.deliveryId) }
        : {}),
    };
  }

  async listUnfinished(input: {
    readonly cursor?: number;
    readonly limit: number;
  }): Promise<WebhookDeliveryRecoveryPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new RangeError("Webhook recovery limit must be positive.");
    }
    const rows = [...this.#deliveries.entries()]
      .flatMap(([key, delivery]) => {
        const sequence = this.#sequences.get(key);
        const [projectId] = JSON.parse(key) as [string, string];
        return sequence === undefined
          ? []
          : [{ projectId, sequence, delivery }];
      })
      .filter(
        ({ sequence, delivery }) =>
          (input.cursor === undefined || sequence > input.cursor) &&
          (delivery.status === "pending" || delivery.status === "delivering"),
      )
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, input.limit)
      .map(copy);
    const last = rows.at(-1);
    return {
      deliveries: rows,
      ...(rows.length === input.limit && last !== undefined
        ? { nextCursor: last.sequence }
        : {}),
    };
  }

  async resetForRecovery(
    projectId: string,
    deliveryId: string,
  ): Promise<boolean> {
    const key = storageKey(projectId, deliveryId);
    const delivery = this.#deliveries.get(key);
    if (delivery === undefined || delivery.status !== "delivering")
      return false;
    const {
      nextRetryAt: _nextRetryAt,
      completedAt: _completedAt,
      ...identity
    } = delivery;
    this.#deliveries.set(key, copy({ ...identity, status: "pending" }));
    return true;
  }

  async markRecoveryFailed(
    projectId: string,
    deliveryId: string,
    completedAt: string,
  ): Promise<boolean> {
    const key = storageKey(projectId, deliveryId);
    const delivery = this.#deliveries.get(key);
    if (
      delivery === undefined ||
      (delivery.status !== "pending" && delivery.status !== "delivering")
    ) {
      return false;
    }
    const { nextRetryAt: _nextRetryAt, ...identity } = delivery;
    this.#deliveries.set(
      key,
      copy({
        ...identity,
        status: "failed",
        completedAt: new Date(completedAt).toISOString(),
      }),
    );
    return true;
  }

  async #create(
    projectId: string,
    deliveryId: string,
    input: CreateWebhookDeliveryInput,
    idempotent: boolean,
  ): Promise<SequencedWebhookDelivery> {
    validateCreateWebhookDelivery(projectId, input);
    if (deliveryId.trim().length === 0) {
      throw new Error("Webhook delivery ID must not be empty.");
    }
    const key = storageKey(projectId, deliveryId);
    const existing = this.#deliveries.get(key);
    if (existing !== undefined) {
      if (
        idempotent &&
        existing.endpointId === input.endpointId &&
        existing.eventId === input.eventId &&
        existing.eventType === input.eventType &&
        existing.createdAt === input.createdAt
      ) {
        const sequence = this.#sequences.get(key);
        if (sequence === undefined)
          throw new Error("Delivery sequence is missing.");
        return copy({ projectId, sequence, delivery: existing });
      }
      throw new Error(`Duplicate webhook delivery ID: ${deliveryId}`);
    }
    const delivery: WebhookDelivery = {
      deliveryId,
      endpointId: input.endpointId,
      eventId: input.eventId,
      eventType: input.eventType,
      status: "pending",
      attempts: [],
      createdAt: input.createdAt,
    };
    const sequence = ++this.#sequence;
    this.#deliveries.set(key, copy(delivery));
    this.#sequences.set(key, sequence);
    return copy({ projectId, sequence, delivery });
  }
}
