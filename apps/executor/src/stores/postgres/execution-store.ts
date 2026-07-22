import { isDeepStrictEqual } from "node:util";
import type {
  CancelledExecutionRecord,
  ConnectionId,
  ExecutionId,
  ExecutionRecord,
  FailedExecutionRecord,
  SucceededExecutionRecord,
  TerminalExecutionRecord,
} from "@eyeball/core";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  assertExecutionTransition,
  cancelledExecutionRecord,
  type ExecutionAllocation,
  type ExecutionAllocationInspection,
  type ExecutionAllocationResult,
  type ExecutionCancellationResult,
  type ExecutionDetailRecord,
  type ExecutionListFilters,
  type ExecutionPage,
  type ExecutionRecoveryAllocation,
  type ExecutionRecoveryPage,
  type ExecutionStore,
  executionCursorAfter,
  executionIdFromCursor,
  InvalidExecutionCursorError,
  projectExecutionRecord,
  type RecoverableExecution,
} from "../../store.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { executionIdempotency, executions } from "./schema.js";

export interface PostgresExecutionStoreOptions {
  /** Poll interval used by waitForTerminal; defaults to 25 ms. */
  terminalPollIntervalMs?: number;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function recoverableFromRow(
  row: typeof executions.$inferSelect,
): RecoverableExecution {
  return copy({
    sequence: row.sequence,
    projectId: row.projectId,
    record: projectExecutionRecord(row.record, row.replayObservedAt),
    request: row.request,
    ...(row.resumeContext === null ? {} : { resumeContext: row.resumeContext }),
    ...(row.dispatchStartedAt === null
      ? {}
      : { dispatchStartedAt: new Date(row.dispatchStartedAt).toISOString() }),
    ...(row.webhookEventId === null
      ? {}
      : { webhookEventId: row.webhookEventId }),
    ...(row.webhookPublishedAt === null
      ? {}
      : { webhookPublishedAt: new Date(row.webhookPublishedAt).toISOString() }),
    ...(row.usageFinalizedAt === null
      ? {}
      : { usageFinalizedAt: new Date(row.usageFinalizedAt).toISOString() }),
  });
}

function executionWhere(projectId: string, executionId: ExecutionId) {
  return and(
    eq(executions.projectId, projectId),
    eq(executions.executionId, executionId),
  );
}

function scopeWhere(allocation: ExecutionAllocation) {
  const reservation = allocation.idempotency;
  if (reservation === undefined) {
    throw new Error("Idempotency scope is absent.");
  }
  return and(
    eq(executionIdempotency.projectId, allocation.projectId),
    eq(executionIdempotency.key, reservation.scope.key),
    eq(executionIdempotency.tool, reservation.scope.tool),
    eq(executionIdempotency.userId, reservation.scope.userId),
    eq(executionIdempotency.connectionId, reservation.scope.connectionId),
    eq(executionIdempotency.catalogMajor, reservation.scope.catalogMajor),
  );
}

function listPredicates(
  projectId: string,
  filters: ExecutionListFilters,
): SQL[] {
  return [
    eq(executions.projectId, projectId),
    ...(filters.status === undefined
      ? []
      : [eq(executions.status, filters.status)]),
    ...(filters.tool === undefined ? [] : [eq(executions.tool, filters.tool)]),
    ...(filters.userId === undefined
      ? []
      : [eq(executions.userId, filters.userId)]),
  ];
}

function validPollInterval(value: number | undefined): number {
  const interval = value ?? 25;
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new RangeError(
      "Execution terminal poll interval must be a positive safe integer.",
    );
  }
  return interval;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PostgresExecutionStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements ExecutionStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;
  readonly #terminalPollIntervalMs: number;

  constructor(
    database: EyeballPostgresDatabase<TQueryResult>,
    options: PostgresExecutionStoreOptions = {},
  ) {
    this.#database = database;
    this.#terminalPollIntervalMs = validPollInterval(
      options.terminalPollIntervalMs,
    );
  }

  async inspectAllocation(
    allocation: ExecutionAllocation,
  ): Promise<ExecutionAllocationInspection> {
    const reservation = allocation.idempotency;
    if (reservation === undefined) return { kind: "available" };
    const [existing] = await this.#database
      .select({
        executionId: executionIdempotency.executionId,
        requestHash: executionIdempotency.requestHash,
      })
      .from(executionIdempotency)
      .where(
        and(
          scopeWhere(allocation),
          gt(executionIdempotency.expiresAt, allocation.record.createdAt),
        ),
      )
      .limit(1);
    if (existing === undefined) return { kind: "available" };
    if (existing.requestHash !== reservation.requestHash) {
      return { kind: "conflict" };
    }
    const [stored] = await this.#database
      .select({
        record: executions.record,
        replayObservedAt: executions.replayObservedAt,
      })
      .from(executions)
      .where(
        executionWhere(
          allocation.projectId,
          existing.executionId as ExecutionId,
        ),
      )
      .limit(1);
    if (stored === undefined) {
      throw new Error(
        "Execution idempotency record references an unknown execution.",
      );
    }
    return {
      kind: "replay",
      record: copy(
        projectExecutionRecord(stored.record, stored.replayObservedAt),
      ),
    };
  }

  async allocate(
    allocation: ExecutionAllocation,
  ): Promise<ExecutionAllocationResult> {
    if (allocation.record.replayed !== undefined) {
      throw new Error(
        "Execution replay provenance must be persisted through markReplayed().",
      );
    }
    return this.#database.transaction(async (transaction) => {
      const reservation = allocation.idempotency;
      if (reservation !== undefined) {
        const scope = scopeWhere(allocation);
        await transaction
          .delete(executionIdempotency)
          .where(
            and(
              scope,
              lte(executionIdempotency.expiresAt, allocation.record.createdAt),
            ),
          );

        const [existingReservation] = await transaction
          .select({
            executionId: executionIdempotency.executionId,
            requestHash: executionIdempotency.requestHash,
          })
          .from(executionIdempotency)
          .where(scope)
          .limit(1);
        if (existingReservation !== undefined) {
          if (existingReservation.requestHash !== reservation.requestHash) {
            return { kind: "conflict" };
          }
          const [existingExecution] = await transaction
            .select({
              record: executions.record,
              replayObservedAt: executions.replayObservedAt,
            })
            .from(executions)
            .where(
              executionWhere(
                allocation.projectId,
                existingReservation.executionId as ExecutionId,
              ),
            )
            .limit(1);
          if (existingExecution === undefined) {
            throw new Error(
              "Execution idempotency record references an unknown execution.",
            );
          }
          return {
            kind: "replay",
            record: copy(
              projectExecutionRecord(
                existingExecution.record,
                existingExecution.replayObservedAt,
              ),
            ),
          };
        }
      }

      const insertedExecution = await transaction
        .insert(executions)
        .values({
          projectId: allocation.projectId,
          executionId: allocation.record.executionId,
          status: allocation.record.status,
          tool: allocation.record.tool,
          userId: allocation.record.userId,
          createdAt: allocation.record.createdAt,
          record: copy(allocation.record),
          request: copy(allocation.request),
          ...(reservation === undefined
            ? {}
            : { idempotencyKey: reservation.scope.key }),
          ...(allocation.recovery === undefined
            ? {}
            : {
                resumeContext: copy(allocation.recovery.resumeContext),
                webhookEventId: allocation.recovery.webhookEventId,
              }),
        })
        .onConflictDoNothing()
        .returning({ executionId: executions.executionId });
      if (insertedExecution.length === 0) {
        throw new Error(
          `Duplicate execution ID: ${allocation.record.executionId}`,
        );
      }

      if (reservation === undefined) {
        return { kind: "allocated", record: copy(allocation.record) };
      }

      const insertedReservation = await transaction
        .insert(executionIdempotency)
        .values({
          projectId: allocation.projectId,
          key: reservation.scope.key,
          tool: reservation.scope.tool,
          userId: reservation.scope.userId,
          connectionId: reservation.scope.connectionId,
          catalogMajor: reservation.scope.catalogMajor,
          requestHash: reservation.requestHash,
          executionId: allocation.record.executionId,
          expiresAt: reservation.expiresAt,
        })
        .onConflictDoNothing()
        .returning({ executionId: executionIdempotency.executionId });
      if (insertedReservation.length > 0) {
        return { kind: "allocated", record: copy(allocation.record) };
      }

      // A concurrent transaction won the unique idempotency claim. Remove this
      // transaction's speculative execution and resolve against the winner.
      await transaction
        .delete(executions)
        .where(
          executionWhere(allocation.projectId, allocation.record.executionId),
        );
      const [winner] = await transaction
        .select({
          executionId: executionIdempotency.executionId,
          requestHash: executionIdempotency.requestHash,
        })
        .from(executionIdempotency)
        .where(scopeWhere(allocation))
        .limit(1);
      if (winner === undefined) {
        throw new Error(
          "Execution idempotency claim disappeared during allocation.",
        );
      }
      if (winner.requestHash !== reservation.requestHash) {
        return { kind: "conflict" };
      }
      const [winnerExecution] = await transaction
        .select({
          record: executions.record,
          replayObservedAt: executions.replayObservedAt,
        })
        .from(executions)
        .where(
          executionWhere(
            allocation.projectId,
            winner.executionId as ExecutionId,
          ),
        )
        .limit(1);
      if (winnerExecution === undefined) {
        throw new Error(
          "Execution idempotency winner references an unknown execution.",
        );
      }
      return {
        kind: "replay",
        record: copy(
          projectExecutionRecord(
            winnerExecution.record,
            winnerExecution.replayObservedAt,
          ),
        ),
      };
    });
  }

  async get(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<ExecutionRecord | undefined> {
    const [stored] = await this.#database
      .select({
        record: executions.record,
        replayObservedAt: executions.replayObservedAt,
      })
      .from(executions)
      .where(executionWhere(projectId, executionId))
      .limit(1);
    return stored === undefined
      ? undefined
      : copy(projectExecutionRecord(stored.record, stored.replayObservedAt));
  }

  async getDetail(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<ExecutionDetailRecord | undefined> {
    const [stored] = await this.#database
      .select({
        record: executions.record,
        request: executions.request,
        idempotencyKey: executions.idempotencyKey,
        resolvedConnectionId: executions.resolvedConnectionId,
        replayObservedAt: executions.replayObservedAt,
      })
      .from(executions)
      .where(executionWhere(projectId, executionId))
      .limit(1);
    if (stored === undefined) return undefined;
    const connectionId =
      stored.resolvedConnectionId ?? stored.request.connectionId;
    return copy({
      ...projectExecutionRecord(stored.record, stored.replayObservedAt),
      projectId,
      input: stored.request.input,
      mode: stored.request.mode,
      ...(connectionId === undefined
        ? {}
        : { connectionId: connectionId as ConnectionId }),
      ...(stored.idempotencyKey === null
        ? {}
        : { idempotencyKey: stored.idempotencyKey }),
    });
  }

  async markReplayed(
    projectId: string,
    executionId: ExecutionId,
    observedAt: string,
  ): Promise<boolean> {
    const changed = await this.#database
      .update(executions)
      .set({ replayObservedAt: new Date(observedAt).toISOString() })
      .where(
        and(
          executionWhere(projectId, executionId),
          isNull(executions.replayObservedAt),
        ),
      )
      .returning({ executionId: executions.executionId });
    if (changed.length === 1) return true;
    const [existing] = await this.#database
      .select({ executionId: executions.executionId })
      .from(executions)
      .where(executionWhere(projectId, executionId))
      .limit(1);
    return existing !== undefined;
  }

  async update(projectId: string, record: ExecutionRecord): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const [stored] = await transaction
        .select({ record: executions.record })
        .from(executions)
        .where(executionWhere(projectId, record.executionId))
        .for("update")
        .limit(1);
      if (stored === undefined) {
        throw new Error(`Unknown execution ID: ${record.executionId}`);
      }
      assertExecutionTransition(stored.record, record);
      await transaction
        .update(executions)
        .set({ status: record.status, record: copy(record) })
        .where(executionWhere(projectId, record.executionId));
    });
  }

  async cancelExecution(
    projectId: string,
    executionId: ExecutionId,
    cancelledAt: string,
  ): Promise<ExecutionCancellationResult> {
    return this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({
          record: executions.record,
          dispatchStartedAt: executions.dispatchStartedAt,
          replayObservedAt: executions.replayObservedAt,
        })
        .from(executions)
        .where(executionWhere(projectId, executionId))
        .for("update")
        .limit(1);
      if (row === undefined) return { kind: "not_found" };
      if (row.record.status === "cancelled") {
        return {
          kind: "already_cancelled",
          record: copy(
            projectExecutionRecord(row.record, row.replayObservedAt),
          ) as CancelledExecutionRecord,
        };
      }
      if (row.record.status === "succeeded" || row.record.status === "failed") {
        return {
          kind: "already_terminal",
          record: copy(
            projectExecutionRecord(row.record, row.replayObservedAt),
          ) as SucceededExecutionRecord | FailedExecutionRecord,
        };
      }
      const cancelled = cancelledExecutionRecord(
        row.record,
        cancelledAt,
        row.dispatchStartedAt ?? undefined,
      );
      assertExecutionTransition(row.record, cancelled);
      await transaction
        .update(executions)
        .set({ status: "cancelled", record: copy(cancelled) })
        .where(executionWhere(projectId, executionId));
      return {
        kind: "cancelled",
        record: copy(
          projectExecutionRecord(cancelled, row.replayObservedAt),
        ) as CancelledExecutionRecord,
      };
    });
  }

  async waitForTerminal(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<TerminalExecutionRecord> {
    for (;;) {
      const record = await this.get(projectId, executionId);
      if (record === undefined) {
        throw new Error(`Unknown execution ID: ${executionId}`);
      }
      if (
        record.status === "succeeded" ||
        record.status === "failed" ||
        record.status === "cancelled"
      ) {
        return record;
      }
      await wait(this.#terminalPollIntervalMs);
    }
  }

  async setResolvedConnection(
    projectId: string,
    executionId: ExecutionId,
    connectionId: ConnectionId | undefined,
  ): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const updated = await transaction
        .update(executions)
        .set({ resolvedConnectionId: connectionId ?? null })
        .where(executionWhere(projectId, executionId))
        .returning({ executionId: executions.executionId });
      if (updated.length === 0) {
        throw new Error(`Unknown execution ID: ${executionId}`);
      }
      await transaction
        .update(executionIdempotency)
        .set({ resolvedConnectionId: connectionId ?? null })
        .where(
          and(
            eq(executionIdempotency.projectId, projectId),
            eq(executionIdempotency.executionId, executionId),
          ),
        );
    });
  }

  async list(
    projectId: string,
    filters: ExecutionListFilters,
  ): Promise<ExecutionPage> {
    const predicates = listPredicates(projectId, filters);
    if (filters.cursor !== undefined) {
      const after = executionIdFromCursor(filters.cursor);
      const [anchor] = await this.#database
        .select({
          createdAt: executions.createdAt,
          sequence: executions.sequence,
        })
        .from(executions)
        .where(and(...predicates, eq(executions.executionId, after)))
        .limit(1);
      if (anchor === undefined) throw new InvalidExecutionCursorError();
      predicates.push(
        or(
          lt(executions.createdAt, anchor.createdAt),
          and(
            eq(executions.createdAt, anchor.createdAt),
            lt(executions.sequence, anchor.sequence),
          ),
        ) as SQL,
      );
    }
    const rows = await this.#database
      .select({
        record: executions.record,
        replayObservedAt: executions.replayObservedAt,
      })
      .from(executions)
      .where(and(...predicates))
      .orderBy(desc(executions.createdAt), desc(executions.sequence))
      .limit(filters.limit + 1);
    const hasMore = rows.length > filters.limit;
    const pageRows = rows.slice(0, filters.limit);
    const records = pageRows.map(({ record, replayObservedAt }) =>
      copy(projectExecutionRecord(record, replayObservedAt)),
    );
    const last = records.at(-1);
    return {
      executions: records,
      ...(hasMore && last !== undefined
        ? { nextCursor: executionCursorAfter(last.executionId) }
        : {}),
    };
  }

  async getRecoverable(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<RecoverableExecution | undefined> {
    const [row] = await this.#database
      .select()
      .from(executions)
      .where(executionWhere(projectId, executionId))
      .limit(1);
    return row === undefined ? undefined : recoverableFromRow(row);
  }

  async listRecoveryCandidates(input: {
    readonly cursor?: number;
    readonly limit: number;
  }): Promise<ExecutionRecoveryPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new RangeError("Execution recovery limit must be positive.");
    }
    const rows = await this.#database
      .select()
      .from(executions)
      .where(
        and(
          ...(input.cursor === undefined
            ? []
            : [gt(executions.sequence, input.cursor)]),
          or(
            inArray(executions.status, ["pending", "running"]),
            and(
              inArray(executions.status, ["succeeded", "failed", "cancelled"]),
              isNotNull(executions.webhookEventId),
              isNull(executions.webhookPublishedAt),
            ),
            and(
              inArray(executions.status, ["succeeded", "failed", "cancelled"]),
              isNotNull(executions.resumeContext),
              isNull(executions.usageFinalizedAt),
            ),
          ),
        ),
      )
      .orderBy(asc(executions.sequence))
      .limit(input.limit);
    const candidates = rows.map(recoverableFromRow);
    const last = candidates.at(-1);
    return {
      candidates,
      ...(candidates.length === input.limit && last !== undefined
        ? { nextCursor: last.sequence }
        : {}),
    };
  }

  async setResumeContext(
    projectId: string,
    executionId: ExecutionId,
    recovery: ExecutionRecoveryAllocation,
  ): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({
          resumeContext: executions.resumeContext,
          webhookEventId: executions.webhookEventId,
        })
        .from(executions)
        .where(executionWhere(projectId, executionId))
        .for("update")
        .limit(1);
      if (row === undefined) return false;
      if (
        row.resumeContext !== null &&
        !isDeepStrictEqual(row.resumeContext, recovery.resumeContext)
      ) {
        throw new Error("Execution resume context is immutable.");
      }
      if (
        row.webhookEventId !== null &&
        row.webhookEventId !== recovery.webhookEventId
      ) {
        throw new Error("Execution webhook event identity is immutable.");
      }
      await transaction
        .update(executions)
        .set({
          resumeContext: copy(recovery.resumeContext),
          webhookEventId: recovery.webhookEventId,
        })
        .where(executionWhere(projectId, executionId));
      return true;
    });
  }

  async setWebhookEventId(
    projectId: string,
    executionId: ExecutionId,
    webhookEventId: string,
  ): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({ webhookEventId: executions.webhookEventId })
        .from(executions)
        .where(executionWhere(projectId, executionId))
        .for("update")
        .limit(1);
      if (row === undefined) return false;
      if (
        row.webhookEventId !== null &&
        row.webhookEventId !== webhookEventId
      ) {
        throw new Error("Execution webhook event identity is immutable.");
      }
      if (row.webhookEventId === null) {
        await transaction
          .update(executions)
          .set({ webhookEventId })
          .where(executionWhere(projectId, executionId));
      }
      return true;
    });
  }

  async markDispatchStarted(
    projectId: string,
    executionId: ExecutionId,
    dispatchedAt: string,
  ): Promise<boolean> {
    const changed = await this.#database
      .update(executions)
      .set({ dispatchStartedAt: dispatchedAt })
      .where(
        and(
          executionWhere(projectId, executionId),
          eq(executions.status, "running"),
          isNull(executions.dispatchStartedAt),
        ),
      )
      .returning({ executionId: executions.executionId });
    return changed.length === 1;
  }

  async markUsageFinalized(
    projectId: string,
    executionId: ExecutionId,
    finalizedAt: string,
  ): Promise<boolean> {
    return this.#markOnce(projectId, executionId, "usage", finalizedAt);
  }

  async markWebhookPublished(
    projectId: string,
    executionId: ExecutionId,
    publishedAt: string,
  ): Promise<boolean> {
    return this.#markOnce(projectId, executionId, "webhook", publishedAt);
  }

  async #markOnce(
    projectId: string,
    executionId: ExecutionId,
    kind: "usage" | "webhook",
    value: string,
  ): Promise<boolean> {
    const column =
      kind === "usage"
        ? executions.usageFinalizedAt
        : executions.webhookPublishedAt;
    const changed = await this.#database
      .update(executions)
      .set(
        kind === "usage"
          ? { usageFinalizedAt: value }
          : { webhookPublishedAt: value },
      )
      .where(
        and(
          executionWhere(projectId, executionId),
          isNull(column),
          ...(kind === "webhook" ? [isNotNull(executions.webhookEventId)] : []),
        ),
      )
      .returning({ executionId: executions.executionId });
    if (changed.length === 1) return true;
    const existing = await this.getRecoverable(projectId, executionId);
    return kind === "usage"
      ? existing?.usageFinalizedAt !== undefined
      : existing?.webhookPublishedAt !== undefined;
  }
}
