import type {
  ConnectionId,
  ExecuteRequest,
  ExecutionId,
  ExecutionRecord,
  ExecutionStatus,
  JsonValue,
  QualifiedToolName,
} from "@eyeball/core";

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
}

export type ExecutionAllocationResult =
  | { kind: "allocated"; record: ExecutionRecord & { status: "pending" } }
  | { kind: "replay"; record: ExecutionRecord }
  | { kind: "conflict" };

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
  allocate(allocation: ExecutionAllocation): Promise<ExecutionAllocationResult>;
  get(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<ExecutionRecord | undefined>;
  getDetail(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<ExecutionDetailRecord | undefined>;
  update(projectId: string, record: ExecutionRecord): Promise<void>;
  setResolvedConnection(
    projectId: string,
    executionId: ExecutionId,
    connectionId: ConnectionId | undefined,
  ): Promise<void>;
  list(
    projectId: string,
    filters: ExecutionListFilters,
  ): Promise<ExecutionPage>;
}

interface StoredExecution {
  record: ExecutionRecord;
  request: ExecuteRequest;
  idempotencyKey?: string;
  resolvedConnectionId?: ConnectionId;
}

function clone<T>(value: T): T {
  return structuredClone(value);
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

function cursorForOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function offsetFromCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("offset" in parsed) ||
      !Number.isInteger(parsed.offset) ||
      (parsed.offset as number) < 0
    ) {
      throw new InvalidExecutionCursorError();
    }
    return parsed.offset as number;
  } catch (error) {
    if (error instanceof InvalidExecutionCursorError) {
      throw error;
    }
    throw new InvalidExecutionCursorError();
  }
}

function assertTransition(
  previous: ExecutionRecord,
  next: ExecutionRecord,
): void {
  if (previous.executionId !== next.executionId) {
    throw new Error("Execution update changed its execution ID.");
  }
  if (
    previous.tool !== next.tool ||
    previous.toolVersion !== next.toolVersion ||
    previous.catalogVersion !== next.catalogVersion ||
    previous.userId !== next.userId ||
    previous.createdAt !== next.createdAt
  ) {
    throw new Error("Execution identity fields are immutable.");
  }

  const valid =
    (previous.status === "pending" &&
      (next.status === "running" || next.status === "failed")) ||
    (previous.status === "running" &&
      (next.status === "succeeded" || next.status === "failed"));
  if (!valid) {
    throw new Error(
      `Invalid execution transition: ${previous.status} -> ${next.status}`,
    );
  }
}

export class InMemoryExecutionStore implements ExecutionStore {
  readonly #executions = new Map<string, Map<ExecutionId, StoredExecution>>();
  readonly #idempotency = new Map<string, StoredIdempotencyRecord>();
  readonly #idempotencyByExecution = new Map<string, string>();

  async allocate(
    allocation: ExecutionAllocation,
  ): Promise<ExecutionAllocationResult> {
    const projectExecutions = this.#projectExecutions(allocation.projectId);
    const reservation = allocation.idempotency;

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
          return { kind: "replay", record: clone(existingExecution.record) };
        }
      }

      if (existing !== undefined) {
        this.#idempotency.delete(storageKey);
        this.#idempotencyByExecution.delete(
          executionStorageKey(existing.projectId, existing.executionId),
        );
      }
      this.#idempotency.set(storageKey, {
        projectId: allocation.projectId,
        executionId: allocation.record.executionId,
        ...clone(reservation),
      });
      this.#idempotencyByExecution.set(
        executionStorageKey(
          allocation.projectId,
          allocation.record.executionId,
        ),
        storageKey,
      );
    }

    if (projectExecutions.has(allocation.record.executionId)) {
      throw new Error(
        `Duplicate execution ID: ${allocation.record.executionId}`,
      );
    }
    projectExecutions.set(allocation.record.executionId, {
      record: clone(allocation.record),
      request: clone(allocation.request),
      ...(allocation.idempotency === undefined
        ? {}
        : { idempotencyKey: allocation.idempotency.scope.key }),
    });
    return { kind: "allocated", record: clone(allocation.record) };
  }

  async get(
    projectId: string,
    executionId: ExecutionId,
  ): Promise<ExecutionRecord | undefined> {
    const stored = this.#executions.get(projectId)?.get(executionId);
    return stored === undefined ? undefined : clone(stored.record);
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
      ...stored.record,
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

  async update(projectId: string, record: ExecutionRecord): Promise<void> {
    const stored = this.#executions.get(projectId)?.get(record.executionId);
    if (stored === undefined) {
      throw new Error(`Unknown execution ID: ${record.executionId}`);
    }
    assertTransition(stored.record, record);
    stored.record = clone(record);
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
      .map(({ record }) => record)
      .filter(
        (record) =>
          (filters.status === undefined || record.status === filters.status) &&
          (filters.tool === undefined || record.tool === filters.tool) &&
          (filters.userId === undefined || record.userId === filters.userId),
      );
    const offset =
      filters.cursor === undefined ? 0 : offsetFromCursor(filters.cursor);
    const executions = all
      .slice(offset, offset + filters.limit)
      .map((record) => clone(record));
    const nextOffset = offset + executions.length;

    return {
      executions,
      ...(nextOffset < all.length
        ? { nextCursor: cursorForOffset(nextOffset) }
        : {}),
    };
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
