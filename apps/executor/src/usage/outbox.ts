import { isDeepStrictEqual } from "node:util";
import type { ExecutionId } from "@eyeball/core";

export type UsageOutboxState = "pending" | "sent" | "failed";

export interface UsageReportPayload {
  readonly projectId: string;
  readonly executionId: ExecutionId;
  readonly cloudExecutionId?: ExecutionId;
  readonly idempotencyKey: string;
  readonly dimension: "execution";
  readonly quantity: 1;
  readonly occurredAt: string;
}

/** Durable pre-dispatch reservation release work. */
export interface UsageReleasePayload {
  readonly operation: "release";
  readonly projectId: string;
  readonly executionId: ExecutionId;
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly cloudExecutionId?: ExecutionId;
  readonly reservedAt?: string;
}

export type UsageOutboxPayload = UsageReportPayload | UsageReleasePayload;

export function isUsageReleasePayload(
  payload: UsageOutboxPayload,
): payload is UsageReleasePayload {
  return "operation" in payload && payload.operation === "release";
}

export interface UsageOutboxRecord {
  readonly executionId: ExecutionId;
  readonly payload: UsageOutboxPayload;
  readonly state: UsageOutboxState;
  readonly attempts: number;
  readonly nextRetryAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sentAt?: string;
}

export interface UsageOutboxFailure {
  readonly executionId: ExecutionId;
  readonly nextRetryAt: string;
}

export interface UsageOutboxStore {
  enqueue(payload: UsageOutboxPayload, enqueuedAt: string): Promise<void>;
  get(executionId: ExecutionId): Promise<UsageOutboxRecord | undefined>;
  listReady(
    now: string,
    limit: number,
    includeDeferred?: boolean,
  ): Promise<readonly UsageOutboxRecord[]>;
  markSent(executionIds: readonly ExecutionId[], sentAt: string): Promise<void>;
  markFailed(
    failures: readonly UsageOutboxFailure[],
    failedAt: string,
  ): Promise<void>;
  depth(): Promise<number>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function assertTimestamp(value: string, name: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be a valid timestamp.`);
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("Usage outbox batch limit must be from 1 through 50.");
  }
}

export function sameUsageOutboxPayload(
  left: UsageOutboxPayload,
  right: UsageOutboxPayload,
): boolean {
  return isDeepStrictEqual(left, right);
}

export class InMemoryUsageOutboxStore implements UsageOutboxStore {
  readonly #records = new Map<ExecutionId, UsageOutboxRecord>();

  async enqueue(
    payload: UsageOutboxPayload,
    enqueuedAt: string,
  ): Promise<void> {
    assertTimestamp(enqueuedAt, "Usage outbox enqueue time");
    const existing = this.#records.get(payload.executionId);
    if (existing !== undefined) {
      if (!sameUsageOutboxPayload(existing.payload, payload)) {
        throw new Error(
          `Usage outbox execution ${payload.executionId} has conflicting payloads.`,
        );
      }
      return;
    }
    this.#records.set(payload.executionId, {
      executionId: payload.executionId,
      payload: copy(payload),
      state: "pending",
      attempts: 0,
      nextRetryAt: enqueuedAt,
      createdAt: enqueuedAt,
      updatedAt: enqueuedAt,
    });
  }

  async get(executionId: ExecutionId): Promise<UsageOutboxRecord | undefined> {
    const record = this.#records.get(executionId);
    return record === undefined ? undefined : copy(record);
  }

  async listReady(
    now: string,
    limit: number,
    includeDeferred = false,
  ): Promise<readonly UsageOutboxRecord[]> {
    assertTimestamp(now, "Usage outbox read time");
    assertLimit(limit);
    const nowMs = Date.parse(now);
    return [...this.#records.values()]
      .filter(
        (record) =>
          record.state !== "sent" &&
          (includeDeferred || Date.parse(record.nextRetryAt) <= nowMs),
      )
      .sort(
        (left, right) =>
          Date.parse(left.nextRetryAt) - Date.parse(right.nextRetryAt) ||
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.executionId.localeCompare(right.executionId),
      )
      .slice(0, limit)
      .map(copy);
  }

  async markSent(
    executionIds: readonly ExecutionId[],
    sentAt: string,
  ): Promise<void> {
    assertTimestamp(sentAt, "Usage outbox sent time");
    for (const executionId of executionIds) {
      const existing = this.#records.get(executionId);
      if (existing === undefined || existing.state === "sent") continue;
      this.#records.set(executionId, {
        ...existing,
        state: "sent",
        nextRetryAt: sentAt,
        updatedAt: sentAt,
        sentAt,
      });
    }
  }

  async markFailed(
    failures: readonly UsageOutboxFailure[],
    failedAt: string,
  ): Promise<void> {
    assertTimestamp(failedAt, "Usage outbox failure time");
    for (const failure of failures) {
      assertTimestamp(failure.nextRetryAt, "Usage outbox retry time");
      const existing = this.#records.get(failure.executionId);
      if (existing === undefined || existing.state === "sent") continue;
      this.#records.set(failure.executionId, {
        ...existing,
        state: "failed",
        attempts: existing.attempts + 1,
        nextRetryAt: failure.nextRetryAt,
        updatedAt: failedAt,
      });
    }
  }

  async depth(): Promise<number> {
    return [...this.#records.values()].filter(
      (record) => record.state !== "sent",
    ).length;
  }
}
