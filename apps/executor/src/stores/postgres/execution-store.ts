import type { ConnectionId, ExecutionId, ExecutionRecord } from "@eyeball/core";
import { and, desc, eq, lt, lte, or, type SQL } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  assertExecutionTransition,
  type ExecutionAllocation,
  type ExecutionAllocationResult,
  type ExecutionDetailRecord,
  type ExecutionListFilters,
  type ExecutionPage,
  type ExecutionStore,
  executionCursorAfter,
  executionIdFromCursor,
  InvalidExecutionCursorError,
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

  async allocate(
    allocation: ExecutionAllocation,
  ): Promise<ExecutionAllocationResult> {
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
            .select({ record: executions.record })
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
          return { kind: "replay", record: copy(existingExecution.record) };
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
        .select({ record: executions.record })
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
      return { kind: "replay", record: copy(winnerExecution.record) };
    });
  }

  async get(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<ExecutionRecord | undefined> {
    const [stored] = await this.#database
      .select({ record: executions.record })
      .from(executions)
      .where(executionWhere(projectId, executionId))
      .limit(1);
    return stored === undefined ? undefined : copy(stored.record);
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
      })
      .from(executions)
      .where(executionWhere(projectId, executionId))
      .limit(1);
    if (stored === undefined) return undefined;
    const connectionId =
      stored.resolvedConnectionId ?? stored.request.connectionId;
    return copy({
      ...stored.record,
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

  async waitForTerminal(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<ExecutionRecord & { status: "succeeded" | "failed" }> {
    for (;;) {
      const record = await this.get(projectId, executionId);
      if (record === undefined) {
        throw new Error(`Unknown execution ID: ${executionId}`);
      }
      if (record.status === "succeeded" || record.status === "failed") {
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
      .select({ record: executions.record })
      .from(executions)
      .where(and(...predicates))
      .orderBy(desc(executions.createdAt), desc(executions.sequence))
      .limit(filters.limit + 1);
    const hasMore = rows.length > filters.limit;
    const pageRows = rows.slice(0, filters.limit);
    const records = pageRows.map(({ record }) => copy(record));
    const last = records.at(-1);
    return {
      executions: records,
      ...(hasMore && last !== undefined
        ? { nextCursor: executionCursorAfter(last.executionId) }
        : {}),
    };
  }
}
