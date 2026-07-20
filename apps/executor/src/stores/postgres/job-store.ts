import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import type {
  ClaimedJob,
  EnsureJobResult,
  JobStore,
  LeaseMutation,
  StoredJob,
} from "../../jobs/store.js";
import { sameImmutableJob } from "../../jobs/store.js";
import type {
  ExecutorJob,
  JobEnvelope,
  JobQueueName,
  SafeJobErrorCode,
} from "../../jobs/types.js";
import { sameExecutorJob } from "../../jobs/types.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { taskJobs } from "./schema.js";

function iso(value: string): string {
  return new Date(value).toISOString();
}

function positiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Job store limit must be a positive safe integer.");
  }
}

function toStored(row: typeof taskJobs.$inferSelect): StoredJob {
  return structuredClone({
    sequence: row.sequence,
    jobId: row.jobId,
    queueName: row.queueName as JobQueueName,
    description: { kind: row.kind, payload: row.payload } as ExecutorJob,
    ...(row.groupKey === null ? {} : { groupKey: row.groupKey }),
    ...(row.groupOrder === null ? {} : { groupOrder: row.groupOrder }),
    runAfter: iso(row.runAfter),
    state: row.state,
    attempts: row.attempts,
    ...(row.claimedBy === null ? {} : { claimedBy: row.claimedBy }),
    ...(row.leaseToken === null ? {} : { leaseToken: row.leaseToken }),
    ...(row.leaseExpiresAt === null
      ? {}
      : { leaseExpiresAt: iso(row.leaseExpiresAt) }),
    ...(row.lastErrorCode === null
      ? {}
      : { lastErrorCode: row.lastErrorCode as SafeJobErrorCode }),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    ...(row.completedAt === null ? {} : { completedAt: iso(row.completedAt) }),
  });
}

function leaseWhere(input: LeaseMutation) {
  return and(
    eq(taskJobs.jobId, input.jobId),
    eq(taskJobs.state, "running"),
    eq(taskJobs.claimedBy, input.workerId),
    eq(taskJobs.leaseToken, input.leaseToken),
    gt(taskJobs.leaseExpiresAt, input.now),
  );
}

export class PostgresJobStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements JobStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;

  constructor(database: EyeballPostgresDatabase<TQueryResult>) {
    this.#database = database;
  }

  async ensure(job: JobEnvelope): Promise<EnsureJobResult> {
    const now = new Date().toISOString();
    const [inserted] = await this.#database
      .insert(taskJobs)
      .values({
        jobId: job.jobId,
        queueName: job.queueName,
        kind: job.description.kind,
        payload: structuredClone(job.description.payload),
        state: "pending",
        groupKey: job.groupKey ?? null,
        groupOrder: job.groupOrder ?? null,
        runAfter: job.runAfter,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted !== undefined)
      return { kind: "inserted", job: toStored(inserted) };
    const existing = await this.get(job.jobId);
    if (existing === undefined) {
      throw new Error("Job row disappeared during idempotent ensure.");
    }
    return sameImmutableJob(existing, job)
      ? { kind: "existing", job: existing }
      : { kind: "conflict" };
  }

  async get(jobId: string): Promise<StoredJob | undefined> {
    const [row] = await this.#database
      .select()
      .from(taskJobs)
      .where(eq(taskJobs.jobId, jobId))
      .limit(1);
    return row === undefined ? undefined : toStored(row);
  }

  async expireLeases(input: {
    queueNames: readonly JobQueueName[];
    now: string;
    limit: number;
  }): Promise<number> {
    positiveLimit(input.limit);
    if (input.queueNames.length === 0) return 0;
    return this.#database.transaction(async (transaction) => {
      const expired = await transaction
        .select({ jobId: taskJobs.jobId })
        .from(taskJobs)
        .where(
          and(
            inArray(taskJobs.queueName, [...input.queueNames]),
            eq(taskJobs.state, "running"),
            lte(taskJobs.leaseExpiresAt, input.now),
          ),
        )
        .orderBy(asc(taskJobs.leaseExpiresAt), asc(taskJobs.sequence))
        .limit(input.limit)
        .for("update", { skipLocked: true });
      if (expired.length === 0) return 0;
      await transaction
        .update(taskJobs)
        .set({
          state: "pending",
          claimedBy: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: input.now,
        })
        .where(
          inArray(
            taskJobs.jobId,
            expired.map(({ jobId }) => jobId),
          ),
        );
      return expired.length;
    });
  }

  async claim(input: {
    queueName: JobQueueName;
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<readonly ClaimedJob[]> {
    positiveLimit(input.limit);
    if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
      throw new RangeError("Lease expiry must be later than claim time.");
    }
    return this.#database.transaction(async (transaction) => {
      const blocker = alias(taskJobs, "task_jobs_blocker");
      const selected = await transaction
        .select({ jobId: taskJobs.jobId })
        .from(taskJobs)
        .where(
          and(
            eq(taskJobs.queueName, input.queueName),
            eq(taskJobs.state, "pending"),
            lte(taskJobs.runAfter, input.now),
            or(
              isNull(taskJobs.groupKey),
              notExists(
                transaction
                  .select({ value: sql<number>`1` })
                  .from(blocker)
                  .where(
                    and(
                      eq(blocker.queueName, taskJobs.queueName),
                      eq(blocker.groupKey, taskJobs.groupKey),
                      inArray(blocker.state, ["pending", "running"]),
                      or(
                        lt(blocker.groupOrder, taskJobs.groupOrder),
                        and(
                          eq(blocker.groupOrder, taskJobs.groupOrder),
                          lt(blocker.sequence, taskJobs.sequence),
                        ),
                      ),
                    ),
                  ),
              ),
            ),
          ),
        )
        .orderBy(asc(taskJobs.runAfter), asc(taskJobs.sequence))
        .limit(input.limit)
        .for("update", { skipLocked: true });
      const claimed: ClaimedJob[] = [];
      for (const selectedJob of selected) {
        const leaseToken = randomUUID();
        const [row] = await transaction
          .update(taskJobs)
          .set({
            state: "running",
            claimedBy: input.workerId,
            leaseToken,
            leaseExpiresAt: input.leaseExpiresAt,
            attempts: sql`${taskJobs.attempts} + 1`,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(taskJobs.jobId, selectedJob.jobId),
              eq(taskJobs.state, "pending"),
            ),
          )
          .returning();
        if (row !== undefined) claimed.push(toStored(row) as ClaimedJob);
      }
      return claimed;
    });
  }

  async renew(
    input: LeaseMutation & { readonly leaseExpiresAt: string },
  ): Promise<boolean> {
    if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) return false;
    const rows = await this.#database
      .update(taskJobs)
      .set({
        leaseExpiresAt: sql`greatest(${taskJobs.leaseExpiresAt}, ${input.leaseExpiresAt})`,
        updatedAt: sql`greatest(${taskJobs.updatedAt}, ${input.now})`,
      })
      .where(leaseWhere(input))
      .returning({ jobId: taskJobs.jobId });
    return rows.length === 1;
  }

  async complete(input: LeaseMutation): Promise<boolean> {
    return this.#terminal(input, "succeeded");
  }

  async reschedule(
    input: LeaseMutation & { readonly runAfter: string },
  ): Promise<boolean> {
    const rows = await this.#database
      .update(taskJobs)
      .set({
        state: "pending",
        runAfter: input.runAfter,
        claimedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: null,
        updatedAt: input.now,
      })
      .where(leaseWhere(input))
      .returning({ jobId: taskJobs.jobId });
    return rows.length === 1;
  }

  async fail(
    input: LeaseMutation & { readonly errorCode: SafeJobErrorCode },
  ): Promise<boolean> {
    return this.#terminal(input, "failed", input.errorCode);
  }

  async release(input: LeaseMutation): Promise<boolean> {
    const rows = await this.#database
      .update(taskJobs)
      .set({
        state: "pending",
        claimedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      })
      .where(leaseWhere(input))
      .returning({ jobId: taskJobs.jobId });
    return rows.length === 1;
  }

  async listAttachedTerminal(
    jobIds: readonly string[],
  ): Promise<readonly StoredJob[]> {
    if (jobIds.length === 0) return [];
    const rows = await this.#database
      .select()
      .from(taskJobs)
      .where(
        and(
          inArray(taskJobs.jobId, [...jobIds]),
          inArray(taskJobs.state, ["succeeded", "failed"]),
        ),
      );
    return rows.map(toStored);
  }

  async reopenForRecovery(input: {
    readonly jobId: string;
    readonly expectedDescription: ExecutorJob;
    readonly runAfter: string;
  }): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(taskJobs)
        .where(eq(taskJobs.jobId, input.jobId))
        .for("update")
        .limit(1);
      if (
        row === undefined ||
        (row.state !== "succeeded" && row.state !== "failed") ||
        !sameExecutorJob(
          { kind: row.kind, payload: row.payload } as ExecutorJob,
          input.expectedDescription,
        )
      ) {
        return false;
      }
      const changed = await transaction
        .update(taskJobs)
        .set({
          state: "pending",
          runAfter: input.runAfter,
          claimedBy: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          completedAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(eq(taskJobs.jobId, input.jobId), eq(taskJobs.state, row.state)),
        )
        .returning({ jobId: taskJobs.jobId });
      return changed.length === 1;
    });
  }

  async #terminal(
    input: LeaseMutation,
    state: "succeeded" | "failed",
    errorCode?: SafeJobErrorCode,
  ): Promise<boolean> {
    const rows = await this.#database
      .update(taskJobs)
      .set({
        state,
        claimedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: errorCode ?? null,
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(leaseWhere(input))
      .returning({ jobId: taskJobs.jobId });
    return rows.length === 1;
  }
}
