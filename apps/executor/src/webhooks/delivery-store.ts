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
  readonly #deliveryIdFactory: () => string;

  constructor(options: InMemoryWebhookDeliveryStoreOptions = {}) {
    this.#deliveryIdFactory = options.deliveryIdFactory ?? deliveryId;
  }

  async create(
    projectId: string,
    input: CreateWebhookDeliveryInput,
  ): Promise<WebhookDelivery> {
    validateCreateWebhookDelivery(projectId, input);
    const generatedDeliveryId = this.#deliveryIdFactory();
    if (generatedDeliveryId.trim().length === 0) {
      throw new Error("Webhook delivery ID factory returned an empty value.");
    }
    const key = storageKey(projectId, generatedDeliveryId);
    if (this.#deliveries.has(key)) {
      throw new Error(`Duplicate webhook delivery ID: ${generatedDeliveryId}`);
    }
    const delivery: WebhookDelivery = {
      deliveryId: generatedDeliveryId,
      endpointId: input.endpointId,
      eventId: input.eventId,
      eventType: input.eventType,
      status: "pending",
      attempts: [],
      createdAt: input.createdAt,
    };
    this.#deliveries.set(key, copy(delivery));
    return copy(delivery);
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
}
