import { randomUUID } from "node:crypto";
import type { VoiceAgentSessionPointer } from "@eyeball/toolkits";
import type {
  ClaimedVoiceSessionObserver,
  VoiceObserverLeaseMutation,
  VoiceSessionObserverRecord,
  VoiceSessionObserverStore,
} from "./observer-store.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Voice observer limit must be positive.");
  }
}

function leaseMatches(
  record: VoiceSessionObserverRecord,
  input: VoiceObserverLeaseMutation,
): boolean {
  return (
    record.leaseOwner === input.leaseOwner &&
    record.leaseToken === input.leaseToken &&
    record.leaseExpiresAt !== undefined &&
    Date.parse(record.leaseExpiresAt) > Date.parse(input.now)
  );
}

function withoutLease(
  record: VoiceSessionObserverRecord,
): VoiceSessionObserverRecord {
  const {
    leaseOwner: _leaseOwner,
    leaseToken: _leaseToken,
    leaseExpiresAt: _leaseExpiresAt,
    ...rest
  } = record;
  return rest;
}

/** Process-local parity store; durable recovery requires the Postgres implementation. */
export class InMemoryVoiceSessionObserverStore
  implements VoiceSessionObserverStore
{
  readonly #records = new Map<string, VoiceSessionObserverRecord>();
  readonly #pointers = new Map<string, VoiceAgentSessionPointer>();

  async ensurePrepared(
    pointer: VoiceAgentSessionPointer,
    now: string,
    nextAttemptAt?: string,
  ): Promise<VoiceSessionObserverRecord> {
    const existing = this.#records.get(pointer.sessionId);
    if (existing !== undefined) {
      const prior = this.#pointers.get(pointer.sessionId);
      if (
        prior === undefined ||
        prior.projectId !== pointer.projectId ||
        prior.userId !== pointer.userId ||
        prior.agentId !== pointer.agentId ||
        prior.agentRevision !== pointer.agentRevision
      ) {
        throw new Error("Voice observer pointer identity changed.");
      }
      this.#pointers.set(pointer.sessionId, copy(pointer));
      return copy(existing);
    }
    const record: VoiceSessionObserverRecord = {
      sessionId: pointer.sessionId,
      handledSequence: 0,
      status: "prepared",
      transcriptStatus: "pending",
      consecutiveFailures: 0,
      ...(nextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: new Date(nextAttemptAt).toISOString() }),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    this.#pointers.set(pointer.sessionId, copy(pointer));
    this.#records.set(pointer.sessionId, record);
    return copy(record);
  }

  async activatePrepared(sessionId: string, now: string): Promise<boolean> {
    const record = this.#records.get(sessionId);
    if (record === undefined) return false;
    if (record.status === "observing") return true;
    if (record.status !== "prepared") return false;
    this.#records.set(sessionId, {
      ...record,
      status: "observing",
      nextAttemptAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    return true;
  }

  async cancelPrepared(sessionId: string, now: string): Promise<boolean> {
    const record = this.#records.get(sessionId);
    if (record === undefined || record.status !== "prepared") return false;
    this.#records.set(sessionId, {
      ...withoutFailureSchedule(withoutLease(record)),
      status: "cancelled",
      updatedAt: new Date(now).toISOString(),
    });
    return true;
  }

  async backfillMissing(input: {
    now: string;
    limit: number;
  }): Promise<number> {
    assertLimit(input.limit);
    return 0;
  }

  async get(
    sessionId: string,
  ): Promise<VoiceSessionObserverRecord | undefined> {
    const record = this.#records.get(sessionId);
    return record === undefined ? undefined : copy(record);
  }

  async claim(input: {
    leaseOwner: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<readonly ClaimedVoiceSessionObserver[]> {
    assertLimit(input.limit);
    if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
      throw new RangeError(
        "Voice observer lease expiry must follow claim time.",
      );
    }
    const candidates = [...this.#records.values()]
      .filter((record) => {
        const recoverable =
          record.status === "prepared" ||
          record.status === "observing" ||
          record.status === "finalizing" ||
          (record.status === "exhausted" &&
            record.exhaustionSignaledAt === undefined);
        const due =
          record.nextAttemptAt === undefined ||
          Date.parse(record.nextAttemptAt) <= Date.parse(input.now);
        const available =
          record.leaseExpiresAt === undefined ||
          Date.parse(record.leaseExpiresAt) <= Date.parse(input.now);
        return recoverable && due && available;
      })
      .sort(
        (left, right) =>
          (left.nextAttemptAt ?? left.createdAt).localeCompare(
            right.nextAttemptAt ?? right.createdAt,
          ) || left.sessionId.localeCompare(right.sessionId),
      )
      .slice(0, input.limit);
    const claimed: ClaimedVoiceSessionObserver[] = [];
    for (const candidate of candidates) {
      const pointer = this.#pointers.get(candidate.sessionId);
      if (pointer === undefined) continue;
      const record: VoiceSessionObserverRecord = {
        ...withoutLease(candidate),
        leaseOwner: input.leaseOwner,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(input.leaseExpiresAt).toISOString(),
        updatedAt: new Date(input.now).toISOString(),
      };
      this.#records.set(record.sessionId, record);
      claimed.push({
        ...copy(record),
        pointer: copy(pointer),
      } as ClaimedVoiceSessionObserver);
    }
    return claimed;
  }

  async renew(
    input: VoiceObserverLeaseMutation & { leaseExpiresAt: string },
  ): Promise<boolean> {
    const record = this.#records.get(input.sessionId);
    if (
      record === undefined ||
      !leaseMatches(record, input) ||
      Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)
    ) {
      return false;
    }
    this.#records.set(input.sessionId, {
      ...record,
      leaseExpiresAt: new Date(input.leaseExpiresAt).toISOString(),
      updatedAt: new Date(input.now).toISOString(),
    });
    return true;
  }

  async release(input: VoiceObserverLeaseMutation): Promise<boolean> {
    return this.#mutate(input, (record) => withoutLease(record));
  }

  async cancelClaim(input: VoiceObserverLeaseMutation): Promise<boolean> {
    return this.#mutate(input, (record) =>
      record.status !== "prepared"
        ? undefined
        : {
            ...withoutFailureSchedule(withoutLease(record)),
            status: "cancelled",
            updatedAt: input.now,
          },
    );
  }

  async activateClaim(input: VoiceObserverLeaseMutation): Promise<boolean> {
    return this.#mutate(input, (record) =>
      record.status !== "prepared"
        ? undefined
        : {
            ...withoutFailureSchedule(record),
            status: "observing",
            consecutiveFailures: 0,
            nextAttemptAt: input.now,
            updatedAt: input.now,
          },
    );
  }

  async advanceSequence(
    input: VoiceObserverLeaseMutation & {
      expectedSequence: number;
      handledSequence: number;
    },
  ): Promise<boolean> {
    if (input.handledSequence !== input.expectedSequence + 1) return false;
    return this.#mutate(input, (record) =>
      record.status !== "observing" ||
      record.handledSequence !== input.expectedSequence
        ? undefined
        : {
            ...record,
            handledSequence: input.handledSequence,
            updatedAt: input.now,
          },
    );
  }

  async markTerminalHandled(
    input: VoiceObserverLeaseMutation & {
      terminalSequence: number;
      handledAt: string;
    },
  ): Promise<boolean> {
    return this.#mutate(input, (record) =>
      record.status !== "observing" ||
      input.terminalSequence !== record.handledSequence + 1
        ? undefined
        : {
            ...record,
            terminalSequence: input.terminalSequence,
            terminalHandledAt: input.handledAt,
            updatedAt: input.now,
          },
    );
  }

  async enterFinalizing(
    input: VoiceObserverLeaseMutation & { terminalSequence: number },
  ): Promise<boolean> {
    return this.#mutate(input, (record) =>
      record.status !== "observing" ||
      record.terminalHandledAt === undefined ||
      record.terminalSequence !== input.terminalSequence ||
      record.handledSequence < input.terminalSequence
        ? undefined
        : {
            ...withoutFailureSchedule(record),
            status: "finalizing",
            terminalSequence: input.terminalSequence,
            consecutiveFailures: 0,
            updatedAt: input.now,
          },
    );
  }

  async markTranscriptHandled(
    input: VoiceObserverLeaseMutation & {
      status: "admitted" | "skipped";
      handledAt: string;
    },
  ): Promise<boolean> {
    return this.#mutate(input, (record) =>
      record.status !== "finalizing"
        ? undefined
        : {
            ...record,
            transcriptStatus: input.status,
            transcriptHandledAt: input.handledAt,
            updatedAt: input.now,
          },
    );
  }

  async schedulePoll(
    input: VoiceObserverLeaseMutation & { nextAttemptAt: string },
  ): Promise<boolean> {
    return this.#mutate(input, (record) =>
      record.status !== "observing"
        ? undefined
        : {
            ...withoutFailureSchedule(withoutLease(record)),
            status: "observing",
            consecutiveFailures: 0,
            nextAttemptAt: input.nextAttemptAt,
            updatedAt: input.now,
          },
    );
  }

  async recordFailure(
    input: VoiceObserverLeaseMutation & {
      kind: VoiceSessionObserverRecord["lastFailureKind"] & string;
      operation: VoiceSessionObserverRecord["lastFailureOperation"] & string;
      failedAt: string;
      nextAttemptAt: string;
    },
  ): Promise<VoiceSessionObserverRecord | undefined> {
    let result: VoiceSessionObserverRecord | undefined;
    await this.#mutate(input, (record) => {
      if (
        record.status !== "prepared" &&
        record.status !== "observing" &&
        record.status !== "finalizing"
      ) {
        return undefined;
      }
      result = {
        ...record,
        consecutiveFailures: record.consecutiveFailures + 1,
        lastFailureKind: input.kind,
        lastFailureOperation: input.operation,
        lastFailureAt: input.failedAt,
        nextAttemptAt: input.nextAttemptAt,
        updatedAt: input.now,
      };
      return result;
    });
    return result === undefined ? undefined : copy(result);
  }

  async exhaust(
    input: VoiceObserverLeaseMutation & {
      kind: VoiceSessionObserverRecord["lastFailureKind"] & string;
      operation: VoiceSessionObserverRecord["lastFailureOperation"] & string;
      attempts: number;
      exhaustedAt: string;
    },
  ): Promise<boolean> {
    return this.#mutate(input, (record) =>
      record.status !== "prepared" &&
      record.status !== "observing" &&
      record.status !== "finalizing"
        ? undefined
        : {
            ...withoutNextAttempt(withoutLease(record)),
            status: "exhausted",
            consecutiveFailures: input.attempts,
            lastFailureKind: input.kind,
            lastFailureOperation: input.operation,
            lastFailureAt: input.exhaustedAt,
            exhaustedAt: input.exhaustedAt,
            updatedAt: input.now,
          },
    );
  }

  async markExhaustionSignaled(
    input: VoiceObserverLeaseMutation & { signaledAt: string },
  ): Promise<boolean> {
    return this.#mutate(input, (record) =>
      record.status !== "exhausted" || record.exhaustionSignaledAt !== undefined
        ? undefined
        : {
            ...withoutLease(record),
            exhaustionSignaledAt: input.signaledAt,
            updatedAt: input.now,
          },
    );
  }

  async complete(
    input: VoiceObserverLeaseMutation & { completedAt: string },
  ): Promise<boolean> {
    return this.#mutate(input, (record) =>
      record.status !== "finalizing" || record.transcriptStatus === "pending"
        ? undefined
        : {
            ...withoutFailureSchedule(withoutLease(record)),
            status: "completed",
            consecutiveFailures: 0,
            updatedAt: input.completedAt,
          },
    );
  }

  async #mutate(
    input: VoiceObserverLeaseMutation,
    update: (
      record: VoiceSessionObserverRecord,
    ) => VoiceSessionObserverRecord | undefined,
  ): Promise<boolean> {
    const record = this.#records.get(input.sessionId);
    if (record === undefined || !leaseMatches(record, input)) return false;
    const changed = update(record);
    if (changed === undefined) return false;
    this.#records.set(input.sessionId, changed);
    return true;
  }
}

function withoutFailureSchedule(
  record: VoiceSessionObserverRecord,
): VoiceSessionObserverRecord {
  const result = copy(record) as {
    -readonly [Key in keyof VoiceSessionObserverRecord]: VoiceSessionObserverRecord[Key];
  };
  delete result.lastFailureKind;
  delete result.lastFailureOperation;
  delete result.lastFailureAt;
  delete result.nextAttemptAt;
  return result;
}

function withoutNextAttempt(
  record: VoiceSessionObserverRecord,
): VoiceSessionObserverRecord {
  const result = copy(record) as {
    -readonly [Key in keyof VoiceSessionObserverRecord]: VoiceSessionObserverRecord[Key];
  };
  delete result.nextAttemptAt;
  return result;
}
