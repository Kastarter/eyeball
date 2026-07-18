import { type Clock, TOOL_ERROR_CODES } from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  createExecutorApp,
  createRateLimitPolicies,
  DEFAULT_EXECUTE_REQUEST_BURST,
  DEFAULT_EXECUTE_REQUESTS_PER_MINUTE,
  DEFAULT_REQUEST_BURST,
  DEFAULT_REQUESTS_PER_MINUTE,
  type ExecutorRateLimitPolicies,
  InMemoryRateLimiter,
  type TokenBucketRateLimitPolicy,
} from "../src/index.js";

function controlledClock(initial: number) {
  let now = initial;
  const clock: Clock = { now: () => new Date(now) };
  return {
    clock,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    set(value: number) {
      now = value;
    },
  };
}

const SINGLE_REQUEST_POLICY: TokenBucketRateLimitPolicy = {
  kind: "token_bucket",
  limit: 1,
  intervalMs: 60_000,
  burst: 1,
};

function policies(
  overrides: Partial<ExecutorRateLimitPolicies> = {},
): ExecutorRateLimitPolicies {
  return {
    standard: SINGLE_REQUEST_POLICY,
    execute: SINGLE_REQUEST_POLICY,
    ...overrides,
  };
}

function appWithLimits(options: {
  clock: Clock;
  policies?: ExecutorRateLimitPolicies;
}) {
  return createExecutorApp({
    apiKeys: {
      ey_project: "proj_shared",
      ey_pinned: { projectId: "proj_shared", userId: "user_pinned" },
      ey_other: "proj_other",
    },
    env: {},
    rateLimiter: new InMemoryRateLimiter({ clock: options.clock }),
    rateLimitPolicies: options.policies ?? policies(),
    requestIdFactory: () => "req_rate_limit",
  });
}

function getExecutions(
  app: ReturnType<typeof createExecutorApp>,
  apiKey = "ey_project",
): Promise<Response> {
  return app.request("/v1/executions", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

function invalidExecute(
  app: ReturnType<typeof createExecutorApp>,
  apiKey = "ey_project",
): Promise<Response> {
  return app.request("/v1/execute", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
}

describe("executor rate limits", () => {
  it("loads safe defaults and optional quota overrides from environment", () => {
    const defaults = createRateLimitPolicies({});
    expect(defaults.standard).toMatchObject({
      limit: DEFAULT_REQUESTS_PER_MINUTE,
      burst: DEFAULT_REQUEST_BURST,
    });
    expect(defaults.execute).toMatchObject({
      limit: DEFAULT_EXECUTE_REQUESTS_PER_MINUTE,
      burst: DEFAULT_EXECUTE_REQUEST_BURST,
    });
    expect(defaults.dailyExecutionQuota).toBeUndefined();

    expect(
      createRateLimitPolicies({
        EYEBALL_RATE_LIMIT_REQUESTS_PER_MINUTE: "10",
        EYEBALL_RATE_LIMIT_REQUEST_BURST: "15",
        EYEBALL_RATE_LIMIT_EXECUTE_PER_MINUTE: "4",
        EYEBALL_RATE_LIMIT_EXECUTE_BURST: "5",
        EYEBALL_RATE_LIMIT_DAILY_EXECUTIONS: "20",
      }),
    ).toMatchObject({
      standard: { limit: 10, burst: 15 },
      execute: { limit: 4, burst: 5 },
      dailyExecutionQuota: { limit: 20 },
    });
  });

  it("supports token-bucket burst, exhaustion, and sustained refill", async () => {
    const time = controlledClock(1_000);
    const limiter = new InMemoryRateLimiter({ clock: time.clock });
    const policy: TokenBucketRateLimitPolicy = {
      kind: "token_bucket",
      limit: 1,
      intervalMs: 1_000,
      burst: 2,
    };

    await expect(limiter.check("bucket", policy)).resolves.toEqual({
      allowed: true,
      remaining: 1,
      resetAt: 2_000,
    });
    await expect(limiter.check("bucket", policy)).resolves.toEqual({
      allowed: true,
      remaining: 0,
      resetAt: 3_000,
    });
    await expect(limiter.check("bucket", policy)).resolves.toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 3_000,
      retryAfterMs: 1_000,
    });

    time.advance(500);
    await expect(limiter.check("bucket", policy)).resolves.toMatchObject({
      allowed: false,
      retryAfterMs: 500,
    });
    time.advance(500);
    await expect(limiter.check("bucket", policy)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });

    time.advance(10_000);
    await expect(limiter.check("bucket", policy)).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("returns the RFC 001 429 envelope and standard headers", async () => {
    const time = controlledClock(Date.UTC(2026, 6, 18, 12));
    const app = appWithLimits({ clock: time.clock });

    expect((await getExecutions(app)).status).toBe(200);
    const rejected = await getExecutions(app);

    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("RateLimit-Limit")).toBe("1");
    expect(rejected.headers.get("RateLimit-Remaining")).toBe("0");
    expect(rejected.headers.get("RateLimit-Reset")).toBe(
      String(Math.ceil((Date.UTC(2026, 6, 18, 12) + 60_000) / 1_000)),
    );
    expect(rejected.headers.get("Retry-After")).toBe("60");
    await expect(rejected.json()).resolves.toEqual({
      error: {
        code: TOOL_ERROR_CODES.RATE_LIMITED,
        message: "Authenticated project request rate limit exceeded.",
        retryable: true,
        retryAfter: 60,
      },
      requestId: "req_rate_limit",
    });
  });

  it("keeps execute and standard buckets separate", async () => {
    const time = controlledClock(Date.UTC(2026, 6, 18));
    const app = appWithLimits({ clock: time.clock });

    expect((await getExecutions(app)).status).toBe(200);
    expect((await invalidExecute(app)).status).toBe(422);
    expect((await invalidExecute(app)).status).toBe(429);
    expect((await getExecutions(app)).status).toBe(429);
    expect((await getExecutions(app, "ey_other")).status).toBe(200);
  });

  it("charges pinned and unpinned keys to the same project bucket", async () => {
    const time = controlledClock(Date.UTC(2026, 6, 18));
    const app = appWithLimits({ clock: time.clock });

    expect((await getExecutions(app, "ey_project")).status).toBe(200);
    const pinned = await getExecutions(app, "ey_pinned");

    expect(pinned.status).toBe(429);
    await expect(pinned.json()).resolves.toMatchObject({
      error: { code: TOOL_ERROR_CODES.RATE_LIMITED },
    });
  });

  it("resets the optional daily execution quota at UTC midnight", async () => {
    const beforeMidnight = Date.UTC(2026, 6, 18, 23, 59, 59);
    const time = controlledClock(beforeMidnight);
    const app = appWithLimits({
      clock: time.clock,
      policies: policies({
        standard: { ...SINGLE_REQUEST_POLICY, burst: 10 },
        execute: { ...SINGLE_REQUEST_POLICY, burst: 10 },
        dailyExecutionQuota: {
          kind: "fixed_window",
          limit: 1,
          windowMs: 24 * 60 * 60 * 1_000,
        },
      }),
    });

    expect((await invalidExecute(app)).status).toBe(422);
    const exhausted = await invalidExecute(app);
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get("RateLimit-Limit")).toBe("1");
    expect(exhausted.headers.get("Retry-After")).toBe("1");
    await expect(exhausted.json()).resolves.toMatchObject({
      error: {
        code: TOOL_ERROR_CODES.RATE_LIMITED,
        message: "Daily project execution quota exceeded.",
        retryAfter: 1,
      },
    });

    time.set(Date.UTC(2026, 6, 19));
    expect((await invalidExecute(app)).status).toBe(422);
  });
});
