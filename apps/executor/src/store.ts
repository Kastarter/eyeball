import { isDeepStrictEqual } from "node:util";
import type {
  CancelledExecutionRecord,
  ConnectionId,
  ExecuteRequest,
  ExecutionId,
  ExecutionRecord,
  ExecutionStatus,
  FailedExecutionRecord,
  JsonValue,
  QualifiedToolName,
  SucceededExecutionRecord,
  TerminalExecutionRecord,
} from "@eyeball/core";
import type {
  UsageReportContext,
  UsageReservationHandle,
} from "./usage/gate.js";

export interface IdempotencyScope {
  key: string;
  tool: QualifiedToolName;
  userId: string;
  connectionId: ConnectionId | "default";
  catalogMajor: string;
}

export interface IdempotencyReservation {
  scope: IdempotencyScope;
  requestHash: string;
  expiresAt: string;
}

export interface StoredIdempotencyRecord extends IdempotencyReservation {
  projectId: string;
  executionId: ExecutionId;
  resolvedConnectionId?: ConnectionId;
}

export interface ExecutionAllocation {
  projectId: string;
  record: ExecutionRecord & { status: "pending" };
  request: ExecuteRequest;
  idempotency?: IdempotencyReservation;
  /** Executor-only restart metadata; never returned by public execution APIs. */
  recovery?: ExecutionRecoveryAllocation;
}

export interface ExecutionResumeContextV1 {
  readonly version: 1;
  readonly tool: QualifiedToolName;
  readonly toolVersion: string;
  readonly toolkitSlug: string;
  readonly requiredScopes: readonly string[];
  readonly concurrencyBucketKey: string;
  readonly concurrencyLimit?: number;
  readonly usageReport?: UsageReportContext;
  readonly usageReservation?: UsageReservationHandle;
  readonly traceParent?: string;
}

export type ExecutionResumeContext = ExecutionResumeContextV1;

export interface ExecutionRecoveryAllocation {
  readonly resumeContext: ExecutionResumeContext;
  readonly webhookEventId: string;
}

export interface RecoverableExecution {
  readonly sequence: number;
  readonly projectId: string;
  readonly record: ExecutionRecord;
  readonly request: ExecuteRequest;
  readonly resumeContext?: ExecutionResumeContext;
  readonly dispatchStartedAt?: string;
  readonly webhookEventId?: string;
  readonly webhookPublishedAt?: string;
  readonly usageFinalizedAt?: string;
}

export interface ExecutionRecoveryPage {
  readonly candidates: readonly RecoverableExecution[];
  readonly nextCursor?: number;
}

export type ExecutionAllocationResult =
  | { kind: "allocated"; record: ExecutionRecord & { status: "pending" } }
  | { kind: "replay"; record: ExecutionRecord }
  | { kind: "conflict" };

export type ExecutionAllocationInspection =
  | { kind: "available" }
  | { kind: "replay"; record: ExecutionRecord }
  | { kind: "conflict" };

export type ExecutionCancellationResult =
  | { kind: "cancelled"; record: CancelledExecutionRecord }
  | { kind: "already_cancelled"; record: CancelledExecutionRecord }
  | {
      kind: "already_terminal";
      record: SucceededExecutionRecord | FailedExecutionRecord;
    }
  | { kind: "not_found" };

export interface ExecutionListFilters {
  status?: ExecutionStatus;
  tool?: QualifiedToolName;
  userId?: string;
  cursor?: string;
  limit: number;
}

export interface ExecutionPage {
  executions: readonly ExecutionRecord[];
  nextCursor?: string;
}

/** Executor-only detail shape used by the admin API. */
export type ExecutionDetailRecord = ExecutionRecord & {
  projectId: string;
  input: Readonly<Record<string, JsonValue>>;
  mode: ExecuteRequest["mode"];
  connectionId?: ConnectionId;
  idempotencyKey?: string;
};

export class InvalidExecutionCursorError extends Error {
  constructor() {
    super("Execution cursor is invalid.");
    this.name = "InvalidExecutionCursorError";
  }
}

export interface ExecutionStore {
  /** Read-only idempotency preflight used before external usage admission. */
  inspectAllocation(
    allocation: ExecutionAllocation,
  ): Promise<ExecutionAllocationInspection>;
  allocate(allocation: ExecutionAllocation): Promise<ExecutionAllocationResult>;
  get(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<ExecutionRecord | undefined>;
  getDetail(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<ExecutionDetailRecord | undefined>;
  /** Records the first accepted replay observation without rewriting record JSON. */
  markReplayed(
    projectId: string,
    executionId: ExecutionId,
    observedAt: string,
  ): Promise<boolean>;
  update(projectId: string, record: ExecutionRecord): Promise<void>;
  cancelExecution(
    projectId: string,
    executionId: ExecutionId,
    cancelledAt: string,
  ): Promise<ExecutionCancellationResult>;
  waitForTerminal(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<TerminalExecutionRecord>;
  setResolvedConnection(
    projectId: string,
    executionId: ExecutionId,
    connectionId: ConnectionId | undefined,
  ): Promise<void>;
  list(
    projectId: string,
    filters: ExecutionListFilters,
  ): Promise<ExecutionPage>;
  getRecoverable(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<RecoverableExecution | undefined>;
  listRecoveryCandidates(input: {
    readonly cursor?: number;
    readonly limit: number;
  }): Promise<ExecutionRecoveryPage>;
  setResumeContext(
    projectId: string,
    executionId: ExecutionId,
    recovery: ExecutionRecoveryAllocation,
  ): Promise<boolean>;
  /** Persists the stable terminal webhook identity even for legacy rows. */
  setWebhookEventId(
    projectId: string,
    executionId: ExecutionId,
    webhookEventId: string,
  ): Promise<boolean>;
  /** True only for the worker that changes the dispatch marker from absent to present. */
  markDispatchStarted(
    projectId: string,
    executionId: ExecutionId,
    dispatchedAt: string,
  ): Promise<boolean>;
  markUsageFinalized(
    projectId: string,
    executionId: ExecutionId,
    finalizedAt: string,
  ): Promise<boolean>;
  markWebhookPublished(
    projectId: string,
    executionId: ExecutionId,
    publishedAt: string,
  ): Promise<boolean>;
}

interface StoredExecution {
  sequence: number;
  record: ExecutionRecord;
  request: ExecuteRequest;
  idempotencyKey?: string;
  resolvedConnectionId?: ConnectionId;
  resumeContext?: ExecutionResumeContext;
  dispatchStartedAt?: string;
  webhookEventId?: string;
  webhookPublishedAt?: string;
  usageFinalizedAt?: string;
  replayObservedAt?: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Projects the private replay sidecar into the bounded public record shape. */
export function projectExecutionRecord(
  record: ExecutionRecord,
  replayObservedAt: string | null | undefined,
): ExecutionRecord {
  return replayObservedAt == null ? record : { ...record, replayed: true };
}

/** Constructs the one canonical immutable cancellation payload for every store. */
export function cancelledExecutionRecord(
  record: Extract<ExecutionRecord, { status: "pending" | "running" }>,
  cancelledAt: string,
  dispatchStartedAt?: string,
): CancelledExecutionRecord {
  const completedAt = new Date(cancelledAt);
  if (Number.isNaN(completedAt.valueOf())) {
    throw new TypeError("Execution cancellation time must be a timestamp.");
  }
  const latencyStart = record.startedAt ?? record.createdAt;
  const latencyStartMs = Date.parse(latencyStart);
  if (!Number.isFinite(latencyStartMs)) {
    throw new TypeError("Execution latency start must be a timestamp.");
  }
  const dispatchMayHaveBegun = dispatchStartedAt !== undefined;
  return {
    executionId: record.executionId,
    tool: record.tool,
    toolVersion: record.toolVersion,
    catalogVersion: record.catalogVersion,
    status: "cancelled",
    userId: record.userId,
    createdAt: record.createdAt,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.source === undefined ? {} : { source: record.source }),
    ...(record.attachments === undefined
      ? {}
      : { attachments: record.attachments }),
    completedAt: completedAt.toISOString(),
    latencyMs: Math.max(0, completedAt.valueOf() - latencyStartMs),
    error: {
      code: "execution_cancelled",
      retryable: false,
      message: dispatchMayHaveBegun
        ? "Execution was cancelled after provider dispatch may have begun; upstream work may still complete."
        : "Execution was cancelled before provider dispatch.",
    },
    cancellation: { dispatchMayHaveBegun },
  };
}

function idempotencyStorageKey(
  projectId: string,
  scope: IdempotencyScope,
): string {
  return JSON.stringify([
    projectId,
    scope.tool,
    scope.userId,
    scope.connectionId,
    scope.catalogMajor,
    scope.key,
  ]);
}

function executionStorageKey(
  projectId: string,
  executionId: ExecutionId,
): string {
  return JSON.stringify([projectId, executionId]);
}

export function executionCursorAfter(executionId: ExecutionId): string {
  return Buffer.from(JSON.stringify({ after: executionId }), "utf8").toString(
    "base64url",
  );
}

export function executionIdFromCursor(cursor: string): ExecutionId {
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
      throw new InvalidExecutionCursorError();
    }
    return parsed.after as ExecutionId;
  } catch (error) {
    if (error instanceof InvalidExecutionCursorError) {
      throw error;
    }
    throw new InvalidExecutionCursorError();
  }
}

export function assertExecutionTransition(
  previous: ExecutionRecord,
  next: ExecutionRecord,
): void {
  if (next.replayed !== undefined) {
    throw new Error(
      "Execution replay provenance must be persisted through markReplayed.",
    );
  }
  if (previous.executionId !== next.executionId) {
    throw new Error("Execution update changed its execution ID.");
  }
  if (
    previous.tool !== next.tool ||
    previous.toolVersion !== next.toolVersion ||
    previous.catalogVersion !== next.catalogVersion ||
    previous.userId !== next.userId ||
    previous.createdAt !== next.createdAt ||
    !isDeepStrictEqual(previous.source, next.source) ||
    !isDeepStrictEqual(previous.attachments, next.attachments)
  ) {
    throw new Error("Execution identity fields are immutable.");
  }

  const valid =
    (previous.status === "pending" &&
      (next.status === "running" ||
        next.status === "failed" ||
        next.status === "cancelled")) ||
    (previous.status === "running" &&
      (next.status === "succeeded" ||
        next.status === "failed" ||
        next.status === "cancelled"));
  if (!valid) {
    throw new ExecutionTransitionConflictError(previous.status, next.status);
  }
}

export class ExecutionTransitionConflictError extends Error {
  readonly previousStatus: ExecutionStatus;
  readonly nextStatus: ExecutionStatus;

  constructor(previousStatus: ExecutionStatus, nextStatus: ExecutionStatus) {
    super(`Invalid execution transition: ${previousStatus} -> ${nextStatus}`);
    this.name = "ExecutionTransitionConflictError";
    this.previousStatus = previousStatus;
    this.nextStatus = nextStatus;
  }
}

export class InMemoryExecutionStore implements ExecutionStore {
  readonly #executions = new Map<string, Map<ExecutionId, StoredExecution>>();
  readonly #idempotency = new Map<string, StoredIdempotencyRecord>();
  readonly #idempotencyByExecution = new Map<string, string>();
  readonly #terminalWaiters = new Map<
    string,
    Set<(record: TerminalExecutionRecord) => void>
  >();
  #sequence = 0;

  async inspectAllocation(
    allocation: ExecutionAllocation,
  ): Promise<ExecutionAllocationInspection> {
    const reservation = allocation.idempotency;
    if (reservation === undefined) return { kind: "available" };
    const existing = this.#idempotency.get(
      idempotencyStorageKey(allocation.projectId, reservation.scope),
    );
    if (
      existing === undefined ||
      Date.parse(existing.expiresAt) <= Date.parse(allocation.record.createdAt)
    ) {
      return { kind: "available" };
    }
    if (existing.requestHash !== reservation.requestHash) {
      return { kind: "conflict" };
    }
    const stored = this.#executions
      .get(allocation.projectId)
      ?.get(existing.executionId);
    if (stored === undefined) {
      throw new Error(
        "Execution idempotency record references an unknown execution.",
      );
    }
    return {
      kind: "replay",
      record: clone(
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
    const projectExecutions = this.#projectExecutions(allocation.projectId);
    const reservation = allocation.idempotency;

    let idempotencyKey: string | undefined;
    let expiredIdempotency: StoredIdempotencyRecord | undefined;
    if (reservation !== undefined) {
      const storageKey = idempotencyStorageKey(
        allocation.projectId,
        reservation.scope,
      );
      const existing = this.#idempotency.get(storageKey);
      if (
        existing !== undefined &&
        Date.parse(existing.expiresAt) > Date.parse(allocation.record.createdAt)
      ) {
        if (existing.requestHash !== reservation.requestHash) {
          return { kind: "conflict" };
        }
        const existingExecution = projectExecutions.get(existing.executionId);
        if (existingExecution !== undefined) {
          return {
            kind: "replay",
            record: clone(
              projectExecutionRecord(
                existingExecution.record,
                existingExecution.replayObservedAt,
              ),
            ),
          };
        }
      }

      idempotencyKey = storageKey;
      expiredIdempotency = existing;
    }

    if (projectExecutions.has(allocation.record.executionId)) {
      throw new Error(
        `Duplicate execution ID: ${allocation.record.executionId}`,
      );
    }

    if (idempotencyKey !== undefined && reservation !== undefined) {
      if (expiredIdempotency !== undefined) {
        this.#idempotency.delete(idempotencyKey);
        this.#idempotencyByExecution.delete(
          executionStorageKey(
            expiredIdempotency.projectId,
            expiredIdempotency.executionId,
          ),
        );
      }
      this.#idempotency.set(idempotencyKey, {
        projectId: allocation.projectId,
        executionId: allocation.record.executionId,
        ...clone(reservation),
      });
      this.#idempotencyByExecution.set(
        executionStorageKey(
          allocation.projectId,
          allocation.record.executionId,
        ),
        idempotencyKey,
      );
    }
    projectExecutions.set(allocation.record.executionId, {
      sequence: ++this.#sequence,
      record: clone(allocation.record),
      request: clone(allocation.request),
      ...(allocation.idempotency === undefined
        ? {}
        : { idempotencyKey: allocation.idempotency.scope.key }),
      ...(allocation.recovery === undefined
        ? {}
        : {
            resumeContext: clone(allocation.recovery.resumeContext),
            webhookEventId: allocation.recovery.webhookEventId,
          }),
    });
    return { kind: "allocated", record: clone(allocation.record) };
  }

  async get(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<ExecutionRecord | undefined> {
    const stored = this.#executions.get(projectId)?.get(executionId);
    return stored === undefined
      ? undefined
      : clone(projectExecutionRecord(stored.record, stored.replayObservedAt));
  }

  async getDetail(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<ExecutionDetailRecord | undefined> {
    const stored = this.#executions.get(projectId)?.get(executionId);
    if (stored === undefined) {
      return undefined;
    }
    return clone({
      ...projectExecutionRecord(stored.record, stored.replayObservedAt),
      projectId,
      input: stored.request.input,
      mode: stored.request.mode,
      ...(stored.resolvedConnectionId === undefined &&
      stored.request.connectionId === undefined
        ? {}
        : {
            connectionId:
              stored.resolvedConnectionId ?? stored.request.connectionId,
          }),
      ...(stored.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: stored.idempotencyKey }),
    });
  }

  async markReplayed(
    projectId: string,
    executionId: ExecutionId,
    observedAt: string,
  ): Promise<boolean> {
    const stored = this.#executions.get(projectId)?.get(executionId);
    if (stored === undefined) return false;
    stored.replayObservedAt ??= new Date(observedAt).toISOString();
    return true;
  }

  async update(projectId: string, record: ExecutionRecord): Promise<void> {
    const stored = this.#executions.get(projectId)?.get(record.executionId);
    if (stored === undefined) {
      throw new Error(`Unknown execution ID: ${record.executionId}`);
    }
    assertExecutionTransition(stored.record, record);
    stored.record = clone(record);
    if (
      record.status === "succeeded" ||
      record.status === "failed" ||
      record.status === "cancelled"
    ) {
      const key = executionStorageKey(projectId, record.executionId);
      const waiters = this.#terminalWaiters.get(key);
      this.#terminalWaiters.delete(key);
      for (const resolve of waiters ?? []) {
        resolve(
          clone(
            projectExecutionRecord(record, stored.replayObservedAt),
          ) as TerminalExecutionRecord,
        );
      }
    }
  }

  async cancelExecution(
    projectId: string,
    executionId: ExecutionId,
    cancelledAt: string,
  ): Promise<ExecutionCancellationResult> {
    const stored = this.#executions.get(projectId)?.get(executionId);
    if (stored === undefined) return { kind: "not_found" };
    const current = stored.record;
    if (current.status === "cancelled") {
      return {
        kind: "already_cancelled",
        record: clone(
          projectExecutionRecord(current, stored.replayObservedAt),
        ) as CancelledExecutionRecord,
      };
    }
    if (current.status === "succeeded" || current.status === "failed") {
      return {
        kind: "already_terminal",
        record: clone(
          projectExecutionRecord(current, stored.replayObservedAt),
        ) as SucceededExecutionRecord | FailedExecutionRecord,
      };
    }
    const cancelled = cancelledExecutionRecord(
      current,
      cancelledAt,
      stored.dispatchStartedAt,
    );
    assertExecutionTransition(current, cancelled);
    stored.record = clone(cancelled);
    const key = executionStorageKey(projectId, executionId);
    const waiters = this.#terminalWaiters.get(key);
    this.#terminalWaiters.delete(key);
    const projected = clone(
      projectExecutionRecord(cancelled, stored.replayObservedAt),
    ) as CancelledExecutionRecord;
    for (const resolve of waiters ?? []) resolve(clone(projected));
    return { kind: "cancelled", record: projected };
  }

  async waitForTerminal(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<TerminalExecutionRecord> {
    const stored = this.#executions.get(projectId)?.get(executionId);
    if (stored === undefined) {
      throw new Error(`Unknown execution ID: ${executionId}`);
    }
    if (
      stored.record.status === "succeeded" ||
      stored.record.status === "failed" ||
      stored.record.status === "cancelled"
    ) {
      return clone(
        projectExecutionRecord(stored.record, stored.replayObservedAt),
      ) as TerminalExecutionRecord;
    }
    const key = executionStorageKey(projectId, executionId);
    return new Promise((resolve) => {
      const waiters = this.#terminalWaiters.get(key) ?? new Set();
      waiters.add(resolve);
      this.#terminalWaiters.set(key, waiters);
    });
  }

  async setResolvedConnection(
    projectId: string,
    executionId: ExecutionId,
    connectionId: ConnectionId | undefined,
  ): Promise<void> {
    const execution = this.#executions.get(projectId)?.get(executionId);
    if (execution === undefined) {
      throw new Error(`Unknown execution ID: ${executionId}`);
    }
    if (connectionId === undefined) {
      delete execution.resolvedConnectionId;
    } else {
      execution.resolvedConnectionId = connectionId;
    }

    const storageKey = this.#idempotencyByExecution.get(
      executionStorageKey(projectId, executionId),
    );
    if (storageKey === undefined) {
      return;
    }
    const stored = this.#idempotency.get(storageKey);
    if (stored === undefined || stored.projectId !== projectId) {
      return;
    }
    if (connectionId === undefined) {
      delete stored.resolvedConnectionId;
    } else {
      stored.resolvedConnectionId = connectionId;
    }
  }

  async list(
    projectId: string,
    filters: ExecutionListFilters,
  ): Promise<ExecutionPage> {
    const all = [...(this.#executions.get(projectId)?.values() ?? [])]
      .reverse()
      .map((stored) =>
        projectExecutionRecord(stored.record, stored.replayObservedAt),
      )
      .filter(
        (record) =>
          (filters.status === undefined || record.status === filters.status) &&
          (filters.tool === undefined || record.tool === filters.tool) &&
          (filters.userId === undefined || record.userId === filters.userId),
      );
    let offset = 0;
    if (filters.cursor !== undefined) {
      const after = executionIdFromCursor(filters.cursor);
      const index = all.findIndex((record) => record.executionId === after);
      if (index === -1) throw new InvalidExecutionCursorError();
      offset = index + 1;
    }
    const executions = all
      .slice(offset, offset + filters.limit)
      .map((record) => clone(record));
    const nextOffset = offset + executions.length;
    const last = executions.at(-1);

    return {
      executions,
      ...(nextOffset < all.length && last !== undefined
        ? { nextCursor: executionCursorAfter(last.executionId) }
        : {}),
    };
  }

  async getRecoverable(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<RecoverableExecution | undefined> {
    const stored = this.#executions.get(projectId)?.get(executionId);
    return stored === undefined
      ? undefined
      : clone({
          sequence: stored.sequence,
          projectId,
          record: projectExecutionRecord(
            stored.record,
            stored.replayObservedAt,
          ),
          request: stored.request,
          ...(stored.resumeContext === undefined
            ? {}
            : { resumeContext: stored.resumeContext }),
          ...(stored.dispatchStartedAt === undefined
            ? {}
            : { dispatchStartedAt: stored.dispatchStartedAt }),
          ...(stored.webhookEventId === undefined
            ? {}
            : { webhookEventId: stored.webhookEventId }),
          ...(stored.webhookPublishedAt === undefined
            ? {}
            : { webhookPublishedAt: stored.webhookPublishedAt }),
          ...(stored.usageFinalizedAt === undefined
            ? {}
            : { usageFinalizedAt: stored.usageFinalizedAt }),
        });
  }

  async listRecoveryCandidates(input: {
    readonly cursor?: number;
    readonly limit: number;
  }): Promise<ExecutionRecoveryPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new RangeError("Execution recovery limit must be positive.");
    }
    const candidates = [...this.#executions.entries()]
      .flatMap(([projectId, executions]) =>
        [...executions.values()].map((stored) => ({ projectId, stored })),
      )
      .filter(({ stored }) => {
        if (input.cursor !== undefined && stored.sequence <= input.cursor) {
          return false;
        }
        if (
          stored.record.status === "pending" ||
          stored.record.status === "running"
        ) {
          return true;
        }
        const webhookIncomplete =
          stored.webhookEventId !== undefined &&
          stored.webhookPublishedAt === undefined;
        const usageRequired =
          stored.resumeContext?.usageReport !== undefined ||
          stored.resumeContext?.usageReservation !== undefined;
        return (
          webhookIncomplete ||
          (usageRequired && stored.usageFinalizedAt === undefined)
        );
      })
      .sort((left, right) => left.stored.sequence - right.stored.sequence)
      .slice(0, input.limit);
    const materialized = await Promise.all(
      candidates.map(({ projectId, stored }) =>
        this.getRecoverable(projectId, stored.record.executionId),
      ),
    );
    const page = materialized.filter(
      (candidate): candidate is RecoverableExecution => candidate !== undefined,
    );
    const last = page.at(-1);
    return {
      candidates: page,
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
    const stored = this.#executions.get(projectId)?.get(executionId);
    if (stored === undefined) return false;
    if (
      stored.resumeContext !== undefined &&
      !isDeepStrictEqual(stored.resumeContext, recovery.resumeContext)
    ) {
      throw new Error("Execution resume context is immutable.");
    }
    if (
      stored.webhookEventId !== undefined &&
      stored.webhookEventId !== recovery.webhookEventId
    ) {
      throw new Error("Execution webhook event identity is immutable.");
    }
    stored.resumeContext = clone(recovery.resumeContext);
    stored.webhookEventId = recovery.webhookEventId;
    return true;
  }

  async setWebhookEventId(
    projectId: string,
    executionId: ExecutionId,
    webhookEventId: string,
  ): Promise<boolean> {
    const stored = this.#executions.get(projectId)?.get(executionId);
    if (stored === undefined) return false;
    if (
      stored.webhookEventId !== undefined &&
      stored.webhookEventId !== webhookEventId
    ) {
      throw new Error("Execution webhook event identity is immutable.");
    }
    stored.webhookEventId = webhookEventId;
    return true;
  }

  async markDispatchStarted(
    projectId: string,
    executionId: ExecutionId,
    dispatchedAt: string,
  ): Promise<boolean> {
    const stored = this.#executions.get(projectId)?.get(executionId);
    if (stored === undefined || stored.record.status !== "running")
      return false;
    if (stored.dispatchStartedAt !== undefined) return false;
    stored.dispatchStartedAt = new Date(dispatchedAt).toISOString();
    return true;
  }

  async markUsageFinalized(
    projectId: string,
    executionId: ExecutionId,
    finalizedAt: string,
  ): Promise<boolean> {
    const stored = this.#executions.get(projectId)?.get(executionId);
    if (stored === undefined) return false;
    stored.usageFinalizedAt ??= new Date(finalizedAt).toISOString();
    return true;
  }

  async markWebhookPublished(
    projectId: string,
    executionId: ExecutionId,
    publishedAt: string,
  ): Promise<boolean> {
    const stored = this.#executions.get(projectId)?.get(executionId);
    if (stored === undefined || stored.webhookEventId === undefined)
      return false;
    stored.webhookPublishedAt ??= new Date(publishedAt).toISOString();
    return true;
  }

  #projectExecutions(projectId: string): Map<ExecutionId, StoredExecution> {
    const existing = this.#executions.get(projectId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Map<ExecutionId, StoredExecution>();
    this.#executions.set(projectId, created);
    return created;
  }
}
