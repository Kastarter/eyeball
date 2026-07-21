import type { TriggerEventArrivalId } from "@eyeball/core";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  type AppendTriggerEventInput,
  type ExpiredTriggerEventSweepInput,
  InvalidTriggerEventCursorError,
  type ListTriggerEventsInput,
  type StoredTriggerEvent,
  type StoredTriggerEventPage,
  storedTriggerEvent,
  TriggerEventPersistenceError,
  type TriggerEventStore,
  TriggerEventStoreError,
  triggerEventCursorAfter,
  triggerEventCursorFromString,
  validateTriggerEventListInput,
  validateTriggerEventSweepInput,
} from "../../triggers/event-store.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { triggerEvents } from "./schema.js";

const eventSelection = {
  sequence: triggerEvents.sequence,
  projectId: triggerEvents.projectId,
  arrivalId: triggerEvents.arrivalId,
  eventId: triggerEvents.eventId,
  subscriptionId: triggerEvents.subscriptionId,
  trigger: triggerEvents.trigger,
  deliveryMode: triggerEvents.deliveryMode,
  receivedAt: triggerEvents.receivedAt,
  occurredAt: triggerEvents.occurredAt,
  dedupStatus: triggerEvents.dedupStatus,
  deliveryAdmissionStatus: triggerEvents.deliveryAdmissionStatus,
  requestedWebhookEndpointIds: triggerEvents.requestedWebhookEndpointIds,
  expiresAt: triggerEvents.expiresAt,
} as const;

function iso(value: string): string {
  return new Date(value).toISOString();
}

function eventFromRow(row: {
  sequence: number;
  projectId: string;
  arrivalId: TriggerEventArrivalId;
  eventId: string;
  subscriptionId: string;
  trigger: string;
  deliveryMode: "push" | "polling";
  receivedAt: string;
  occurredAt: string;
  dedupStatus: "accepted" | "duplicate";
  deliveryAdmissionStatus: "admitted" | "failed" | "not_enqueued";
  requestedWebhookEndpointIds: readonly string[];
  expiresAt: string;
}): StoredTriggerEvent {
  return structuredClone({
    sequence: row.sequence,
    projectId: row.projectId,
    arrivalId: row.arrivalId,
    eventId: row.eventId,
    subscriptionId: row.subscriptionId as StoredTriggerEvent["subscriptionId"],
    trigger: row.trigger as StoredTriggerEvent["trigger"],
    deliveryMode: row.deliveryMode,
    receivedAt: iso(row.receivedAt),
    occurredAt: iso(row.occurredAt),
    dedupStatus: row.dedupStatus,
    deliveryAdmissionStatus: row.deliveryAdmissionStatus,
    requestedWebhookEndpointIds: [...row.requestedWebhookEndpointIds],
    expiresAt: iso(row.expiresAt),
  });
}

function immutableEvent(event: StoredTriggerEvent): string {
  const { sequence: _sequence, ...metadata } = event;
  return JSON.stringify(metadata);
}

function arrivalWhere(projectId: string, arrivalId: string) {
  return and(
    eq(triggerEvents.projectId, projectId),
    eq(triggerEvents.arrivalId, arrivalId as TriggerEventArrivalId),
  );
}

export class PostgresTriggerEventStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements TriggerEventStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;

  constructor(database: EyeballPostgresDatabase<TQueryResult>) {
    this.#database = database;
  }

  async append(
    projectId: string,
    input: AppendTriggerEventInput,
  ): Promise<StoredTriggerEvent> {
    const validated = storedTriggerEvent(projectId, 1, input);
    try {
      const [inserted] = await this.#database
        .insert(triggerEvents)
        .values({
          arrivalId: validated.arrivalId,
          projectId: validated.projectId,
          eventId: validated.eventId,
          subscriptionId: validated.subscriptionId,
          trigger: validated.trigger,
          deliveryMode: validated.deliveryMode,
          receivedAt: validated.receivedAt,
          occurredAt: validated.occurredAt,
          dedupStatus: validated.dedupStatus,
          deliveryAdmissionStatus: validated.deliveryAdmissionStatus,
          requestedWebhookEndpointIds: [
            ...validated.requestedWebhookEndpointIds,
          ],
          expiresAt: validated.expiresAt,
        })
        .onConflictDoNothing()
        .returning(eventSelection);
      const row =
        inserted ??
        (
          await this.#database
            .select(eventSelection)
            .from(triggerEvents)
            .where(arrivalWhere(projectId, validated.arrivalId))
            .limit(1)
        )[0];
      if (row === undefined) {
        throw new TriggerEventStoreError(
          "Trigger event arrivalId is already owned by another project.",
        );
      }
      const event = eventFromRow(row);
      if (immutableEvent(event) !== immutableEvent(validated)) {
        throw new TriggerEventStoreError(
          "Trigger event arrivalId was reused with different metadata.",
        );
      }
      return event;
    } catch (error) {
      if (error instanceof TriggerEventStoreError) throw error;
      // Keep driver query/parameter details out of this privacy boundary.
      throw new TriggerEventPersistenceError();
    }
  }

  async list(
    projectId: string,
    input: ListTriggerEventsInput,
  ): Promise<StoredTriggerEventPage> {
    validateTriggerEventListInput(input);
    const predicates: SQL[] = [
      eq(triggerEvents.projectId, projectId),
      gt(triggerEvents.expiresAt, input.now),
    ];
    if (input.subscriptionId !== undefined) {
      predicates.push(eq(triggerEvents.subscriptionId, input.subscriptionId));
    }
    if (input.trigger !== undefined) {
      predicates.push(eq(triggerEvents.trigger, input.trigger));
    }
    if (input.cursor !== undefined) {
      const cursor = triggerEventCursorFromString(input.cursor);
      if (
        cursor.subscriptionId !== (input.subscriptionId ?? null) ||
        cursor.trigger !== (input.trigger ?? null)
      ) {
        throw new InvalidTriggerEventCursorError();
      }
      const anchorPredicates: SQL[] = [
        arrivalWhere(projectId, cursor.after) as SQL,
      ];
      if (input.subscriptionId !== undefined) {
        anchorPredicates.push(
          eq(triggerEvents.subscriptionId, input.subscriptionId),
        );
      }
      if (input.trigger !== undefined) {
        anchorPredicates.push(eq(triggerEvents.trigger, input.trigger));
      }
      const [anchor] = await this.#database
        .select({
          receivedAt: triggerEvents.receivedAt,
          sequence: triggerEvents.sequence,
        })
        .from(triggerEvents)
        .where(and(...anchorPredicates))
        .limit(1);
      if (anchor === undefined) throw new InvalidTriggerEventCursorError();
      predicates.push(
        or(
          lt(triggerEvents.receivedAt, anchor.receivedAt),
          and(
            eq(triggerEvents.receivedAt, anchor.receivedAt),
            lt(triggerEvents.sequence, anchor.sequence),
          ),
        ) as SQL,
      );
    }
    const rows = await this.#database
      .select(eventSelection)
      .from(triggerEvents)
      .where(and(...predicates))
      .orderBy(desc(triggerEvents.receivedAt), desc(triggerEvents.sequence))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const events = rows.slice(0, input.limit).map(eventFromRow);
    const last = events.at(-1);
    return {
      triggerEvents: events,
      ...(hasMore && last !== undefined
        ? { nextCursor: triggerEventCursorAfter(last.arrivalId, input) }
        : {}),
    };
  }

  async sweepExpired(input: ExpiredTriggerEventSweepInput): Promise<number> {
    validateTriggerEventSweepInput(input);
    return this.#database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ arrivalId: triggerEvents.arrivalId })
        .from(triggerEvents)
        .where(lte(triggerEvents.expiresAt, input.now))
        .orderBy(asc(triggerEvents.expiresAt), asc(triggerEvents.sequence))
        .limit(input.limit);
      if (rows.length === 0) return 0;
      const deleted = await transaction
        .delete(triggerEvents)
        .where(
          and(
            lte(triggerEvents.expiresAt, input.now),
            inArray(
              triggerEvents.arrivalId,
              rows.map(({ arrivalId }) => arrivalId),
            ),
          ),
        )
        .returning({ arrivalId: triggerEvents.arrivalId });
      return deleted.length;
    });
  }
}
