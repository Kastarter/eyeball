import type { VoiceAgentSessionPointer } from "@eyeball/toolkits";

export type VoiceObserverStatus =
  | "prepared"
  | "observing"
  | "finalizing"
  | "completed"
  | "exhausted"
  | "cancelled";

export type VoiceObserverTranscriptStatus = "pending" | "admitted" | "skipped";

export type VoiceObserverFailureKind =
  | "provider_unavailable"
  | "timeout"
  | "invalid_response"
  | "publication_error"
  | "internal_error";

export type VoiceObserverOperation =
  | "get_events"
  | "get_session"
  | "publish_event"
  | "publish_transcript"
  | "publish_failure";

export interface VoiceSessionObserverRecord {
  readonly sessionId: string;
  readonly handledSequence: number;
  readonly status: VoiceObserverStatus;
  readonly terminalSequence?: number;
  readonly terminalHandledAt?: string;
  readonly transcriptStatus: VoiceObserverTranscriptStatus;
  readonly transcriptHandledAt?: string;
  readonly consecutiveFailures: number;
  readonly lastFailureKind?: VoiceObserverFailureKind;
  readonly lastFailureOperation?: VoiceObserverOperation;
  readonly lastFailureAt?: string;
  readonly nextAttemptAt?: string;
  readonly exhaustedAt?: string;
  readonly exhaustionSignaledAt?: string;
  readonly leaseOwner?: string;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClaimedVoiceSessionObserver
  extends VoiceSessionObserverRecord {
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly pointer: VoiceAgentSessionPointer;
}

export interface VoiceObserverLeaseMutation {
  readonly sessionId: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly now: string;
}

/** Atomic, lease-fenced state machine for restart-safe remote observation. */
export interface VoiceSessionObserverStore {
  ensurePrepared(
    pointer: VoiceAgentSessionPointer,
    now: string,
    nextAttemptAt?: string,
  ): Promise<VoiceSessionObserverRecord>;
  activatePrepared(sessionId: string, now: string): Promise<boolean>;
  cancelPrepared(sessionId: string, now: string): Promise<boolean>;
  backfillMissing(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<number>;
  get(sessionId: string): Promise<VoiceSessionObserverRecord | undefined>;
  claim(input: {
    readonly leaseOwner: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
    readonly limit: number;
  }): Promise<readonly ClaimedVoiceSessionObserver[]>;
  renew(
    input: VoiceObserverLeaseMutation & { readonly leaseExpiresAt: string },
  ): Promise<boolean>;
  release(input: VoiceObserverLeaseMutation): Promise<boolean>;
  cancelClaim(input: VoiceObserverLeaseMutation): Promise<boolean>;
  activateClaim(input: VoiceObserverLeaseMutation): Promise<boolean>;
  advanceSequence(
    input: VoiceObserverLeaseMutation & {
      readonly expectedSequence: number;
      readonly handledSequence: number;
    },
  ): Promise<boolean>;
  markTerminalHandled(
    input: VoiceObserverLeaseMutation & {
      readonly terminalSequence: number;
      readonly handledAt: string;
    },
  ): Promise<boolean>;
  enterFinalizing(
    input: VoiceObserverLeaseMutation & { readonly terminalSequence: number },
  ): Promise<boolean>;
  markTranscriptHandled(
    input: VoiceObserverLeaseMutation & {
      readonly status: "admitted" | "skipped";
      readonly handledAt: string;
    },
  ): Promise<boolean>;
  schedulePoll(
    input: VoiceObserverLeaseMutation & { readonly nextAttemptAt: string },
  ): Promise<boolean>;
  recordFailure(
    input: VoiceObserverLeaseMutation & {
      readonly kind: VoiceObserverFailureKind;
      readonly operation: VoiceObserverOperation;
      readonly failedAt: string;
      readonly nextAttemptAt: string;
    },
  ): Promise<VoiceSessionObserverRecord | undefined>;
  exhaust(
    input: VoiceObserverLeaseMutation & {
      readonly kind: VoiceObserverFailureKind;
      readonly operation: VoiceObserverOperation;
      readonly attempts: number;
      readonly exhaustedAt: string;
    },
  ): Promise<boolean>;
  markExhaustionSignaled(
    input: VoiceObserverLeaseMutation & { readonly signaledAt: string },
  ): Promise<boolean>;
  complete(
    input: VoiceObserverLeaseMutation & { readonly completedAt: string },
  ): Promise<boolean>;
}
