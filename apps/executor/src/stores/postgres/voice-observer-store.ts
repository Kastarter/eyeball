import { randomUUID } from "node:crypto";
import type { VoiceAgentSessionPointer } from "@eyeball/toolkits";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import type {
  ClaimedVoiceSessionObserver,
  VoiceObserverLeaseMutation,
  VoiceObserverStatus,
  VoiceSessionObserverRecord,
  VoiceSessionObserverStore,
} from "../../voice/observer-store.js";
import type { EyeballPostgresDatabase } from "./database.js";
import {
  voiceAgentSessionObservers,
  voiceAgentSessionPointers,
} from "./schema.js";

function iso(value: string): string {
  return new Date(value).toISOString();
}

function positiveLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Voice observer limit must be positive.");
  }
}

function observerFromRow(
  row: typeof voiceAgentSessionObservers.$inferSelect,
): VoiceSessionObserverRecord {
  return structuredClone({
    sessionId: row.sessionId,
    handledSequence: row.handledSequence,
    status: row.status,
    ...(row.terminalSequence === null
      ? {}
      : { terminalSequence: row.terminalSequence }),
    ...(row.terminalHandledAt === null
      ? {}
      : { terminalHandledAt: iso(row.terminalHandledAt) }),
    transcriptStatus: row.transcriptStatus,
    ...(row.transcriptHandledAt === null
      ? {}
      : { transcriptHandledAt: iso(row.transcriptHandledAt) }),
    consecutiveFailures: row.consecutiveFailures,
    ...(row.lastFailureKind === null
      ? {}
      : { lastFailureKind: row.lastFailureKind }),
    ...(row.lastFailureOperation === null
      ? {}
      : { lastFailureOperation: row.lastFailureOperation }),
    ...(row.lastFailureAt === null
      ? {}
      : { lastFailureAt: iso(row.lastFailureAt) }),
    ...(row.nextAttemptAt === null
      ? {}
      : { nextAttemptAt: iso(row.nextAttemptAt) }),
    ...(row.exhaustedAt === null ? {} : { exhaustedAt: iso(row.exhaustedAt) }),
    ...(row.exhaustionSignaledAt === null
      ? {}
      : { exhaustionSignaledAt: iso(row.exhaustionSignaledAt) }),
    ...(row.leaseOwner === null ? {} : { leaseOwner: row.leaseOwner }),
    ...(row.leaseToken === null ? {} : { leaseToken: row.leaseToken }),
    ...(row.leaseExpiresAt === null
      ? {}
      : { leaseExpiresAt: iso(row.leaseExpiresAt) }),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function pointerFromRow(
  row: typeof voiceAgentSessionPointers.$inferSelect,
): VoiceAgentSessionPointer {
  return {
    sessionId: row.sessionId,
    projectId: row.projectId,
    userId: row.userId,
    agentId: row.agentId,
    agentRevision: row.agentRevision,
    callId: row.callId,
    createdAt: iso(row.createdAt),
    ...(row.grantId === null ? {} : { grantId: row.grantId }),
    ...(row.grantExpiresAt === null
      ? {}
      : { grantExpiresAt: iso(row.grantExpiresAt) }),
    ...(row.grantRevokedAt === null
      ? {}
      : { grantRevokedAt: iso(row.grantRevokedAt) }),
  };
}

function leaseWhere(input: VoiceObserverLeaseMutation) {
  return and(
    eq(voiceAgentSessionObservers.sessionId, input.sessionId),
    eq(voiceAgentSessionObservers.leaseOwner, input.leaseOwner),
    eq(voiceAgentSessionObservers.leaseToken, input.leaseToken),
    gt(voiceAgentSessionObservers.leaseExpiresAt, input.now),
  );
}

export class PostgresVoiceSessionObserverStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements VoiceSessionObserverStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;

  constructor(database: EyeballPostgresDatabase<TQueryResult>) {
    this.#database = database;
  }

  async ensurePrepared(
    pointer: VoiceAgentSessionPointer,
    now: string,
    nextAttemptAt?: string,
  ): Promise<VoiceSessionObserverRecord> {
    const [inserted] = await this.#database
      .insert(voiceAgentSessionObservers)
      .values({
        sessionId: pointer.sessionId,
        status: "prepared",
        transcriptStatus: "pending",
        ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted !== undefined) return observerFromRow(inserted);
    const existing = await this.get(pointer.sessionId);
    if (existing === undefined) {
      throw new Error("Voice observer disappeared during idempotent prepare.");
    }
    return existing;
  }

  async activatePrepared(sessionId: string, now: string): Promise<boolean> {
    const rows = await this.#database
      .update(voiceAgentSessionObservers)
      .set({ status: "observing", nextAttemptAt: now, updatedAt: now })
      .where(
        and(
          eq(voiceAgentSessionObservers.sessionId, sessionId),
          inArray(voiceAgentSessionObservers.status, ["prepared", "observing"]),
        ),
      )
      .returning({ sessionId: voiceAgentSessionObservers.sessionId });
    return rows.length === 1;
  }

  async cancelPrepared(sessionId: string, now: string): Promise<boolean> {
    const rows = await this.#database
      .update(voiceAgentSessionObservers)
      .set({
        status: "cancelled",
        consecutiveFailures: 0,
        lastFailureKind: null,
        lastFailureOperation: null,
        lastFailureAt: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(voiceAgentSessionObservers.sessionId, sessionId),
          eq(voiceAgentSessionObservers.status, "prepared"),
        ),
      )
      .returning({ sessionId: voiceAgentSessionObservers.sessionId });
    return rows.length === 1;
  }

  async backfillMissing(input: {
    now: string;
    limit: number;
  }): Promise<number> {
    positiveLimit(input.limit);
    const pointers = await this.#database
      .select({ pointer: voiceAgentSessionPointers })
      .from(voiceAgentSessionPointers)
      .leftJoin(
        voiceAgentSessionObservers,
        eq(
          voiceAgentSessionObservers.sessionId,
          voiceAgentSessionPointers.sessionId,
        ),
      )
      .where(isNull(voiceAgentSessionObservers.sessionId))
      .orderBy(asc(voiceAgentSessionPointers.createdAt))
      .limit(input.limit);
    if (pointers.length === 0) return 0;
    const inserted = await this.#database
      .insert(voiceAgentSessionObservers)
      .values(
        pointers.map(({ pointer }) => ({
          sessionId: pointer.sessionId,
          status: "prepared" as const,
          transcriptStatus: "pending" as const,
          createdAt: input.now,
          updatedAt: input.now,
        })),
      )
      .onConflictDoNothing()
      .returning({ sessionId: voiceAgentSessionObservers.sessionId });
    return inserted.length;
  }

  async get(
    sessionId: string,
  ): Promise<VoiceSessionObserverRecord | undefined> {
    const [row] = await this.#database
      .select()
      .from(voiceAgentSessionObservers)
      .where(eq(voiceAgentSessionObservers.sessionId, sessionId))
      .limit(1);
    return row === undefined ? undefined : observerFromRow(row);
  }

  async claim(input: {
    leaseOwner: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<readonly ClaimedVoiceSessionObserver[]> {
    positiveLimit(input.limit);
    if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
      throw new RangeError(
        "Voice observer lease expiry must follow claim time.",
      );
    }
    return this.#database.transaction(async (transaction) => {
      const selected = await transaction
        .select({ sessionId: voiceAgentSessionObservers.sessionId })
        .from(voiceAgentSessionObservers)
        .where(
          and(
            or(
              inArray(voiceAgentSessionObservers.status, [
                "prepared",
                "observing",
                "finalizing",
              ]),
              and(
                eq(voiceAgentSessionObservers.status, "exhausted"),
                isNull(voiceAgentSessionObservers.exhaustionSignaledAt),
              ),
            ),
            or(
              isNull(voiceAgentSessionObservers.nextAttemptAt),
              lte(voiceAgentSessionObservers.nextAttemptAt, input.now),
            ),
            or(
              isNull(voiceAgentSessionObservers.leaseExpiresAt),
              lte(voiceAgentSessionObservers.leaseExpiresAt, input.now),
            ),
          ),
        )
        .orderBy(
          asc(voiceAgentSessionObservers.nextAttemptAt),
          asc(voiceAgentSessionObservers.createdAt),
          asc(voiceAgentSessionObservers.sessionId),
        )
        .limit(input.limit)
        .for("update", { skipLocked: true });
      const claimed: ClaimedVoiceSessionObserver[] = [];
      for (const candidate of selected) {
        const leaseToken = randomUUID();
        const [observer] = await transaction
          .update(voiceAgentSessionObservers)
          .set({
            leaseOwner: input.leaseOwner,
            leaseToken,
            leaseExpiresAt: input.leaseExpiresAt,
            updatedAt: input.now,
          })
          .where(eq(voiceAgentSessionObservers.sessionId, candidate.sessionId))
          .returning();
        const [pointer] = await transaction
          .select()
          .from(voiceAgentSessionPointers)
          .where(eq(voiceAgentSessionPointers.sessionId, candidate.sessionId))
          .limit(1);
        if (observer === undefined || pointer === undefined) continue;
        claimed.push({
          ...observerFromRow(observer),
          pointer: pointerFromRow(pointer),
        } as ClaimedVoiceSessionObserver);
      }
      return claimed;
    });
  }

  async renew(
    input: VoiceObserverLeaseMutation & { leaseExpiresAt: string },
  ): Promise<boolean> {
    if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) return false;
    const rows = await this.#database
      .update(voiceAgentSessionObservers)
      .set({
        leaseExpiresAt: sql`greatest(${voiceAgentSessionObservers.leaseExpiresAt}, ${input.leaseExpiresAt})`,
        updatedAt: input.now,
      })
      .where(leaseWhere(input))
      .returning({ sessionId: voiceAgentSessionObservers.sessionId });
    return rows.length === 1;
  }

  async release(input: VoiceObserverLeaseMutation): Promise<boolean> {
    return this.#update(input, {
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: input.now,
    });
  }

  async cancelClaim(input: VoiceObserverLeaseMutation): Promise<boolean> {
    return this.#update(
      input,
      {
        status: "cancelled",
        consecutiveFailures: 0,
        lastFailureKind: null,
        lastFailureOperation: null,
        lastFailureAt: null,
        nextAttemptAt: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      },
      ["prepared"],
    );
  }

  async activateClaim(input: VoiceObserverLeaseMutation): Promise<boolean> {
    return this.#update(
      input,
      {
        status: "observing",
        consecutiveFailures: 0,
        lastFailureKind: null,
        lastFailureOperation: null,
        lastFailureAt: null,
        nextAttemptAt: input.now,
        updatedAt: input.now,
      },
      ["prepared"],
    );
  }

  async advanceSequence(
    input: VoiceObserverLeaseMutation & {
      expectedSequence: number;
      handledSequence: number;
    },
  ): Promise<boolean> {
    if (input.handledSequence !== input.expectedSequence + 1) return false;
    const rows = await this.#database
      .update(voiceAgentSessionObservers)
      .set({ handledSequence: input.handledSequence, updatedAt: input.now })
      .where(
        and(
          leaseWhere(input),
          eq(voiceAgentSessionObservers.status, "observing"),
          eq(
            voiceAgentSessionObservers.handledSequence,
            input.expectedSequence,
          ),
        ),
      )
      .returning({ sessionId: voiceAgentSessionObservers.sessionId });
    return rows.length === 1;
  }

  async markTerminalHandled(
    input: VoiceObserverLeaseMutation & {
      terminalSequence: number;
      handledAt: string;
    },
  ): Promise<boolean> {
    const rows = await this.#database
      .update(voiceAgentSessionObservers)
      .set({
        terminalSequence: input.terminalSequence,
        terminalHandledAt: input.handledAt,
        updatedAt: input.now,
      })
      .where(
        and(
          leaseWhere(input),
          eq(voiceAgentSessionObservers.status, "observing"),
          sql`${input.terminalSequence} = ${voiceAgentSessionObservers.handledSequence} + 1`,
        ),
      )
      .returning({ sessionId: voiceAgentSessionObservers.sessionId });
    return rows.length === 1;
  }

  async enterFinalizing(
    input: VoiceObserverLeaseMutation & { terminalSequence: number },
  ): Promise<boolean> {
    const rows = await this.#database
      .update(voiceAgentSessionObservers)
      .set({
        status: "finalizing",
        terminalSequence: input.terminalSequence,
        consecutiveFailures: 0,
        lastFailureKind: null,
        lastFailureOperation: null,
        lastFailureAt: null,
        nextAttemptAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          leaseWhere(input),
          eq(voiceAgentSessionObservers.status, "observing"),
          eq(
            voiceAgentSessionObservers.terminalSequence,
            input.terminalSequence,
          ),
          isNotNull(voiceAgentSessionObservers.terminalHandledAt),
          gte(
            voiceAgentSessionObservers.handledSequence,
            input.terminalSequence,
          ),
        ),
      )
      .returning({ sessionId: voiceAgentSessionObservers.sessionId });
    return rows.length === 1;
  }

  async markTranscriptHandled(
    input: VoiceObserverLeaseMutation & {
      status: "admitted" | "skipped";
      handledAt: string;
    },
  ): Promise<boolean> {
    return this.#update(
      input,
      {
        transcriptStatus: input.status,
        transcriptHandledAt: input.handledAt,
        updatedAt: input.now,
      },
      ["finalizing"],
    );
  }

  async schedulePoll(
    input: VoiceObserverLeaseMutation & { nextAttemptAt: string },
  ): Promise<boolean> {
    return this.#update(
      input,
      {
        status: "observing",
        consecutiveFailures: 0,
        lastFailureKind: null,
        lastFailureOperation: null,
        lastFailureAt: null,
        nextAttemptAt: input.nextAttemptAt,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      },
      ["observing"],
    );
  }

  async recordFailure(
    input: VoiceObserverLeaseMutation & {
      kind: NonNullable<VoiceSessionObserverRecord["lastFailureKind"]>;
      operation: NonNullable<
        VoiceSessionObserverRecord["lastFailureOperation"]
      >;
      failedAt: string;
      nextAttemptAt: string;
    },
  ): Promise<VoiceSessionObserverRecord | undefined> {
    const [row] = await this.#database
      .update(voiceAgentSessionObservers)
      .set({
        consecutiveFailures: sql`${voiceAgentSessionObservers.consecutiveFailures} + 1`,
        lastFailureKind: input.kind,
        lastFailureOperation: input.operation,
        lastFailureAt: input.failedAt,
        nextAttemptAt: input.nextAttemptAt,
        updatedAt: input.now,
      })
      .where(
        and(
          leaseWhere(input),
          inArray(voiceAgentSessionObservers.status, [
            "prepared",
            "observing",
            "finalizing",
          ]),
        ),
      )
      .returning();
    return row === undefined ? undefined : observerFromRow(row);
  }

  async exhaust(
    input: VoiceObserverLeaseMutation & {
      kind: NonNullable<VoiceSessionObserverRecord["lastFailureKind"]>;
      operation: NonNullable<
        VoiceSessionObserverRecord["lastFailureOperation"]
      >;
      attempts: number;
      exhaustedAt: string;
    },
  ): Promise<boolean> {
    return this.#update(
      input,
      {
        status: "exhausted",
        consecutiveFailures: input.attempts,
        lastFailureKind: input.kind,
        lastFailureOperation: input.operation,
        lastFailureAt: input.exhaustedAt,
        nextAttemptAt: null,
        exhaustedAt: input.exhaustedAt,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      },
      ["prepared", "observing", "finalizing"],
    );
  }

  async markExhaustionSignaled(
    input: VoiceObserverLeaseMutation & { signaledAt: string },
  ): Promise<boolean> {
    return this.#update(
      input,
      {
        exhaustionSignaledAt: input.signaledAt,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      },
      ["exhausted"],
      { requireUnsignaled: true },
    );
  }

  async complete(
    input: VoiceObserverLeaseMutation & { completedAt: string },
  ): Promise<boolean> {
    return this.#update(
      input,
      {
        status: "completed",
        consecutiveFailures: 0,
        lastFailureKind: null,
        lastFailureOperation: null,
        lastFailureAt: null,
        nextAttemptAt: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: input.completedAt,
      },
      ["finalizing"],
      { requireTranscriptHandled: true },
    );
  }

  async #update(
    input: VoiceObserverLeaseMutation,
    values: Partial<typeof voiceAgentSessionObservers.$inferInsert>,
    statuses?: readonly VoiceObserverStatus[],
    options: {
      readonly requireTranscriptHandled?: boolean;
      readonly requireUnsignaled?: boolean;
    } = {},
  ): Promise<boolean> {
    const rows = await this.#database
      .update(voiceAgentSessionObservers)
      .set(values)
      .where(
        and(
          leaseWhere(input),
          statuses === undefined
            ? undefined
            : inArray(voiceAgentSessionObservers.status, [...statuses]),
          options.requireTranscriptHandled === true
            ? inArray(voiceAgentSessionObservers.transcriptStatus, [
                "admitted",
                "skipped",
              ])
            : undefined,
          options.requireUnsignaled === true
            ? isNull(voiceAgentSessionObservers.exhaustionSignaledAt)
            : undefined,
        ),
      )
      .returning({ sessionId: voiceAgentSessionObservers.sessionId });
    return rows.length === 1;
  }
}
