import type {
  ConnectionId,
  JsonValue,
  QualifiedTriggerName,
  TriggerSubscription,
  TriggerSubscriptionId,
  TriggerSubscriptionPage,
} from "@eyeball/core";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  InvalidTriggerSubscriptionCursorError,
  type ListTriggerSubscriptionsInput,
  publicSubscription,
  type StoredTriggerSubscription,
  subscriptionIdFromCursor,
  type TriggerSubscriptionStore,
  triggerSubscriptionCursorAfter,
  validateTriggerSubscriptionListInput,
} from "../../triggers/subscription-store.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { triggerSubscriptions } from "./schema.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function storedSubscription(
  row: typeof triggerSubscriptions.$inferSelect,
): StoredTriggerSubscription {
  return {
    subscriptionId: row.subscriptionId as TriggerSubscriptionId,
    projectId: row.projectId,
    userId: row.userId,
    trigger: row.trigger as QualifiedTriggerName,
    ...(row.connectionId === null
      ? {}
      : { connectionId: row.connectionId as ConnectionId }),
    webhookEndpointIds: copy(row.webhookEndpointIds),
    ...(row.filters === null
      ? {}
      : {
          filters: copy(row.filters as Readonly<Record<string, JsonValue>>),
        }),
    ...(row.pollIntervalSeconds === null
      ? {}
      : { pollIntervalSeconds: row.pollIntervalSeconds }),
    status: row.status,
    ...(row.ingestSecretHash === null
      ? {}
      : { ingestSecretHash: row.ingestSecretHash }),
    createdAt: isoTimestamp(row.createdAt),
    updatedAt: isoTimestamp(row.updatedAt),
  };
}

export class PostgresTriggerSubscriptionStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements TriggerSubscriptionStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;

  constructor(database: EyeballPostgresDatabase<TQueryResult>) {
    this.#database = database;
  }

  async create(
    subscription: StoredTriggerSubscription,
  ): Promise<TriggerSubscription> {
    const inserted = await this.#database
      .insert(triggerSubscriptions)
      .values({
        subscriptionId: subscription.subscriptionId,
        projectId: subscription.projectId,
        userId: subscription.userId,
        trigger: subscription.trigger,
        ...(subscription.connectionId === undefined
          ? {}
          : { connectionId: subscription.connectionId }),
        webhookEndpointIds: copy(subscription.webhookEndpointIds),
        ...(subscription.filters === undefined
          ? {}
          : { filters: copy(subscription.filters) }),
        ...(subscription.pollIntervalSeconds === undefined
          ? {}
          : { pollIntervalSeconds: subscription.pollIntervalSeconds }),
        status: subscription.status,
        ...(subscription.ingestSecretHash === undefined
          ? {}
          : { ingestSecretHash: subscription.ingestSecretHash }),
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
      })
      .onConflictDoNothing()
      .returning();
    const [row] = inserted;
    if (row === undefined) {
      throw new Error(
        `Duplicate trigger subscription ID: ${subscription.subscriptionId}`,
      );
    }
    return publicSubscription(storedSubscription(row));
  }

  async get(
    projectId: string,
    subscriptionId: string,
  ): Promise<TriggerSubscription | undefined> {
    const [row] = await this.#database
      .select()
      .from(triggerSubscriptions)
      .where(
        and(
          eq(triggerSubscriptions.projectId, projectId),
          eq(triggerSubscriptions.subscriptionId, subscriptionId),
        ),
      )
      .limit(1);
    return row === undefined
      ? undefined
      : publicSubscription(storedSubscription(row));
  }

  async getInternal(
    subscriptionId: string,
  ): Promise<StoredTriggerSubscription | undefined> {
    const [row] = await this.#database
      .select()
      .from(triggerSubscriptions)
      .where(eq(triggerSubscriptions.subscriptionId, subscriptionId))
      .limit(1);
    return row === undefined ? undefined : storedSubscription(row);
  }

  async list(
    projectId: string,
    input: ListTriggerSubscriptionsInput,
  ): Promise<TriggerSubscriptionPage> {
    validateTriggerSubscriptionListInput(input);
    const predicates: SQL[] = [
      eq(triggerSubscriptions.projectId, projectId),
      ...(input.userId === undefined
        ? []
        : [eq(triggerSubscriptions.userId, input.userId)]),
    ];
    if (input.cursor !== undefined) {
      const after = subscriptionIdFromCursor(input.cursor);
      const [anchor] = await this.#database
        .select({
          createdAt: triggerSubscriptions.createdAt,
          sequence: triggerSubscriptions.sequence,
        })
        .from(triggerSubscriptions)
        .where(
          and(...predicates, eq(triggerSubscriptions.subscriptionId, after)),
        )
        .limit(1);
      if (anchor === undefined) {
        throw new InvalidTriggerSubscriptionCursorError();
      }
      predicates.push(
        or(
          lt(triggerSubscriptions.createdAt, anchor.createdAt),
          and(
            eq(triggerSubscriptions.createdAt, anchor.createdAt),
            lt(triggerSubscriptions.sequence, anchor.sequence),
          ),
        ) as SQL,
      );
    }
    const rows = await this.#database
      .select()
      .from(triggerSubscriptions)
      .where(and(...predicates))
      .orderBy(
        desc(triggerSubscriptions.createdAt),
        desc(triggerSubscriptions.sequence),
      )
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const subscriptions = rows
      .slice(0, input.limit)
      .map((row) => publicSubscription(storedSubscription(row)));
    const last = subscriptions.at(-1);
    return {
      subscriptions,
      ...(hasMore && last !== undefined
        ? {
            nextCursor: triggerSubscriptionCursorAfter(last.subscriptionId),
          }
        : {}),
    };
  }

  async listActive(): Promise<readonly StoredTriggerSubscription[]> {
    const rows = await this.#database
      .select()
      .from(triggerSubscriptions)
      .where(eq(triggerSubscriptions.status, "active"))
      .orderBy(triggerSubscriptions.sequence);
    return rows.map(storedSubscription);
  }

  async delete(projectId: string, subscriptionId: string): Promise<boolean> {
    const deleted = await this.#database
      .delete(triggerSubscriptions)
      .where(
        and(
          eq(triggerSubscriptions.projectId, projectId),
          eq(triggerSubscriptions.subscriptionId, subscriptionId),
        ),
      )
      .returning({ subscriptionId: triggerSubscriptions.subscriptionId });
    return deleted.length > 0;
  }
}
