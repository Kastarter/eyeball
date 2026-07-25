import type { SnapshotableState } from "./state.js";

export const DEFAULT_MOCK_TIME = "2026-01-01T00:00:00.000Z";

export interface ClockAdvanceResult {
  now: string;
  transitions: number;
}

export interface MockClock extends SnapshotableState {
  now(): Date;
  nowIso(): string;
  advance(milliseconds: number): ClockAdvanceResult;
  scheduleAt(when: string | number | Date, transition: () => void): () => void;
  scheduleIn(milliseconds: number, transition: () => void): () => void;
  reset(initialTime?: string): void;
}

type ScheduledTransition = {
  at: number;
  sequence: number;
  transition: () => void;
  cancelled: boolean;
};

type ClockSnapshot = {
  nowMs: number;
  initialMs: number;
  nextSequence: number;
  scheduled: ScheduledTransition[];
};

function parseTime(value: string | number | Date): number {
  const milliseconds =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Mock clock time must be a valid timestamp");
  }
  return milliseconds;
}

function assertDuration(milliseconds: number, allowZero = false): void {
  if (
    !Number.isFinite(milliseconds) ||
    !Number.isInteger(milliseconds) ||
    (allowZero ? milliseconds < 0 : milliseconds <= 0)
  ) {
    throw new Error(
      allowZero
        ? "Clock duration must be a non-negative integer"
        : "Clock duration must be a positive integer",
    );
  }
}

export function createMockClock(initialTime = DEFAULT_MOCK_TIME): MockClock {
  let initialMs = parseTime(initialTime);
  let nowMs = initialMs;
  let nextSequence = 0;
  let scheduled: ScheduledTransition[] = [];

  function sortTransitions(): void {
    scheduled.sort(
      (left, right) => left.at - right.at || left.sequence - right.sequence,
    );
  }

  const clock: MockClock = {
    now() {
      return new Date(nowMs);
    },
    nowIso() {
      return new Date(nowMs).toISOString();
    },
    advance(milliseconds) {
      assertDuration(milliseconds);
      const target = nowMs + milliseconds;
      let transitions = 0;

      while (true) {
        sortTransitions();
        const next = scheduled.find(
          (candidate) => !candidate.cancelled && candidate.at <= target,
        );
        if (next === undefined) {
          break;
        }
        scheduled = scheduled.filter((candidate) => candidate !== next);
        nowMs = Math.max(nowMs, next.at);
        next.transition();
        transitions += 1;
      }

      scheduled = scheduled.filter((candidate) => !candidate.cancelled);
      nowMs = target;
      return { now: clock.nowIso(), transitions };
    },
    scheduleAt(when, transition) {
      const at = parseTime(when);
      if (at < nowMs) {
        throw new Error(
          "Cannot schedule a transition before the current mock time",
        );
      }
      nextSequence += 1;
      const scheduledTransition: ScheduledTransition = {
        at,
        sequence: nextSequence,
        transition,
        cancelled: false,
      };
      scheduled.push(scheduledTransition);
      return () => {
        scheduledTransition.cancelled = true;
      };
    },
    scheduleIn(milliseconds, transition) {
      assertDuration(milliseconds, true);
      return clock.scheduleAt(nowMs + milliseconds, transition);
    },
    reset(nextInitialTime) {
      if (nextInitialTime !== undefined) {
        initialMs = parseTime(nextInitialTime);
      }
      nowMs = initialMs;
      nextSequence = 0;
      scheduled = [];
    },
    snapshot(): ClockSnapshot {
      return {
        nowMs,
        initialMs,
        nextSequence,
        scheduled: scheduled.map((transition) => ({ ...transition })),
      };
    },
    restore(snapshot) {
      const value = snapshot as ClockSnapshot;
      if (
        !Number.isFinite(value.nowMs) ||
        !Number.isFinite(value.initialMs) ||
        !Number.isSafeInteger(value.nextSequence) ||
        !Array.isArray(value.scheduled)
      ) {
        throw new Error("Invalid mock clock snapshot");
      }
      nowMs = value.nowMs;
      initialMs = value.initialMs;
      nextSequence = value.nextSequence;
      scheduled = value.scheduled.map((transition) => ({ ...transition }));
    },
  };

  return clock;
}

export function advanceClock(
  clock: MockClock,
  milliseconds: number,
): ClockAdvanceResult {
  return clock.advance(milliseconds);
}
