import type { ExecutionId, ExecutionRecord } from "@eyeball/core";

export interface UsageReservationContext {
  readonly projectId: string;
  readonly executionId: ExecutionId;
  readonly cloudExecutionId?: ExecutionId;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface UsageReportContext {
  readonly projectId: string;
  readonly executionId: ExecutionId;
  readonly cloudExecutionId?: ExecutionId;
  readonly idempotencyKey: string;
  readonly reservationId?: string;
  /** Reservation creation time keeps terminal reports in the reserved UTC month. */
  readonly reservedAt?: string;
}

export interface UsageReservationHandle {
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly cloudExecutionId?: ExecutionId;
}

export type UsageAdmission =
  | {
      readonly allowed: true;
      readonly report?: UsageReportContext;
      readonly reservationId?: string;
    }
  | {
      readonly allowed: false;
      readonly message: string;
    };

export interface TerminalUsageReport {
  readonly context: UsageReportContext;
  readonly record: ExecutionRecord & { status: "succeeded" | "failed" };
}

export interface UsageGate {
  readonly enabled: boolean;
  reserve(context: UsageReservationContext): Promise<UsageAdmission>;
  /** Starts an asynchronous, tracked enqueue into the terminal usage outbox. */
  reportTerminal(report: TerminalUsageReport): void;
  /** Best-effort release for an admitted execution abandoned before allocation. */
  release(reservationId: string): Promise<void>;
  /** Waits only for local enqueue/release work, never for scheduled report retries. */
  onIdle(): Promise<void>;
}

const NOOP_ADMISSION: UsageAdmission = Object.freeze({ allowed: true });

/** Default self-hosted behavior: no remote calls, outbox writes, or metrics. */
export class NoopUsageGate implements UsageGate {
  readonly enabled = false;

  async reserve(_context: UsageReservationContext): Promise<UsageAdmission> {
    return NOOP_ADMISSION;
  }

  reportTerminal(_report: TerminalUsageReport): void {}

  async release(_reservationId: string): Promise<void> {}

  async onIdle(): Promise<void> {}
}

export class UsageGateUnavailableError extends Error {
  constructor() {
    super("Cloud usage admission is temporarily unavailable.");
    this.name = "UsageGateUnavailableError";
  }
}
