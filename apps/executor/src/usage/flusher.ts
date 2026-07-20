import {
  type Clock,
  type ExecutorLogger,
  systemClock,
} from "../adapters/index.js";
import type { ExecutorTelemetryRuntime } from "../telemetry/index.js";
import type { CloudUsageClient } from "./cloud.js";
import type { UsageOutboxRecord, UsageOutboxStore } from "./outbox.js";

const MAX_BATCH_SIZE = 50;
const MAX_BACKOFF_MS = 60 * 60_000;

export interface UsageOutboxFlusherOptions {
  client: CloudUsageClient;
  store: UsageOutboxStore;
  telemetry: ExecutorTelemetryRuntime;
  clock?: Clock;
  intervalMs?: number;
  alertAfterAttempts?: number;
}

export interface UsageFlushResult {
  readonly selected: number;
  readonly sent: number;
  readonly failed: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function retryDelayMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt - 1, 12));
}

export class UsageOutboxFlusher {
  readonly #client: CloudUsageClient;
  readonly #store: UsageOutboxStore;
  readonly #telemetry: ExecutorTelemetryRuntime;
  readonly #logger: ExecutorLogger;
  readonly #clock: Clock;
  readonly #intervalMs: number;
  readonly #alertAfterAttempts: number;
  #timer: NodeJS.Timeout | undefined;
  #active: Promise<UsageFlushResult> | undefined;
  #started = false;

  constructor(options: UsageOutboxFlusherOptions) {
    this.#client = options.client;
    this.#store = options.store;
    this.#telemetry = options.telemetry;
    this.#logger = options.telemetry.logger;
    this.#clock = options.clock ?? systemClock;
    this.#intervalMs = positiveInteger(
      options.intervalMs ?? 5_000,
      "Usage outbox flush interval",
    );
    this.#alertAfterAttempts = positiveInteger(
      options.alertAfterAttempts ?? 8,
      "Usage outbox alert attempt threshold",
    );
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#schedule(0);
  }

  stop(): void {
    this.#started = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  flushOnce(includeDeferred = false): Promise<UsageFlushResult> {
    const active = this.#active;
    if (active !== undefined) return active;
    const pending = this.#flush(includeDeferred).finally(() => {
      if (this.#active === pending) this.#active = undefined;
    });
    this.#active = pending;
    return pending;
  }

  async onIdle(): Promise<void> {
    await this.#active;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    positiveInteger(timeoutMs, "Usage outbox drain timeout");
    this.stop();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await this.#withinDeadline(
        this.flushOnce(true),
        remaining,
      );
      if (result === undefined || result.failed > 0) break;
      const depth = await this.#store.depth();
      this.#telemetry.setUsageOutboxDepth(depth);
      if (depth === 0) return true;
      if (result.selected === 0) break;
    }
    const depth = await this.#store.depth();
    this.#telemetry.setUsageOutboxDepth(depth);
    if (depth > 0) {
      this.#logger.warn("usage.outbox_drain_incomplete", { depth, timeoutMs });
    }
    return depth === 0;
  }

  async #flush(includeDeferred: boolean): Promise<UsageFlushResult> {
    const now = this.#now();
    const records = await this.#store.listReady(
      now.toISOString(),
      MAX_BATCH_SIZE,
      includeDeferred,
    );
    if (records.length === 0) {
      this.#telemetry.setUsageOutboxDepth(await this.#store.depth());
      return { selected: 0, sent: 0, failed: 0 };
    }
    try {
      const result = await this.#client.report(
        records.map((record) => record.payload),
      );
      const completedAt = this.#now().toISOString();
      await this.#store.markSent(
        records.map((record) => record.executionId),
        completedAt,
      );
      this.#telemetry.recordUsageReport("accepted", result.accepted);
      this.#telemetry.recordUsageReport("duplicate", result.duplicates);
      this.#logger.info("usage.report_batch_succeeded", {
        batchSize: records.length,
        accepted: result.accepted,
        duplicates: result.duplicates,
      });
      this.#telemetry.setUsageOutboxDepth(await this.#store.depth());
      return { selected: records.length, sent: records.length, failed: 0 };
    } catch (error) {
      const failedAt = this.#now();
      await this.#store.markFailed(
        records.map((record) => ({
          executionId: record.executionId,
          nextRetryAt: new Date(
            failedAt.valueOf() + retryDelayMs(record.attempts + 1),
          ).toISOString(),
        })),
        failedAt.toISOString(),
      );
      this.#telemetry.recordUsageReport("failed", records.length);
      this.#logger.warn("usage.report_batch_failed", {
        batchSize: records.length,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      this.#alertRetained(records);
      this.#telemetry.setUsageOutboxDepth(await this.#store.depth());
      return { selected: records.length, sent: 0, failed: records.length };
    }
  }

  #alertRetained(records: readonly UsageOutboxRecord[]): void {
    const alerting = records.filter(
      (record) => record.attempts + 1 >= this.#alertAfterAttempts,
    );
    if (alerting.length === 0) return;
    this.#logger.error("usage.outbox_retry_alert", {
      retained: alerting.length,
      attemptFloor: Math.min(...alerting.map((record) => record.attempts + 1)),
    });
  }

  #schedule(delayMs: number): void {
    if (!this.#started) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flushOnce()
        .then((result) => {
          this.#schedule(result.sent === MAX_BATCH_SIZE ? 0 : this.#intervalMs);
        })
        .catch((error: unknown) => {
          this.#logger.error("usage.outbox_flusher_failed", {
            errorName: error instanceof Error ? error.name : "unknown",
          });
          this.#schedule(this.#intervalMs);
        });
    }, delayMs);
    this.#timer.unref();
  }

  async #withinDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
  ): Promise<T | undefined> {
    if (timeoutMs <= 0) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #now(): Date {
    const now = this.#clock.now();
    if (Number.isNaN(now.valueOf())) {
      throw new Error("Usage outbox clock returned an invalid date.");
    }
    return new Date(now.valueOf());
  }
}
