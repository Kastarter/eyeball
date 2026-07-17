import { randomUUID } from "node:crypto";
import type {
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookDeliveryPage,
} from "@eyeball/core";
import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  type CreateWebhookDeliveryInput,
  deliveryCursorAfter,
  deliveryIdFromCursor,
  type InMemoryWebhookDeliveryStoreOptions,
  InvalidWebhookDeliveryCursorError,
  type ListWebhookDeliveriesInput,
  sameDeliveryAttempt,
  validateCreateWebhookDelivery,
  validateListWebhookDeliveries,
  validDeliveryTransition,
  type WebhookDeliveryStore,
} from "../../webhooks/delivery-store.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { webhookDeliveries, webhookDeliveryAttempts } from "./schema.js";

export type PostgresWebhookDeliveryStoreOptions =
  InMemoryWebhookDeliveryStoreOptions;

function copy<T>(value: T): T {
  return structuredClone(value);
}

function generatedDeliveryId(): string {
  return `whd_${randomUUID().replaceAll("-", "")}`;
}

function deliveryWhere(projectId: string, deliveryId: string) {
  return and(
    eq(webhookDeliveries.projectId, projectId),
    eq(webhookDeliveries.deliveryId, deliveryId),
  );
}

function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function attemptFromRow(
  row: typeof webhookDeliveryAttempts.$inferSelect,
): WebhookDeliveryAttempt {
  return {
    attempt: row.attempt,
    attemptedAt: isoTimestamp(row.attemptedAt),
    completedAt: isoTimestamp(row.completedAt),
    ...(row.statusCode === null ? {} : { statusCode: row.statusCode }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function deliveryFromRow(
  row: typeof webhookDeliveries.$inferSelect,
  attempts: readonly WebhookDeliveryAttempt[],
): WebhookDelivery {
  return {
    deliveryId: row.deliveryId,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: attempts.map(copy),
    createdAt: isoTimestamp(row.createdAt),
    ...(row.nextRetryAt === null
      ? {}
      : { nextRetryAt: isoTimestamp(row.nextRetryAt) }),
    ...(row.completedAt === null
      ? {}
      : { completedAt: isoTimestamp(row.completedAt) }),
  };
}

function assertDeliveryUpdate(
  previous: WebhookDelivery,
  delivery: WebhookDelivery,
): WebhookDeliveryAttempt | undefined {
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
  return delivery.attempts.length > previous.attempts.length
    ? appended
    : undefined;
}

export class PostgresWebhookDeliveryStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements WebhookDeliveryStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;
  readonly #deliveryIdFactory: () => string;

  constructor(
    database: EyeballPostgresDatabase<TQueryResult>,
    options: PostgresWebhookDeliveryStoreOptions = {},
  ) {
    this.#database = database;
    this.#deliveryIdFactory = options.deliveryIdFactory ?? generatedDeliveryId;
  }

  async create(
    projectId: string,
    input: CreateWebhookDeliveryInput,
  ): Promise<WebhookDelivery> {
    validateCreateWebhookDelivery(projectId, input);
    const deliveryId = this.#deliveryIdFactory();
    if (deliveryId.trim().length === 0) {
      throw new Error("Webhook delivery ID factory returned an empty value.");
    }
    const inserted = await this.#database
      .insert(webhookDeliveries)
      .values({
        projectId,
        deliveryId,
        endpointId: input.endpointId,
        eventId: input.eventId,
        eventType: input.eventType,
        status: "pending",
        createdAt: input.createdAt,
      })
      .onConflictDoNothing()
      .returning();
    const [row] = inserted;
    if (row === undefined) {
      throw new Error(`Duplicate webhook delivery ID: ${deliveryId}`);
    }
    return deliveryFromRow(row, []);
  }

  async get(
    projectId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery | undefined> {
    const [row] = await this.#database
      .select()
      .from(webhookDeliveries)
      .where(deliveryWhere(projectId, deliveryId))
      .limit(1);
    if (row === undefined) return undefined;
    const attempts = await this.#database
      .select()
      .from(webhookDeliveryAttempts)
      .where(
        and(
          eq(webhookDeliveryAttempts.projectId, projectId),
          eq(webhookDeliveryAttempts.deliveryId, deliveryId),
        ),
      )
      .orderBy(webhookDeliveryAttempts.attempt);
    return deliveryFromRow(row, attempts.map(attemptFromRow));
  }

  async update(projectId: string, delivery: WebhookDelivery): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(webhookDeliveries)
        .where(deliveryWhere(projectId, delivery.deliveryId))
        .for("update")
        .limit(1);
      if (row === undefined) {
        throw new Error(`Unknown webhook delivery ID: ${delivery.deliveryId}`);
      }
      const attemptRows = await transaction
        .select()
        .from(webhookDeliveryAttempts)
        .where(
          and(
            eq(webhookDeliveryAttempts.projectId, projectId),
            eq(webhookDeliveryAttempts.deliveryId, delivery.deliveryId),
          ),
        )
        .orderBy(webhookDeliveryAttempts.attempt);
      const previous = deliveryFromRow(row, attemptRows.map(attemptFromRow));
      const appended = assertDeliveryUpdate(previous, delivery);
      if (appended !== undefined) {
        await transaction.insert(webhookDeliveryAttempts).values({
          projectId,
          deliveryId: delivery.deliveryId,
          attempt: appended.attempt,
          attemptedAt: appended.attemptedAt,
          completedAt: appended.completedAt,
          ...(appended.statusCode === undefined
            ? {}
            : { statusCode: appended.statusCode }),
          ...(appended.error === undefined ? {} : { error: appended.error }),
        });
      }
      await transaction
        .update(webhookDeliveries)
        .set({
          status: delivery.status,
          nextRetryAt: delivery.nextRetryAt ?? null,
          completedAt: delivery.completedAt ?? null,
        })
        .where(deliveryWhere(projectId, delivery.deliveryId));
    });
  }

  async list(
    projectId: string,
    endpointId: string,
    input: ListWebhookDeliveriesInput,
  ): Promise<WebhookDeliveryPage> {
    validateListWebhookDeliveries(input);
    const predicates: SQL[] = [
      eq(webhookDeliveries.projectId, projectId),
      eq(webhookDeliveries.endpointId, endpointId),
    ];
    if (input.cursor !== undefined) {
      const after = deliveryIdFromCursor(input.cursor);
      const [anchor] = await this.#database
        .select({
          createdAt: webhookDeliveries.createdAt,
          sequence: webhookDeliveries.sequence,
        })
        .from(webhookDeliveries)
        .where(and(...predicates, eq(webhookDeliveries.deliveryId, after)))
        .limit(1);
      if (anchor === undefined) throw new InvalidWebhookDeliveryCursorError();
      predicates.push(
        or(
          lt(webhookDeliveries.createdAt, anchor.createdAt),
          and(
            eq(webhookDeliveries.createdAt, anchor.createdAt),
            lt(webhookDeliveries.sequence, anchor.sequence),
          ),
        ) as SQL,
      );
    }
    const rows = await this.#database
      .select()
      .from(webhookDeliveries)
      .where(and(...predicates))
      .orderBy(
        desc(webhookDeliveries.createdAt),
        desc(webhookDeliveries.sequence),
      )
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const deliveryIds = pageRows.map(({ deliveryId }) => deliveryId);
    const attemptRows =
      deliveryIds.length === 0
        ? []
        : await this.#database
            .select()
            .from(webhookDeliveryAttempts)
            .where(
              and(
                eq(webhookDeliveryAttempts.projectId, projectId),
                inArray(webhookDeliveryAttempts.deliveryId, deliveryIds),
              ),
            )
            .orderBy(webhookDeliveryAttempts.attempt);
    const attemptsByDelivery = new Map<string, WebhookDeliveryAttempt[]>();
    for (const attemptRow of attemptRows) {
      const attempts = attemptsByDelivery.get(attemptRow.deliveryId) ?? [];
      attempts.push(attemptFromRow(attemptRow));
      attemptsByDelivery.set(attemptRow.deliveryId, attempts);
    }
    const deliveries = pageRows.map((row) =>
      deliveryFromRow(row, attemptsByDelivery.get(row.deliveryId) ?? []),
    );
    const last = deliveries.at(-1);
    return {
      deliveries,
      ...(hasMore && last !== undefined
        ? { nextCursor: deliveryCursorAfter(last.deliveryId) }
        : {}),
    };
  }
}
