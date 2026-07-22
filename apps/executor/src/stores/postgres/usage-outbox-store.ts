import type { ExecutionId } from "@eyeball/core";
import { and, asc, count, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import type {
  UsageOutboxFailure,
  UsageOutboxPayload,
  UsageOutboxRecord,
  UsageOutboxStore,
} from "../../usage/outbox.js";
import { sameUsageOutboxPayload } from "../../usage/outbox.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { usageOutbox } from "./schema.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function toRecord(row: typeof usageOutbox.$inferSelect): UsageOutboxRecord {
  return copy({
    executionId: row.executionId as ExecutionId,
    payload: row.payload,
    state: row.state,
    attempts: row.attempts,
    nextRetryAt: row.nextRetryAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.sentAt === null ? {} : { sentAt: row.sentAt }),
  });
}

export class PostgresUsageOutboxStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements UsageOutboxStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;

  constructor(database: EyeballPostgresDatabase<TQueryResult>) {
    this.#database = database;
  }

  async enqueue(
    payload: UsageOutboxPayload,
    enqueuedAt: string,
  ): Promise<void> {
    const inserted = await this.#database
      .insert(usageOutbox)
      .values({
        executionId: payload.executionId,
        payload: copy(payload),
        state: "pending",
        attempts: 0,
        nextRetryAt: enqueuedAt,
        createdAt: enqueuedAt,
        updatedAt: enqueuedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0] !== undefined) return;

    const existing = await this.get(payload.executionId);
    if (existing === undefined) {
      throw new Error("Usage outbox row disappeared during enqueue.");
    }
    if (!sameUsageOutboxPayload(existing.payload, payload)) {
      throw new Error(
        `Conflicting usage outbox payload for execution ${payload.executionId}.`,
      );
    }
  }

  async get(executionId: ExecutionId): Promise<UsageOutboxRecord | undefined> {
    const [row] = await this.#database
      .select()
      .from(usageOutbox)
      .where(eq(usageOutbox.executionId, executionId))
      .limit(1);
    return row === undefined ? undefined : toRecord(row);
  }

  async listReady(
    now: string,
    limit: number,
    includeDeferred = false,
  ): Promise<readonly UsageOutboxRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError("Usage outbox batch size must be between 1 and 50.");
    }
    const unsent = or(
      eq(usageOutbox.state, "pending"),
      eq(usageOutbox.state, "failed"),
    );
    const rows = await this.#database
      .select()
      .from(usageOutbox)
      .where(
        includeDeferred
          ? unsent
          : and(unsent, lte(usageOutbox.nextRetryAt, now)),
      )
      .orderBy(asc(usageOutbox.nextRetryAt), asc(usageOutbox.createdAt))
      .limit(limit);
    return rows.map(toRecord);
  }

  async markSent(
    executionIds: readonly ExecutionId[],
    sentAt: string,
  ): Promise<void> {
    if (executionIds.length === 0) return;
    await this.#database
      .update(usageOutbox)
      .set({ state: "sent", updatedAt: sentAt, sentAt })
      .where(inArray(usageOutbox.executionId, [...executionIds]));
  }

  async markFailed(
    failures: readonly UsageOutboxFailure[],
    failedAt: string,
  ): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      for (const failure of failures) {
        await transaction
          .update(usageOutbox)
          .set({
            state: "failed",
            attempts: sql`${usageOutbox.attempts} + 1`,
            nextRetryAt: failure.nextRetryAt,
            updatedAt: failedAt,
            sentAt: null,
          })
          .where(
            and(
              eq(usageOutbox.executionId, failure.executionId),
              ne(usageOutbox.state, "sent"),
            ),
          );
      }
    });
  }

  async depth(): Promise<number> {
    const [row] = await this.#database
      .select({ value: count() })
      .from(usageOutbox)
      .where(ne(usageOutbox.state, "sent"));
    return row?.value ?? 0;
  }
}
