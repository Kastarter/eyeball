import type { WebhookDelivery, WebhookDeliveryAttempt } from "@eyeball/core";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sameImmutableJob } from "../../jobs/store.js";
import {
  createJobEnvelope,
  type ExecutorJob,
  type JobEnvelope,
  WEBHOOK_SELECTION_GROUP_KEY,
} from "../../jobs/types.js";
import type { SequencedWebhookDelivery } from "../../webhooks/delivery-store.js";
import {
  deterministicWebhookDeliveryId,
  type EnsureWebhookEventResult,
  validateEventDeliverySummaryInput,
  type WebhookEventAdmission,
  type WebhookEventDeliverySummary,
  type WebhookEventRecoveryPage,
  type WebhookEventWork,
  type WebhookWorkStore,
} from "../../webhooks/work-store.js";
import type { EyeballPostgresDatabase } from "./database.js";
import {
  taskJobs,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEvents,
} from "./schema.js";

function iso(value: string): string {
  return new Date(value).toISOString();
}

function eventFromRow(
  row: typeof webhookEvents.$inferSelect,
): WebhookEventWork {
  return structuredClone({
    sequence: row.sequence,
    projectId: row.projectId,
    eventId: row.eventId,
    eventType: row.eventType,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    endpointIds: row.endpointIds,
    createdAt: iso(row.createdAt),
    ...(row.materializedAt === null
      ? {}
      : { materializedAt: iso(row.materializedAt) }),
  });
}

function deliveryFromRows(
  row: typeof webhookDeliveries.$inferSelect,
  attempts: readonly (typeof webhookDeliveryAttempts.$inferSelect)[],
): WebhookDelivery {
  return {
    deliveryId: row.deliveryId,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: attempts.map(
      (attempt): WebhookDeliveryAttempt => ({
        attempt: attempt.attempt,
        attemptedAt: iso(attempt.attemptedAt),
        completedAt: iso(attempt.completedAt),
        ...(attempt.statusCode === null
          ? {}
          : { statusCode: attempt.statusCode }),
        ...(attempt.error === null ? {} : { error: attempt.error }),
      }),
    ),
    createdAt: iso(row.createdAt),
    ...(row.nextRetryAt === null ? {} : { nextRetryAt: iso(row.nextRetryAt) }),
    ...(row.completedAt === null ? {} : { completedAt: iso(row.completedAt) }),
  };
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
    existing.createdAt === iso(incoming.createdAt)
  );
}

function jobFromRow(row: typeof taskJobs.$inferSelect): JobEnvelope {
  return {
    jobId: row.jobId,
    queueName: row.queueName as JobEnvelope["queueName"],
    description: { kind: row.kind, payload: row.payload } as ExecutorJob,
    ...(row.groupKey === null ? {} : { groupKey: row.groupKey }),
    ...(row.groupOrder === null ? {} : { groupOrder: row.groupOrder }),
    runAfter: iso(row.runAfter),
  };
}

export class PostgresWebhookWorkStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements WebhookWorkStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;

  constructor(database: EyeballPostgresDatabase<TQueryResult>) {
    this.#database = database;
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
    return this.#database.transaction(async (transaction) => {
      const [inserted] = await transaction
        .insert(webhookEvents)
        .values({
          projectId: input.projectId,
          eventId: input.eventId,
          eventType: input.eventType,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          endpointIds: input.endpointIds,
          createdAt: input.createdAt,
        })
        .onConflictDoNothing()
        .returning();
      const row =
        inserted ??
        (
          await transaction
            .select()
            .from(webhookEvents)
            .where(
              and(
                eq(webhookEvents.projectId, input.projectId),
                eq(webhookEvents.eventId, input.eventId),
              ),
            )
            .limit(1)
        )[0];
      if (row === undefined) throw new Error("Webhook event disappeared.");
      const event = eventFromRow(row);
      if (inserted === undefined && !sameEvent(event, input)) {
        throw new Error(
          "Webhook event identity was reused with different work.",
        );
      }

      const envelope = createJobEnvelope(
        {
          kind: "webhook.select.v1",
          payload: { projectId: event.projectId, eventId: event.eventId },
        },
        {
          runAfter: input.selectionRunAfter,
          groupKey: WEBHOOK_SELECTION_GROUP_KEY,
          groupOrder: event.sequence,
        },
      );
      const [insertedJob] = await transaction
        .insert(taskJobs)
        .values({
          jobId: envelope.jobId,
          queueName: envelope.queueName,
          kind: envelope.description.kind,
          payload: structuredClone(envelope.description.payload),
          state: "pending",
          groupKey: envelope.groupKey ?? null,
          groupOrder: envelope.groupOrder ?? null,
          runAfter: envelope.runAfter,
          attempts: 0,
          createdAt: input.selectionRunAfter,
          updatedAt: input.selectionRunAfter,
        })
        .onConflictDoNothing()
        .returning();
      if (insertedJob === undefined) {
        const [existingJob] = await transaction
          .select()
          .from(taskJobs)
          .where(eq(taskJobs.jobId, envelope.jobId))
          .limit(1);
        if (
          existingJob === undefined ||
          !sameImmutableJob(jobFromRow(existingJob), envelope)
        ) {
          throw new Error("Webhook selection job identity conflict.");
        }
      }
      return inserted === undefined ? "existing" : "inserted";
    });
  }

  async getEvent(
    projectId: string,
    eventId: string,
  ): Promise<WebhookEventWork | undefined> {
    const [row] = await this.#database
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.projectId, projectId),
          eq(webhookEvents.eventId, eventId),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : eventFromRow(row);
  }

  async materializeEvent(input: {
    readonly projectId: string;
    readonly eventId: string;
    readonly endpointIds: readonly string[];
    readonly materializedAt: string;
  }): Promise<readonly SequencedWebhookDelivery[]> {
    const materialized = await this.#database.transaction(
      async (transaction) => {
        const [event] = await transaction
          .select()
          .from(webhookEvents)
          .where(
            and(
              eq(webhookEvents.projectId, input.projectId),
              eq(webhookEvents.eventId, input.eventId),
            ),
          )
          .for("update")
          .limit(1);
        if (event === undefined) throw new Error("Unknown webhook event work.");
        if (event.materializedAt !== null) return undefined;
        const seen = new Set<string>();
        const deliveries: SequencedWebhookDelivery[] = [];
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
          const [insertedDelivery] = await transaction
            .insert(webhookDeliveries)
            .values({
              projectId: input.projectId,
              deliveryId,
              endpointId,
              eventId: input.eventId,
              eventType: event.eventType,
              status: "pending",
              createdAt: event.createdAt,
            })
            .onConflictDoNothing()
            .returning();
          const row =
            insertedDelivery ??
            (
              await transaction
                .select()
                .from(webhookDeliveries)
                .where(
                  and(
                    eq(webhookDeliveries.projectId, input.projectId),
                    eq(webhookDeliveries.deliveryId, deliveryId),
                  ),
                )
                .limit(1)
            )[0];
          if (
            row === undefined ||
            row.endpointId !== endpointId ||
            row.eventId !== input.eventId ||
            row.eventType !== event.eventType
          ) {
            throw new Error(
              "Webhook delivery identity conflict during materialization.",
            );
          }
          deliveries.push({
            projectId: input.projectId,
            sequence: row.sequence,
            delivery: deliveryFromRows(row, []),
          });
        }
        await transaction
          .update(webhookEvents)
          .set({ materializedAt: input.materializedAt })
          .where(
            and(
              eq(webhookEvents.projectId, input.projectId),
              eq(webhookEvents.eventId, input.eventId),
            ),
          );
        return deliveries;
      },
    );
    return (
      materialized ??
      this.getMaterializedDeliveries(input.projectId, input.eventId)
    );
  }

  async getMaterializedDeliveries(
    projectId: string,
    eventId: string,
  ): Promise<readonly SequencedWebhookDelivery[]> {
    const rows = await this.#database
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.projectId, projectId),
          eq(webhookDeliveries.eventId, eventId),
        ),
      )
      .orderBy(asc(webhookDeliveries.sequence));
    const ids = rows.map(({ deliveryId }) => deliveryId);
    const attempts =
      ids.length === 0
        ? []
        : await this.#database
            .select()
            .from(webhookDeliveryAttempts)
            .where(
              and(
                eq(webhookDeliveryAttempts.projectId, projectId),
                inArray(webhookDeliveryAttempts.deliveryId, ids),
              ),
            )
            .orderBy(asc(webhookDeliveryAttempts.attempt));
    return rows.map((row) => ({
      projectId,
      sequence: row.sequence,
      delivery: deliveryFromRows(
        row,
        attempts.filter((attempt) => attempt.deliveryId === row.deliveryId),
      ),
    }));
  }

  async getEventDeliverySummaries(
    projectId: string,
    eventIds: readonly string[],
  ): Promise<readonly WebhookEventDeliverySummary[]> {
    const unique = validateEventDeliverySummaryInput(projectId, eventIds);
    if (unique.length === 0) return [];
    const events = await this.#database
      .select({
        eventId: webhookEvents.eventId,
        materializedAt: webhookEvents.materializedAt,
      })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.projectId, projectId),
          inArray(webhookEvents.eventId, unique),
        ),
      );
    const deliveries = await this.#database
      .select({
        eventId: webhookDeliveries.eventId,
        endpointId: webhookDeliveries.endpointId,
        deliveryId: webhookDeliveries.deliveryId,
        status: webhookDeliveries.status,
        sequence: webhookDeliveries.sequence,
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.projectId, projectId),
          inArray(webhookDeliveries.eventId, unique),
        ),
      )
      .orderBy(asc(webhookDeliveries.sequence));
    const byEventId = new Map(events.map((event) => [event.eventId, event]));
    return unique.flatMap((eventId) => {
      const event = byEventId.get(eventId);
      return event === undefined
        ? []
        : [
            {
              eventId,
              materialized: event.materializedAt !== null,
              targets: deliveries
                .filter((delivery) => delivery.eventId === eventId)
                .map((delivery) => ({
                  endpointId: delivery.endpointId,
                  deliveryId: delivery.deliveryId,
                  status: delivery.status,
                })),
            },
          ];
    });
  }

  async listUnmaterialized(input: {
    readonly cursor?: number;
    readonly limit: number;
  }): Promise<WebhookEventRecoveryPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new RangeError("Webhook event recovery limit must be positive.");
    }
    const rows = await this.#database
      .select()
      .from(webhookEvents)
      .where(
        and(
          isNull(webhookEvents.materializedAt),
          ...(input.cursor === undefined
            ? []
            : [gt(webhookEvents.sequence, input.cursor)]),
        ),
      )
      .orderBy(asc(webhookEvents.sequence))
      .limit(input.limit);
    const events = rows.map(eventFromRow);
    const last = events.at(-1);
    return {
      events,
      ...(events.length === input.limit && last !== undefined
        ? { nextCursor: last.sequence }
        : {}),
    };
  }
}
