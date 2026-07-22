import { describe, expect, it } from "vitest";
import {
  createErrorEnvelope,
  EyeballError,
  extractRetryAfter,
  fromHttpStatus,
  TOOL_ERROR_CODES,
} from "../src/index.js";

describe("error taxonomy", () => {
  it("classifies interrupted execution outcomes as non-retryable", () => {
    const error = new EyeballError({
      code: TOOL_ERROR_CODES.EXECUTION_INTERRUPTED,
      message: "External outcome may be unknown.",
    });
    expect(error.code).toBe("execution_interrupted");
    expect(error.retryable).toBe(false);
  });

  it("classifies cancelled execution outcomes as canonical and non-retryable", () => {
    const error = new EyeballError({
      code: TOOL_ERROR_CODES.EXECUTION_CANCELLED,
      message: "Execution was cancelled before provider dispatch.",
    });

    expect(error.code).toBe("execution_cancelled");
    expect(error.retryable).toBe(false);
    expect(createErrorEnvelope(error, "request-cancelled")).toEqual({
      requestId: "request-cancelled",
      error: {
        code: "execution_cancelled",
        message: "Execution was cancelled before provider dispatch.",
        retryable: false,
      },
    });
  });

  it("keeps timeout non-retryable by default while allowing a seam override", () => {
    expect(
      new EyeballError({ code: "timeout", message: "default" }).retryable,
    ).toBe(false);
    expect(
      new EyeballError({
        code: "timeout",
        message: "remote read",
        retryable: true,
      }).retryable,
    ).toBe(true);
  });

  it.each([
    [400, "invalid_input", false, {}],
    [401, "auth_missing", false, {}],
    [401, "auth_expired", false, { error: "invalid_token" }],
    [403, "auth_insufficient_scope", false, {}],
    [404, "not_found", false, {}],
    [408, "timeout", false, {}],
    [429, "rate_limited", true, {}],
    [500, "provider_unavailable", true, {}],
    [503, "provider_unavailable", true, {}],
    [418, "provider_error", false, {}],
  ] as const)("maps HTTP %i to %s", (status, expectedCode, expectedRetryable, body) => {
    const error = fromHttpStatus(status, body);
    expect(error.code).toBe(expectedCode);
    expect(error.retryable).toBe(expectedRetryable);
  });

  it("extracts rate-limit delay seconds from nested body and header shapes", () => {
    expect(extractRetryAfter({ error: { retry_after: 30 } })).toBe(30);
    expect(extractRetryAfter({ headers: { "retry-after": "60" } })).toBe(60);
    expect(extractRetryAfter({ retryAfterMs: 2_500 })).toBe(2.5);

    const error = fromHttpStatus(429, {
      message: "Quota exceeded",
      metadata: { retry_after: "45" },
    });
    expect(error.message).toBe("Quota exceeded");
    expect(error.retryAfter).toBe(45);
  });

  it("serializes provider detail into the RFC error envelope", () => {
    const error = new EyeballError({
      code: TOOL_ERROR_CODES.RATE_LIMITED,
      message: "Gmail quota exceeded",
      retryable: true,
      retryAfter: 60,
      providerDetail: {
        toolkit: "gmail",
        status: 429,
        code: "rateLimitExceeded",
        requestId: "provider-request-1",
        detail: { reason: "userRateLimitExceeded" },
      },
    });

    expect(createErrorEnvelope(error, "request-1")).toEqual({
      requestId: "request-1",
      error: {
        code: "rate_limited",
        message: "Gmail quota exceeded",
        retryable: true,
        retryAfter: 60,
        provider: {
          toolkit: "gmail",
          status: 429,
          code: "rateLimitExceeded",
          requestId: "provider-request-1",
          detail: { reason: "userRateLimitExceeded" },
        },
      },
    });
  });

  it("rejects successful statuses and invalid retry delays", () => {
    expect(() => fromHttpStatus(204)).toThrow("is not an error status");
    expect(
      () =>
        new EyeballError({
          code: "rate_limited",
          message: "bad delay",
          retryAfter: -1,
        }),
    ).toThrow("retryAfter must be a non-negative number");
  });
});
