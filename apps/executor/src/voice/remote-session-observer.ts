import { randomUUID } from "node:crypto";
import {
  type Clock,
  type ExecutorLogger,
  noopLogger,
  systemClock,
  type VoiceAgentDefinition,
  type VoiceAgentSession,
  type VoiceAgentSessionEvent,
} from "@eyeball/core";
import {
  type AgentStore,
  type VoiceAgentSessionPointer,
  type VoiceSessionDriver,
  VoiceSessionDriverError,
  type VoiceSessionObservationLifecycle,
  voiceTranscriptFromEvents,
} from "@eyeball/toolkits";
import type { WebhookDeliverer } from "../webhooks/deliverer.js";
import type {
  ClaimedVoiceSessionObserver,
  VoiceObserverFailureKind,
  VoiceObserverLeaseMutation,
  VoiceObserverOperation,
  VoiceSessionObserverRecord,
  VoiceSessionObserverStore,
} from "./observer-store.js";

const TERMINAL_STATES = new Set(["completed", "failed", "abandoned"]);

export interface RemoteVoiceSessionObserverOptions {
  readonly store: VoiceSessionObserverStore;
  readonly agentStore: AgentStore;
  readonly driver: VoiceSessionDriver;
  readonly webhookDeliverer: WebhookDeliverer;
  readonly logger?: ExecutorLogger;
  readonly clock?: Clock;
  readonly leaseOwner?: string;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaximumDelayMs?: number;
  readonly retryLimit?: number;
  readonly claimBatchSize?: number;
  readonly eventPageSize?: number;
  /** Prevents recovery claims while the bounded start request is still in flight. */
  readonly startGracePeriodMs?: number;
  /** Tests can disable timers and drive `runOnce()` explicitly. */
  readonly automaticScheduling?: boolean;
}

interface ClassifiedFailure {
  readonly kind: VoiceObserverFailureKind;
  readonly operation: VoiceObserverOperation;
  readonly retryable: boolean;
}

class ObserverPublicationError extends Error {
  readonly operation: VoiceObserverOperation;

  constructor(operation: VoiceObserverOperation, cause: unknown) {
    super("A durable observer effect could not be recorded.", { cause });
    this.name = "ObserverPublicationError";
    this.operation = operation;
  }
}

class ObserverLeaseLostError extends Error {
  constructor() {
    super("Voice observer lease ownership changed.");
    this.name = "ObserverLeaseLostError";
  }
}

function isTerminal(session: VoiceAgentSession): boolean {
  return TERMINAL_STATES.has(session.state);
}

function terminalEvent(event: VoiceAgentSessionEvent): boolean {
  return (
    event.data.type === "session.lifecycle" &&
    TERMINAL_STATES.has(event.data.to)
  );
}

function workerNotFound(error: unknown): boolean {
  return error instanceof VoiceSessionDriverError && error.status === 404;
}

function assertPinnedScope(
  session: VoiceAgentSession,
  pointer: VoiceAgentSessionPointer,
): void {
  if (
    session.id !== pointer.sessionId ||
    session.projectId !== pointer.projectId ||
    session.userId !== pointer.userId ||
    session.agentId !== pointer.agentId ||
    session.agentRevision !== pointer.agentRevision
  ) {
    throw new VoiceSessionDriverError({
      message: "The voice worker returned a session outside the pinned scope.",
      kind: "invalid_response",
      operation: "get_session",
      retryable: false,
      sessionId: pointer.sessionId,
    });
  }
}

function classifiedFailure(error: unknown): ClassifiedFailure {
  if (error instanceof ObserverPublicationError) {
    return {
      kind: "publication_error",
      operation: error.operation,
      retryable: true,
    };
  }
  if (error instanceof VoiceSessionDriverError) {
    return {
      kind: error.kind,
      operation:
        error.operation === "get_events" ? "get_events" : "get_session",
      retryable: error.retryable && error.kind !== "invalid_response",
    };
  }
  return {
    kind: "internal_error",
    operation: "get_session",
    retryable: false,
  };
}

function failureError(kind: VoiceObserverFailureKind) {
  switch (kind) {
    case "provider_unavailable":
      return {
        code: "provider_unavailable" as const,
        message: "The remote voice worker is unavailable.",
        retryable: true,
      };
    case "timeout":
      return {
        code: "timeout" as const,
        message: "The remote voice-worker request timed out.",
        retryable: true,
      };
    case "invalid_response":
      return {
        code: "provider_error" as const,
        message: "The remote voice worker returned an invalid response.",
        retryable: false,
      };
    case "publication_error":
    case "internal_error":
      return {
        code: "provider_error" as const,
        message:
          "The remote voice observer could not complete durable publication.",
        retryable: false,
      };
  }
}

/**
 * Executor-owned coordinator for durable remote voice observation. Worker state
 * remains authoritative; this component only acknowledges completed executor
 * effects and can therefore restart safely from `handledSequence`.
 */
export class RemoteVoiceSessionObserver
  implements VoiceSessionObservationLifecycle
{
  readonly store: VoiceSessionObserverStore;
  readonly #agentStore: AgentStore;
  readonly #driver: VoiceSessionDriver;
  readonly #webhookDeliverer: WebhookDeliverer;
  readonly #logger: ExecutorLogger;
  readonly #clock: Clock;
  readonly #leaseOwner: string;
  readonly #leaseDurationMs: number;
  readonly #pollIntervalMs: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaximumDelayMs: number;
  readonly #retryLimit: number;
  readonly #claimBatchSize: number;
  readonly #eventPageSize: number;
  readonly #startGracePeriodMs: number;
  readonly #automaticScheduling: boolean;
  readonly #tasks = new Map<string, Promise<void>>();
  readonly #controllers = new Map<string, AbortController>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerDueAt: number | undefined;
  #runPromise: Promise<number> | undefined;
  #closed = false;

  constructor(options: RemoteVoiceSessionObserverOptions) {
    this.store = options.store;
    this.#agentStore = options.agentStore;
    this.#driver = options.driver;
    this.#webhookDeliverer = options.webhookDeliverer;
    this.#logger = options.logger ?? noopLogger;
    this.#clock = options.clock ?? systemClock;
    this.#leaseOwner = options.leaseOwner ?? `voice-observer-${randomUUID()}`;
    this.#leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.#retryMaximumDelayMs = options.retryMaximumDelayMs ?? 30_000;
    this.#retryLimit = options.retryLimit ?? 20;
    this.#claimBatchSize = options.claimBatchSize ?? 25;
    this.#eventPageSize = options.eventPageSize ?? 200;
    this.#startGracePeriodMs =
      options.startGracePeriodMs ?? this.#leaseDurationMs;
    this.#automaticScheduling = options.automaticScheduling ?? true;
    for (const [name, value] of Object.entries({
      leaseDurationMs: this.#leaseDurationMs,
      pollIntervalMs: this.#pollIntervalMs,
      retryBaseDelayMs: this.#retryBaseDelayMs,
      retryMaximumDelayMs: this.#retryMaximumDelayMs,
      retryLimit: this.#retryLimit,
      claimBatchSize: this.#claimBatchSize,
      eventPageSize: this.#eventPageSize,
      startGracePeriodMs: this.#startGracePeriodMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer.`);
      }
    }
  }

  async prepare(pointer: VoiceAgentSessionPointer): Promise<void> {
    const now = this.#now();
    await this.store.ensurePrepared(
      pointer,
      now,
      new Date(Date.parse(now) + this.#startGracePeriodMs).toISOString(),
    );
  }

  async activate(pointer: VoiceAgentSessionPointer): Promise<void> {
    const now = this.#now();
    await this.store.ensurePrepared(pointer, now);
    if (!(await this.store.activatePrepared(pointer.sessionId, now))) {
      throw new Error("Prepared voice observer could not be activated.");
    }
    await this.runOnce();
    this.#arm(0);
  }

  async handleStartFailure(input: {
    pointer: VoiceAgentSessionPointer;
    error: unknown;
  }): Promise<VoiceAgentSession | undefined> {
    try {
      const session = await this.#driver.getSession(input.pointer.sessionId);
      assertPinnedScope(session, input.pointer);
      return session;
    } catch (reconciliationError) {
      if (workerNotFound(reconciliationError)) {
        const now = this.#now();
        await this.store.cancelPrepared(input.pointer.sessionId, now);
        await this.#agentStore.revokeSessionGrant({
          projectId: input.pointer.projectId,
          userId: input.pointer.userId,
          sessionId: input.pointer.sessionId,
          ...(input.pointer.grantId === undefined
            ? {}
            : { grantId: input.pointer.grantId }),
          revokedAt: now,
        });
      } else {
        this.#arm(this.#retryBaseDelayMs);
      }
      return undefined;
    }
  }

  /** Backfills pre-M4.2 pointers, then performs one bounded due-work pass. */
  async reconcileAtBoot(): Promise<void> {
    let backfilled = 0;
    for (let page = 0; page < 100; page += 1) {
      const count = await this.store.backfillMissing({
        now: this.#now(),
        limit: this.#claimBatchSize,
      });
      backfilled += count;
      if (count < this.#claimBatchSize) break;
    }
    const claimed = await this.runOnce();
    this.#logger.info("voice.observer_reconciled", { backfilled, claimed });
    this.#arm(this.#pollIntervalMs);
  }

  /** Claims and drains one bounded page of eligible observer records. */
  async runOnce(): Promise<number> {
    if (this.#closed) return 0;
    if (this.#runPromise !== undefined) return this.#runPromise;
    const running = this.#runOnce();
    this.#runPromise = running;
    try {
      return await running;
    } finally {
      if (this.#runPromise === running) this.#runPromise = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerDueAt = undefined;
    for (const controller of this.#controllers.values()) {
      controller.abort(new Error("Voice observer is shutting down."));
    }
    await Promise.allSettled([...this.#tasks.values()]);
  }

  async #runOnce(): Promise<number> {
    const now = this.#now();
    const claims = await this.store.claim({
      leaseOwner: this.#leaseOwner,
      now,
      leaseExpiresAt: new Date(
        Date.parse(now) + this.#leaseDurationMs,
      ).toISOString(),
      limit: this.#claimBatchSize,
    });
    for (const claim of claims) this.#startTask(claim);
    await Promise.allSettled(
      claims.map((claim) => this.#tasks.get(claim.sessionId)),
    );
    this.#arm(
      claims.length === this.#claimBatchSize ? 0 : this.#pollIntervalMs,
    );
    return claims.length;
  }

  #startTask(claim: ClaimedVoiceSessionObserver): void {
    if (this.#tasks.has(claim.sessionId)) return;
    const controller = new AbortController();
    this.#controllers.set(claim.sessionId, controller);
    const task = this.#processClaim(claim, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        this.#tasks.delete(claim.sessionId);
        this.#controllers.delete(claim.sessionId);
      });
    this.#tasks.set(claim.sessionId, task);
  }

  async #processClaim(
    claim: ClaimedVoiceSessionObserver,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (claim.status === "exhausted") {
        await this.#signalExhaustion(claim);
        return;
      }
      if (claim.status === "prepared") {
        try {
          const session = await this.#driver.getSession(claim.sessionId, {
            signal,
          });
          assertPinnedScope(session, claim.pointer);
        } catch (error) {
          if (workerNotFound(error)) {
            await this.#publication("publish_event", () =>
              this.#cancelClaim(claim),
            );
            return;
          }
          throw error;
        }
        await this.#publication("publish_event", () =>
          this.#mustMutate(this.store.activateClaim(this.#mutation(claim))),
        );
        claim = { ...claim, status: "observing", consecutiveFailures: 0 };
      }
      if (claim.status === "observing") {
        await this.#observe(claim, signal);
      } else if (claim.status === "finalizing") {
        await this.#finalize(claim, signal);
      }
    } catch (error) {
      if (signal.aborted || this.#closed) {
        await this.store.release(this.#mutation(claim)).catch(() => false);
        return;
      }
      if (error instanceof ObserverLeaseLostError) return;
      await this.#handleFailure(claim, error);
    }
  }

  async #observe(
    claim: ClaimedVoiceSessionObserver,
    signal: AbortSignal,
  ): Promise<void> {
    const agent = await this.#publication("publish_event", () =>
      this.#loadAgent(claim.pointer),
    );
    let session = await this.#driver.getSession(claim.sessionId, { signal });
    assertPinnedScope(session, claim.pointer);
    let handledSequence = claim.handledSequence;
    let terminalSequence = claim.terminalSequence;
    let terminalHandledAt = claim.terminalHandledAt;
    let terminalDrainAttemptedAt: number | undefined;

    for (;;) {
      for (;;) {
        await this.#renew(claim, "publish_event");
        const page = await this.#driver.getEvents(claim.sessionId, {
          afterSequence: handledSequence,
          limit: this.#eventPageSize,
          signal,
        });
        for (const event of page.events) {
          if (terminalEvent(event) && terminalHandledAt === undefined) {
            const handledAt = this.#now();
            await this.#publication("publish_event", async () => {
              await this.#agentStore.revokeSessionGrant({
                projectId: claim.pointer.projectId,
                userId: claim.pointer.userId,
                sessionId: claim.pointer.sessionId,
                ...(claim.pointer.grantId === undefined
                  ? {}
                  : { grantId: claim.pointer.grantId }),
                revokedAt: handledAt,
              });
              await this.#mustMutate(
                this.store.markTerminalHandled({
                  ...this.#mutation(claim),
                  terminalSequence: event.sequence,
                  handledAt,
                }),
              );
            });
            terminalSequence = event.sequence;
            terminalHandledAt = handledAt;
          }
          if (agent.webhooks.events.includes(event.data.type)) {
            await this.#publication("publish_event", () =>
              this.#webhookDeliverer.enqueueVoiceSessionEvent({
                projectId: claim.pointer.projectId,
                endpointIds: agent.webhooks.endpointIds,
                event,
              }),
            );
          }
          await this.#publication("publish_event", () =>
            this.#mustMutate(
              this.store.advanceSequence({
                ...this.#mutation(claim),
                expectedSequence: handledSequence,
                handledSequence: event.sequence,
              }),
            ),
          );
          handledSequence = event.sequence;
        }
        if (!page.hasMore) break;
        if (page.nextSequence !== handledSequence) {
          throw new VoiceSessionDriverError({
            message: "The voice worker returned an inconsistent event cursor.",
            kind: "invalid_response",
            operation: "get_events",
            retryable: false,
            sessionId: claim.sessionId,
            afterSequence: handledSequence,
          });
        }
      }

      session = await this.#driver.getSession(claim.sessionId, { signal });
      assertPinnedScope(session, claim.pointer);
      if (isTerminal(session) && handledSequence < session.lastEventSequence) {
        if (terminalDrainAttemptedAt === handledSequence) {
          throw new VoiceSessionDriverError({
            message: "The terminal voice session event history is incomplete.",
            kind: "invalid_response",
            operation: "get_events",
            retryable: false,
            sessionId: claim.sessionId,
            afterSequence: handledSequence,
          });
        }
        terminalDrainAttemptedAt = handledSequence;
        continue;
      }
      if (
        handledSequence !== session.lastEventSequence &&
        isTerminal(session)
      ) {
        throw new VoiceSessionDriverError({
          message: "The terminal voice session event history is incomplete.",
          kind: "invalid_response",
          operation: "get_events",
          retryable: false,
          sessionId: claim.sessionId,
          afterSequence: handledSequence,
        });
      }
      break;
    }

    if (isTerminal(session)) {
      if (terminalSequence === undefined) {
        throw new VoiceSessionDriverError({
          message: "The terminal voice session omitted its lifecycle event.",
          kind: "invalid_response",
          operation: "get_events",
          retryable: false,
          sessionId: claim.sessionId,
          afterSequence: handledSequence,
        });
      }
      const finalTerminalSequence = terminalSequence;
      if (terminalHandledAt === undefined) {
        const handledAt = this.#now();
        await this.#publication("publish_event", async () => {
          await this.#agentStore.revokeSessionGrant({
            projectId: claim.pointer.projectId,
            userId: claim.pointer.userId,
            sessionId: claim.pointer.sessionId,
            ...(claim.pointer.grantId === undefined
              ? {}
              : { grantId: claim.pointer.grantId }),
            revokedAt: handledAt,
          });
          await this.#mustMutate(
            this.store.markTerminalHandled({
              ...this.#mutation(claim),
              terminalSequence: finalTerminalSequence,
              handledAt,
            }),
          );
        });
      }
      await this.#publication("publish_event", () =>
        this.#mustMutate(
          this.store.enterFinalizing({
            ...this.#mutation(claim),
            terminalSequence: finalTerminalSequence,
          }),
        ),
      );
      await this.#finalize(
        {
          ...claim,
          handledSequence,
          status: "finalizing",
          terminalSequence: finalTerminalSequence,
          terminalHandledAt: terminalHandledAt ?? this.#now(),
          consecutiveFailures: 0,
        },
        signal,
      );
      return;
    }

    const nextAttemptAt = new Date(
      Date.parse(this.#now()) + this.#pollIntervalMs,
    ).toISOString();
    await this.#publication("publish_event", () =>
      this.#mustMutate(
        this.store.schedulePoll({
          ...this.#mutation(claim),
          nextAttemptAt,
        }),
      ),
    );
    this.#arm(this.#pollIntervalMs);
  }

  async #finalize(
    claim: ClaimedVoiceSessionObserver,
    signal: AbortSignal,
  ): Promise<void> {
    const agent = await this.#publication("publish_transcript", () =>
      this.#loadAgent(claim.pointer),
    );
    const session = await this.#driver.getSession(claim.sessionId, { signal });
    assertPinnedScope(session, claim.pointer);
    if (!isTerminal(session)) {
      throw new VoiceSessionDriverError({
        message:
          "The voice worker returned a non-terminal finalization session.",
        kind: "invalid_response",
        operation: "get_session",
        retryable: false,
        sessionId: claim.sessionId,
      });
    }
    if (claim.transcriptStatus === "pending") {
      if (agent.webhooks.transcript) {
        const events = await this.#completeHistory(claim, session, signal);
        const transcript = voiceTranscriptFromEvents(agent, session, events);
        await this.#publication("publish_transcript", () =>
          this.#webhookDeliverer.enqueueVoiceTranscript({
            projectId: claim.pointer.projectId,
            endpointIds: agent.webhooks.endpointIds,
            transcript,
            createdAt: session.completedAt ?? this.#now(),
          }),
        );
        await this.#publication("publish_transcript", () =>
          this.#mustMutate(
            this.store.markTranscriptHandled({
              ...this.#mutation(claim),
              status: "admitted",
              handledAt: this.#now(),
            }),
          ),
        );
      } else {
        await this.#publication("publish_transcript", () =>
          this.#mustMutate(
            this.store.markTranscriptHandled({
              ...this.#mutation(claim),
              status: "skipped",
              handledAt: this.#now(),
            }),
          ),
        );
      }
    }
    await this.#publication("publish_transcript", () =>
      this.#mustMutate(
        this.store.complete({
          ...this.#mutation(claim),
          completedAt: this.#now(),
        }),
      ),
    );
  }

  async #completeHistory(
    claim: ClaimedVoiceSessionObserver,
    session: VoiceAgentSession,
    signal: AbortSignal,
  ): Promise<readonly VoiceAgentSessionEvent[]> {
    const events: VoiceAgentSessionEvent[] = [];
    let cursor = 0;
    for (;;) {
      await this.#renew(claim, "publish_transcript");
      const page = await this.#driver.getEvents(claim.sessionId, {
        afterSequence: cursor,
        limit: this.#eventPageSize,
        signal,
      });
      events.push(...page.events);
      cursor = page.nextSequence;
      if (!page.hasMore) break;
    }
    if (cursor !== session.lastEventSequence) {
      throw new VoiceSessionDriverError({
        message: "The voice worker returned incomplete transcript history.",
        kind: "invalid_response",
        operation: "get_events",
        retryable: false,
        sessionId: claim.sessionId,
        afterSequence: cursor,
      });
    }
    return events;
  }

  async #handleFailure(
    claim: ClaimedVoiceSessionObserver,
    error: unknown,
  ): Promise<void> {
    const failure = classifiedFailure(error);
    const failedAt = this.#now();
    const nextAttemptAt = new Date(
      Date.parse(failedAt) +
        Math.min(
          this.#retryMaximumDelayMs,
          this.#retryBaseDelayMs * 2 ** Math.min(claim.consecutiveFailures, 20),
        ),
    ).toISOString();
    let recorded: VoiceSessionObserverRecord | undefined;
    try {
      recorded = await this.store.recordFailure({
        ...this.#mutation(claim),
        kind: failure.kind,
        operation: failure.operation,
        failedAt,
        nextAttemptAt,
      });
    } catch {
      await this.store.release(this.#mutation(claim)).catch(() => false);
      this.#arm(this.#retryBaseDelayMs);
      return;
    }
    if (recorded === undefined) return;
    const exhausted =
      !failure.retryable || recorded.consecutiveFailures >= this.#retryLimit;
    if (!exhausted) {
      await this.store.release(this.#mutation(claim)).catch(() => false);
      this.#logger.warn("voice.observer_retry_scheduled", {
        projectId: claim.pointer.projectId,
        sessionId: claim.pointer.sessionId,
        attempts: recorded.consecutiveFailures,
        failureKind: failure.kind,
        operation: failure.operation,
        nextAttemptAt,
      });
      this.#arm(
        Math.max(0, Date.parse(nextAttemptAt) - Date.parse(this.#now())),
      );
      return;
    }

    let didExhaust = false;
    try {
      didExhaust = await this.store.exhaust({
        ...this.#mutation(claim),
        kind: failure.kind,
        operation: failure.operation,
        attempts: recorded.consecutiveFailures,
        exhaustedAt: failedAt,
      });
    } catch {
      await this.store.release(this.#mutation(claim)).catch(() => false);
      this.#arm(this.#retryBaseDelayMs);
      return;
    }
    if (!didExhaust) return;
    const reason = failure.retryable ? "retry_exhausted" : "non_retryable";
    this.#logger.error("voice.observer_exhausted", {
      projectId: claim.pointer.projectId,
      sessionId: claim.pointer.sessionId,
      agentId: claim.pointer.agentId,
      agentRevision: claim.pointer.agentRevision,
      handledSequence: recorded.handledSequence,
      attempts: recorded.consecutiveFailures,
      failureKind: failure.kind,
      operation: failure.operation,
      reason,
      exhaustedAt: failedAt,
    });
    this.#arm(0);
  }

  async #signalExhaustion(claim: ClaimedVoiceSessionObserver): Promise<void> {
    const kind = claim.lastFailureKind ?? "internal_error";
    const operation = claim.lastFailureOperation ?? "publish_failure";
    const reason =
      kind === "provider_unavailable" ||
      kind === "timeout" ||
      kind === "publication_error"
        ? "retry_exhausted"
        : "non_retryable";
    try {
      const agent = await this.#loadAgent(claim.pointer);
      await this.#publication("publish_failure", () =>
        this.#webhookDeliverer.enqueueVoiceObserverFailure({
          projectId: claim.pointer.projectId,
          endpointIds: agent.webhooks.endpointIds,
          createdAt: claim.exhaustedAt ?? claim.updatedAt,
          data: {
            sessionId: claim.sessionId,
            agentId: claim.pointer.agentId,
            agentRevision: claim.pointer.agentRevision,
            lastHandledSequence: claim.handledSequence,
            attempts: claim.consecutiveFailures,
            reason,
            operation,
            error: failureError(kind),
          },
        }),
      );
      await this.#mustMutate(
        this.store.markExhaustionSignaled({
          ...this.#mutation(claim),
          signaledAt: this.#now(),
        }),
      );
    } catch (error) {
      if (error instanceof ObserverLeaseLostError) return;
      await this.store.release(this.#mutation(claim)).catch(() => false);
      this.#arm(this.#retryBaseDelayMs);
    }
  }

  async #cancelClaim(claim: ClaimedVoiceSessionObserver): Promise<void> {
    const now = this.#now();
    await this.#agentStore.revokeSessionGrant({
      projectId: claim.pointer.projectId,
      userId: claim.pointer.userId,
      sessionId: claim.pointer.sessionId,
      ...(claim.pointer.grantId === undefined
        ? {}
        : { grantId: claim.pointer.grantId }),
      revokedAt: now,
    });
    await this.#mustMutate(this.store.cancelClaim(this.#mutation(claim)));
  }

  async #loadAgent(
    pointer: VoiceAgentSessionPointer,
  ): Promise<VoiceAgentDefinition> {
    return this.#agentStore.getAgent(
      pointer.projectId,
      pointer.agentId,
      pointer.agentRevision,
    );
  }

  async #renew(
    claim: ClaimedVoiceSessionObserver,
    operation: VoiceObserverOperation,
  ): Promise<void> {
    const now = this.#now();
    await this.#publication(operation, () =>
      this.#mustMutate(
        this.store.renew({
          ...this.#mutation(claim, now),
          leaseExpiresAt: new Date(
            Date.parse(now) + this.#leaseDurationMs,
          ).toISOString(),
        }),
      ),
    );
  }

  async #publication<T>(
    operation: VoiceObserverOperation,
    callback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof ObserverLeaseLostError) throw error;
      throw new ObserverPublicationError(operation, error);
    }
  }

  async #mustMutate(mutation: Promise<boolean>): Promise<void> {
    if (!(await mutation)) throw new ObserverLeaseLostError();
  }

  #mutation(
    claim: ClaimedVoiceSessionObserver,
    now = this.#now(),
  ): VoiceObserverLeaseMutation {
    return {
      sessionId: claim.sessionId,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      now,
    };
  }

  #arm(delayMs: number): void {
    if (!this.#automaticScheduling || this.#closed) return;
    const normalizedDelay = Math.max(0, delayMs);
    const dueAt = Date.now() + normalizedDelay;
    if (
      this.#timer !== undefined &&
      this.#timerDueAt !== undefined &&
      this.#timerDueAt <= dueAt
    ) {
      return;
    }
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timerDueAt = dueAt;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#timerDueAt = undefined;
      void this.runOnce();
    }, normalizedDelay);
    this.#timer.unref?.();
  }

  #now(): string {
    const now = this.#clock.now();
    if (Number.isNaN(now.valueOf()))
      throw new Error("Observer clock is invalid.");
    return new Date(now.valueOf()).toISOString();
  }
}
