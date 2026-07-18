import { type Clock, systemClock } from "@eyeball/core";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_REQUESTS_PER_MINUTE = 120;
export const DEFAULT_REQUEST_BURST = 240;
export const DEFAULT_EXECUTE_REQUESTS_PER_MINUTE = 60;
export const DEFAULT_EXECUTE_REQUEST_BURST = 120;

export interface TokenBucketRateLimitPolicy {
  kind: "token_bucket";
  /** Sustained token refill over intervalMs. */
  limit: number;
  intervalMs: number;
  /** Maximum accumulated tokens. */
  burst: number;
}

export interface FixedWindowRateLimitPolicy {
  kind: "fixed_window";
  limit: number;
  /** Windows are aligned to Unix epoch boundaries. */
  windowMs: number;
}

export type RateLimitPolicy =
  | TokenBucketRateLimitPolicy
  | FixedWindowRateLimitPolicy;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix epoch milliseconds when this policy resets or fully refills. */
  resetAt: number;
  retryAfterMs?: number;
}

/**
 * Async by design: a Redis-backed implementation can replace the in-memory
 * policy engine without changing middleware or executor call sites.
 */
export interface RateLimiter {
  check(bucketKey: string, policy: RateLimitPolicy): Promise<RateLimitResult>;
}

interface TokenBucketState {
  kind: "token_bucket";
  signature: string;
  tokens: number;
  updatedAt: number;
}

interface FixedWindowState {
  kind: "fixed_window";
  signature: string;
  used: number;
  windowStart: number;
}

type RateLimitState = TokenBucketState | FixedWindowState;

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function tokenPolicySignature(policy: TokenBucketRateLimitPolicy): string {
  return `${policy.limit}:${policy.intervalMs}:${policy.burst}`;
}

function fixedPolicySignature(policy: FixedWindowRateLimitPolicy): string {
  return `${policy.limit}:${policy.windowMs}`;
}

function validatePolicy(policy: RateLimitPolicy): void {
  positiveSafeInteger(policy.limit, "Rate-limit policy limit");
  if (policy.kind === "token_bucket") {
    positiveSafeInteger(policy.intervalMs, "Rate-limit refill interval");
    positiveSafeInteger(policy.burst, "Rate-limit burst");
    if (policy.burst < 1) {
      throw new RangeError("Rate-limit burst must hold at least one token.");
    }
    return;
  }
  positiveSafeInteger(policy.windowMs, "Rate-limit window");
}

function nowMilliseconds(clock: Clock): number {
  const now = clock.now().valueOf();
  if (!Number.isFinite(now)) {
    throw new Error("Rate limiter clock returned an invalid date.");
  }
  return now;
}

export class InMemoryRateLimiter implements RateLimiter {
  readonly #clock: Clock;
  readonly #states = new Map<string, RateLimitState>();

  constructor(options: { clock?: Clock } = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  async check(
    bucketKey: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitResult> {
    if (bucketKey.trim().length === 0) {
      throw new TypeError("Rate-limit bucket key must not be empty.");
    }
    validatePolicy(policy);
    const now = nowMilliseconds(this.#clock);
    return policy.kind === "token_bucket"
      ? this.#checkTokenBucket(bucketKey, policy, now)
      : this.#checkFixedWindow(bucketKey, policy, now);
  }

  #checkTokenBucket(
    bucketKey: string,
    policy: TokenBucketRateLimitPolicy,
    now: number,
  ): RateLimitResult {
    const signature = tokenPolicySignature(policy);
    const existing = this.#states.get(bucketKey);
    const state: TokenBucketState =
      existing?.kind === "token_bucket" && existing.signature === signature
        ? existing
        : {
            kind: "token_bucket",
            signature,
            tokens: policy.burst,
            updatedAt: now,
          };
    const refillPerMs = policy.limit / policy.intervalMs;
    const elapsed = Math.max(0, now - state.updatedAt);
    state.tokens = Math.min(policy.burst, state.tokens + elapsed * refillPerMs);
    state.updatedAt = Math.max(state.updatedAt, now);

    const allowed = state.tokens + Number.EPSILON >= 1;
    if (allowed) {
      state.tokens = Math.max(0, state.tokens - 1);
    }
    this.#states.set(bucketKey, state);

    const remaining = Math.max(0, Math.floor(state.tokens + Number.EPSILON));
    const resetAfterMs = Math.ceil(
      Math.max(0, policy.burst - state.tokens) / refillPerMs,
    );
    if (allowed) {
      return {
        allowed: true,
        remaining,
        resetAt: now + resetAfterMs,
      };
    }
    const retryAfterMs = Math.max(
      1,
      Math.ceil(Math.max(0, 1 - state.tokens) / refillPerMs),
    );
    return {
      allowed: false,
      remaining,
      resetAt: now + resetAfterMs,
      retryAfterMs,
    };
  }

  #checkFixedWindow(
    bucketKey: string,
    policy: FixedWindowRateLimitPolicy,
    now: number,
  ): RateLimitResult {
    const signature = fixedPolicySignature(policy);
    const currentWindowStart =
      Math.floor(now / policy.windowMs) * policy.windowMs;
    const existing = this.#states.get(bucketKey);
    const state: FixedWindowState =
      existing?.kind === "fixed_window" &&
      existing.signature === signature &&
      existing.windowStart >= currentWindowStart
        ? existing
        : {
            kind: "fixed_window",
            signature,
            used: 0,
            windowStart: currentWindowStart,
          };
    const allowed = state.used < policy.limit;
    if (allowed) {
      state.used += 1;
    }
    this.#states.set(bucketKey, state);
    const resetAt = state.windowStart + policy.windowMs;
    const result: RateLimitResult = {
      allowed,
      remaining: Math.max(0, policy.limit - state.used),
      resetAt,
    };
    if (!allowed) {
      result.retryAfterMs = Math.max(1, resetAt - now);
    }
    return result;
  }
}

export interface ExecutorRateLimitPolicies {
  standard: TokenBucketRateLimitPolicy;
  execute: TokenBucketRateLimitPolicy;
  dailyExecutionQuota?: FixedWindowRateLimitPolicy;
}

function configuredPositiveInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const encoded = env[name]?.trim();
  return positiveSafeInteger(
    encoded === undefined || encoded.length === 0 ? fallback : Number(encoded),
    name,
  );
}

function configuredOptionalPositiveInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const encoded = env[name]?.trim().toLowerCase();
  if (
    encoded === undefined ||
    encoded.length === 0 ||
    encoded === "0" ||
    encoded === "off"
  ) {
    return undefined;
  }
  return positiveSafeInteger(Number(encoded), name);
}

export function createRateLimitPolicies(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExecutorRateLimitPolicies {
  const standardLimit = configuredPositiveInteger(
    env,
    "EYEBALL_RATE_LIMIT_REQUESTS_PER_MINUTE",
    DEFAULT_REQUESTS_PER_MINUTE,
  );
  const executeLimit = configuredPositiveInteger(
    env,
    "EYEBALL_RATE_LIMIT_EXECUTE_PER_MINUTE",
    DEFAULT_EXECUTE_REQUESTS_PER_MINUTE,
  );
  const standardBurst = configuredPositiveInteger(
    env,
    "EYEBALL_RATE_LIMIT_REQUEST_BURST",
    standardLimit * 2,
  );
  const executeBurst = configuredPositiveInteger(
    env,
    "EYEBALL_RATE_LIMIT_EXECUTE_BURST",
    executeLimit * 2,
  );
  const dailyExecutionQuota = configuredOptionalPositiveInteger(
    env,
    "EYEBALL_RATE_LIMIT_DAILY_EXECUTIONS",
  );
  return {
    standard: {
      kind: "token_bucket",
      limit: standardLimit,
      intervalMs: MINUTE_MS,
      burst: standardBurst,
    },
    execute: {
      kind: "token_bucket",
      limit: executeLimit,
      intervalMs: MINUTE_MS,
      burst: executeBurst,
    },
    ...(dailyExecutionQuota === undefined
      ? {}
      : {
          dailyExecutionQuota: {
            kind: "fixed_window" as const,
            limit: dailyExecutionQuota,
            windowMs: DAY_MS,
          },
        }),
  };
}

export function rateLimitCapacity(policy: RateLimitPolicy): number {
  return policy.kind === "token_bucket" ? policy.burst : policy.limit;
}

export interface ConcurrencyPermit {
  release(): void;
}

export interface ToolkitConcurrencyLimiter {
  tryAcquire(bucketKey: string, limit: number): ConcurrencyPermit | undefined;
  acquire(bucketKey: string, limit: number): Promise<ConcurrencyPermit>;
}

interface ConcurrencyState {
  active: number;
  limit: number;
  waiters: Array<(permit: ConcurrencyPermit) => void>;
}

/** Process-local fair semaphore keyed by project and toolkit. */
export class InMemoryToolkitConcurrencyLimiter
  implements ToolkitConcurrencyLimiter
{
  readonly #states = new Map<string, ConcurrencyState>();

  tryAcquire(bucketKey: string, limit: number): ConcurrencyPermit | undefined {
    const state = this.#state(bucketKey, limit);
    if (state.active >= limit || state.waiters.length > 0) {
      return undefined;
    }
    state.active += 1;
    return this.#permit(bucketKey, state);
  }

  acquire(bucketKey: string, limit: number): Promise<ConcurrencyPermit> {
    const immediate = this.tryAcquire(bucketKey, limit);
    if (immediate !== undefined) {
      return Promise.resolve(immediate);
    }
    const state = this.#state(bucketKey, limit);
    return new Promise((resolve) => state.waiters.push(resolve));
  }

  #state(bucketKey: string, limit: number): ConcurrencyState {
    if (bucketKey.trim().length === 0) {
      throw new TypeError("Concurrency bucket key must not be empty.");
    }
    positiveSafeInteger(limit, "Concurrency limit");
    const existing = this.#states.get(bucketKey);
    if (existing !== undefined) {
      if (existing.limit !== limit) {
        throw new Error(
          `Concurrency limit changed while bucket ${bucketKey} was active.`,
        );
      }
      return existing;
    }
    const state: ConcurrencyState = { active: 0, limit, waiters: [] };
    this.#states.set(bucketKey, state);
    return state;
  }

  #permit(bucketKey: string, state: ConcurrencyState): ConcurrencyPermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        state.active -= 1;
        const next = state.waiters.shift();
        if (next !== undefined) {
          state.active += 1;
          next(this.#permit(bucketKey, state));
          return;
        }
        if (state.active === 0) {
          this.#states.delete(bucketKey);
        }
      },
    };
  }
}
