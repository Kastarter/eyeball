import type { ExecutionId } from "@eyeball/core";
import {
  type Clock,
  type ExecutorLogger,
  systemClock,
} from "../adapters/index.js";
import type { ExecutorTelemetryRuntime } from "../telemetry/index.js";
import {
  type TerminalUsageReport,
  type UsageAdmission,
  type UsageGate,
  UsageGateUnavailableError,
  type UsageReservationContext,
  type UsageReservationHandle,
} from "./gate.js";
import type { UsageOutboxStore, UsageReportPayload } from "./outbox.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 12_000;
const DEFAULT_ALERT_AFTER_ATTEMPTS = 8;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface CloudUsageConfiguration {
  readonly baseUrl: string;
  readonly internalApiSecret: string;
  readonly strict: boolean;
  readonly timeoutMs: number;
  readonly flushIntervalMs: number;
  readonly drainTimeoutMs: number;
  readonly alertAfterAttempts: number;
}

export interface CloudUsageClientOptions {
  baseUrl: string;
  internalApiSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CloudUsageGateOptions {
  client: CloudUsageClient;
  outboxStore: UsageOutboxStore;
  telemetry: ExecutorTelemetryRuntime;
  strict?: boolean;
  clock?: Clock;
}

export interface CloudUsageReservation {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly month: string;
  readonly createdAt: string;
  readonly executionId?: ExecutionId;
}

export type CloudUsageReservationResult =
  | {
      readonly allowed: true;
      readonly reservation: CloudUsageReservation;
    }
  | {
      readonly allowed: false;
      readonly message?: string;
    };

export interface CloudUsageReportResult {
  readonly accepted: number;
  readonly duplicates: number;
}

export class CloudUsageTransportError extends Error {
  constructor() {
    super("The cloud usage service is unavailable.");
    this.name = "CloudUsageTransportError";
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validMonth(value: unknown): value is string {
  return (
    typeof value === "string" && /^\d{4}-(?:0[1-9]|1[0-2])-01$/u.test(value)
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function environmentInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new TypeError(`${name} must be an integer.`);
  }
  return positiveInteger(Number(raw), name);
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function usageBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("EYEBALL_USAGE_URL must be a valid absolute URL.");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "EYEBALL_USAGE_URL must use HTTPS without credentials, a query, or a fragment (HTTP is allowed only for loopback development).",
    );
  }
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url;
}

async function responseJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    throw new CloudUsageTransportError();
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new CloudUsageTransportError();
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new CloudUsageTransportError();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CloudUsageTransportError();
  }
}

function parseReservationResult(
  value: unknown,
  context: UsageReservationContext,
): CloudUsageReservationResult {
  if (!isObject(value) || typeof value.allowed !== "boolean") {
    throw new CloudUsageTransportError();
  }
  if (value.allowed === false) {
    if (value.reservation !== null && !isObject(value.reservation)) {
      throw new CloudUsageTransportError();
    }
    const message = requiredString(value.upgradeMessage);
    return { allowed: false, ...(message === undefined ? {} : { message }) };
  }
  if (
    value.projectId !== context.projectId ||
    value.dimension !== "execution" ||
    value.requested !== 1 ||
    !isObject(value.reservation)
  ) {
    throw new CloudUsageTransportError();
  }
  const reservation = value.reservation;
  const id = requiredString(reservation.id);
  const idempotencyKey = requiredString(reservation.idempotencyKey);
  const expectedExecutionId = context.cloudExecutionId ?? null;
  if (
    id === undefined ||
    idempotencyKey !== context.idempotencyKey ||
    reservation.projectId !== context.projectId ||
    reservation.quantity !== 1 ||
    reservation.state !== "reserved" ||
    reservation.executionId !== expectedExecutionId ||
    !validMonth(reservation.month) ||
    !validTimestamp(reservation.createdAt)
  ) {
    throw new CloudUsageTransportError();
  }
  return {
    allowed: true,
    reservation: {
      id,
      idempotencyKey,
      month: reservation.month,
      createdAt: new Date(reservation.createdAt as string).toISOString(),
      ...(context.cloudExecutionId === undefined
        ? {}
        : { executionId: context.cloudExecutionId }),
    },
  };
}

function parseReportResult(
  value: unknown,
  eventCount: number,
): CloudUsageReportResult {
  if (!isObject(value)) throw new CloudUsageTransportError();
  const accepted = value.accepted;
  const duplicates = value.duplicates;
  if (
    !Number.isSafeInteger(accepted) ||
    !Number.isSafeInteger(duplicates) ||
    (accepted as number) < 0 ||
    (duplicates as number) < 0 ||
    (accepted as number) + (duplicates as number) !== eventCount
  ) {
    throw new CloudUsageTransportError();
  }
  return { accepted: accepted as number, duplicates: duplicates as number };
}

export function cloudUsageConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CloudUsageConfiguration | undefined {
  const baseUrl = env.EYEBALL_USAGE_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) return undefined;
  const internalApiSecret = env.EYEBALL_INTERNAL_API_SECRET?.trim();
  if (internalApiSecret === undefined || internalApiSecret.length === 0) {
    throw new TypeError(
      "EYEBALL_INTERNAL_API_SECRET is required when EYEBALL_USAGE_URL is configured.",
    );
  }
  const strictValue = env.EYEBALL_USAGE_STRICT?.trim() ?? "0";
  if (strictValue !== "0" && strictValue !== "1") {
    throw new TypeError("EYEBALL_USAGE_STRICT must be 0 or 1.");
  }
  return {
    baseUrl,
    internalApiSecret,
    strict: strictValue === "1",
    timeoutMs: environmentInteger(
      env,
      "EYEBALL_USAGE_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    ),
    flushIntervalMs: environmentInteger(
      env,
      "EYEBALL_USAGE_FLUSH_INTERVAL_MS",
      DEFAULT_FLUSH_INTERVAL_MS,
    ),
    drainTimeoutMs: environmentInteger(
      env,
      "EYEBALL_USAGE_DRAIN_TIMEOUT_MS",
      DEFAULT_DRAIN_TIMEOUT_MS,
    ),
    alertAfterAttempts: environmentInteger(
      env,
      "EYEBALL_USAGE_ALERT_AFTER_ATTEMPTS",
      DEFAULT_ALERT_AFTER_ATTEMPTS,
    ),
  };
}

/** Bearer-authenticated client for the Cloud reservation and report protocol. */
export class CloudUsageClient {
  readonly #baseUrl: URL;
  readonly #internalApiSecret: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: CloudUsageClientOptions) {
    if (options.internalApiSecret.length < 32) {
      throw new TypeError(
        "EYEBALL_INTERNAL_API_SECRET must contain at least 32 characters.",
      );
    }
    this.#baseUrl = usageBaseUrl(options.baseUrl);
    this.#internalApiSecret = options.internalApiSecret;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Cloud usage request timeout",
    );
  }

  async reserve(
    context: UsageReservationContext,
  ): Promise<CloudUsageReservationResult> {
    const value = await this.#post("/internal/usage/reserve", {
      projectId: context.projectId,
      dimension: "execution",
      quantity: 1,
      idempotencyKey: context.idempotencyKey,
      ...(context.cloudExecutionId === undefined
        ? {}
        : { executionId: context.cloudExecutionId }),
    });
    return parseReservationResult(value, context);
  }

  async release(reservation: UsageReservationHandle): Promise<void> {
    const value = await this.#post("/internal/usage/release", {
      idempotencyKey: reservation.idempotencyKey,
      ...(reservation.cloudExecutionId === undefined
        ? {}
        : { executionId: reservation.cloudExecutionId }),
    });
    if (
      !isObject(value) ||
      !isObject(value.reservation) ||
      value.reservation.id !== reservation.reservationId ||
      (value.reservation.state !== "released" &&
        value.reservation.state !== "expired")
    ) {
      throw new CloudUsageTransportError();
    }
  }

  async report(
    payloads: readonly UsageReportPayload[],
  ): Promise<CloudUsageReportResult> {
    if (payloads.length < 1 || payloads.length > 50) {
      throw new RangeError(
        "Cloud usage report batches must contain 1-50 events.",
      );
    }
    const value = await this.#post("/internal/usage/report", {
      events: payloads.map((payload) => ({
        projectId: payload.projectId,
        ...(payload.cloudExecutionId === undefined
          ? {}
          : { executionId: payload.cloudExecutionId }),
        idempotencyKey: payload.idempotencyKey,
        dimension: payload.dimension,
        quantity: payload.quantity,
        timestamp: payload.occurredAt,
        source: "eyeball_executor",
      })),
    });
    return parseReportResult(value, payloads.length);
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      const url = new URL(path, this.#baseUrl);
      response = await this.#fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#internalApiSecret}`,
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new CloudUsageTransportError();
    }
    if (!response.ok) throw new CloudUsageTransportError();
    return responseJson(response);
  }
}

/** Admission gate plus asynchronous terminal-to-outbox bridge. */
export class CloudUsageGate implements UsageGate {
  readonly enabled = true;
  readonly client: CloudUsageClient;
  readonly outboxStore: UsageOutboxStore;
  readonly #telemetry: ExecutorTelemetryRuntime;
  readonly #logger: ExecutorLogger;
  readonly #strict: boolean;
  readonly #clock: Clock;
  readonly #pending = new Set<Promise<void>>();
  readonly #releaseBindings = new Map<string, UsageReservationHandle>();

  constructor(options: CloudUsageGateOptions) {
    this.client = options.client;
    this.outboxStore = options.outboxStore;
    this.#telemetry = options.telemetry;
    this.#logger = options.telemetry.logger;
    this.#strict = options.strict ?? false;
    this.#clock = options.clock ?? systemClock;
  }

  async reserve(context: UsageReservationContext): Promise<UsageAdmission> {
    try {
      const result = await this.client.reserve(context);
      if (!result.allowed) {
        this.#telemetry.recordUsageReservation("denied");
        this.#logger.warn("usage.reservation_denied", {
          projectId: context.projectId,
          executionId: context.executionId,
          strict: this.#strict,
        });
        return {
          allowed: false,
          message:
            result.message ??
            "Monthly execution quota reached. Upgrade the organization plan or wait for the next UTC month.",
        };
      }
      this.#telemetry.recordUsageReservation("allowed");
      this.#logger.info("usage.reservation_allowed", {
        projectId: context.projectId,
        executionId: context.executionId,
      });
      const reservation: UsageReservationHandle = {
        reservationId: result.reservation.id,
        idempotencyKey: context.idempotencyKey,
        ...(context.cloudExecutionId === undefined
          ? {}
          : { cloudExecutionId: context.cloudExecutionId }),
      };
      this.#releaseBindings.set(reservation.reservationId, reservation);
      return {
        allowed: true,
        report: {
          projectId: context.projectId,
          executionId: context.executionId,
          idempotencyKey: context.idempotencyKey,
          reservationId: reservation.reservationId,
          reservedAt: result.reservation.createdAt,
          ...(context.cloudExecutionId === undefined
            ? {}
            : { cloudExecutionId: context.cloudExecutionId }),
        },
        reservationId: reservation.reservationId,
      };
    } catch (error) {
      if (this.#strict) {
        this.#telemetry.recordUsageReservation("error");
        this.#logger.error("usage.reservation_failed_closed", {
          projectId: context.projectId,
          executionId: context.executionId,
          errorName: error instanceof Error ? error.name : "unknown",
        });
        throw new UsageGateUnavailableError();
      }
      this.#telemetry.recordUsageReservation("fail_open");
      this.#logger.warn("usage.reservation_failed_open", {
        projectId: context.projectId,
        executionId: context.executionId,
        enforcementBypassed: true,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      return {
        allowed: true,
        report: {
          projectId: context.projectId,
          executionId: context.executionId,
          idempotencyKey: context.idempotencyKey,
          ...(context.cloudExecutionId === undefined
            ? {}
            : { cloudExecutionId: context.cloudExecutionId }),
        },
      };
    }
  }

  reportTerminal(report: TerminalUsageReport): void {
    if (report.context.reservationId !== undefined) {
      this.#releaseBindings.delete(report.context.reservationId);
    }
    const occurredAt =
      report.context.reservedAt ??
      report.record.completedAt ??
      report.record.createdAt;
    const payload: UsageReportPayload = {
      projectId: report.context.projectId,
      executionId: report.context.executionId,
      idempotencyKey: report.context.idempotencyKey,
      dimension: "execution",
      quantity: 1,
      occurredAt,
      ...(report.context.cloudExecutionId === undefined
        ? {}
        : { cloudExecutionId: report.context.cloudExecutionId }),
    };
    const pending = this.outboxStore
      .enqueue(payload, this.#now().toISOString())
      .then(async () => {
        this.#telemetry.setUsageOutboxDepth(await this.outboxStore.depth());
      })
      .catch((error: unknown) => {
        this.#logger.error("usage.outbox_enqueue_failed", {
          projectId: report.context.projectId,
          executionId: report.context.executionId,
          errorName: error instanceof Error ? error.name : "unknown",
        });
      });
    this.#track(pending);
  }

  async release(reservationId: string): Promise<void> {
    const reservation = this.#releaseBindings.get(reservationId);
    if (reservation === undefined) {
      this.#logger.error("usage.reservation_release_binding_missing", {
        reservationId,
      });
      return;
    }
    try {
      await this.client.release(reservation);
      this.#logger.info("usage.reservation_released", {
        reservationId,
      });
    } catch (error) {
      this.#logger.error("usage.reservation_release_failed", {
        reservationId,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      this.#releaseBindings.delete(reservationId);
    }
  }

  async onIdle(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }

  #track(pending: Promise<void>): void {
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending));
  }

  #now(): Date {
    const now = this.#clock.now();
    if (Number.isNaN(now.valueOf())) {
      throw new Error("Usage gate clock returned an invalid date.");
    }
    return new Date(now.valueOf());
  }
}
