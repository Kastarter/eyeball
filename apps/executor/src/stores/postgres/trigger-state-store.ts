import type { TriggerSubscriptionId } from "@eyeball/core";
import { and, eq, lte } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  type TriggerState,
  type TriggerStateStore,
  validTriggerTimestamp,
} from "../../triggers/state-store.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { triggerDedupClaims, triggerStates } from "./schema.js";

function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

export class PostgresTriggerStateStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements TriggerStateStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;

  constructor(database: EyeballPostgresDatabase<TQueryResult>) {
    this.#database = database;
  }

  async get(
    subscriptionId: TriggerSubscriptionId,
  ): Promise<TriggerState | undefined> {
    const [row] = await this.#database
      .select()
      .from(triggerStates)
      .where(eq(triggerStates.subscriptionId, subscriptionId))
      .limit(1);
    if (row === undefined) return undefined;
    return {
      subscriptionId: row.subscriptionId as TriggerSubscriptionId,
      ...(row.cursor === null ? {} : { cursor: row.cursor }),
      ...(row.nextPollAt === null
        ? {}
        : { nextPollAt: isoTimestamp(row.nextPollAt) }),
      updatedAt: isoTimestamp(row.updatedAt),
    };
  }

  async put(state: TriggerState): Promise<void> {
    validTriggerTimestamp(state.updatedAt, "Trigger state updatedAt");
    if (state.nextPollAt !== undefined) {
      validTriggerTimestamp(state.nextPollAt, "Trigger state nextPollAt");
    }
    await this.#database
      .insert(triggerStates)
      .values({
        subscriptionId: state.subscriptionId,
        cursor: state.cursor ?? null,
        nextPollAt: state.nextPollAt ?? null,
        updatedAt: state.updatedAt,
      })
      .onConflictDoUpdate({
        target: triggerStates.subscriptionId,
        set: {
          cursor: state.cursor ?? null,
          nextPollAt: state.nextPollAt ?? null,
          updatedAt: state.updatedAt,
        },
      });
  }

  async delete(subscriptionId: TriggerSubscriptionId): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await transaction
        .delete(triggerStates)
        .where(eq(triggerStates.subscriptionId, subscriptionId));
      await transaction
        .delete(triggerDedupClaims)
        .where(eq(triggerDedupClaims.subscriptionId, subscriptionId));
    });
  }

  async claimProviderEvent(
    subscriptionId: TriggerSubscriptionId,
    providerEventId: string,
    now: string,
    expiresAt: string,
  ): Promise<boolean> {
    if (providerEventId.length === 0) {
      throw new Error("Provider event ID must not be empty.");
    }
    const nowMs = validTriggerTimestamp(now, "Dedup claim now");
    const expiresAtMs = validTriggerTimestamp(
      expiresAt,
      "Dedup claim expiresAt",
    );
    if (expiresAtMs <= nowMs) {
      throw new Error("Dedup claim expiry must be later than now.");
    }
    return this.#database.transaction(async (transaction) => {
      await transaction
        .delete(triggerDedupClaims)
        .where(
          and(
            eq(triggerDedupClaims.subscriptionId, subscriptionId),
            lte(triggerDedupClaims.expiresAt, now),
          ),
        );
      const claimed = await transaction
        .insert(triggerDedupClaims)
        .values({ subscriptionId, providerEventId, expiresAt })
        .onConflictDoUpdate({
          target: [
            triggerDedupClaims.subscriptionId,
            triggerDedupClaims.providerEventId,
          ],
          set: { expiresAt },
          setWhere: lte(triggerDedupClaims.expiresAt, now),
        })
        .returning({ providerEventId: triggerDedupClaims.providerEventId });
      return claimed.length === 1;
    });
  }
}
