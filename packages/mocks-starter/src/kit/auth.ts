import type { MiddlewareHandler } from "hono";
import { createIdFactory, type DeterministicIdFactory } from "./id.js";

export const EXPIRED_TOKEN = "fixture:EXPIRED_TOKEN";
export const INSUFFICIENT_SCOPE_TOKEN = "fixture:INSUFFICIENT_SCOPE_TOKEN";
export const RATE_LIMITED_TOKEN = "fixture:RATE_LIMITED_TOKEN";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type AuthFailureKind =
  | "missing"
  | "expired"
  | "insufficient_scope"
  | "rate_limited";

export type AuthFailure = {
  kind: AuthFailureKind;
  status: 401 | 403 | 429;
  providerCode: string;
  message: string;
  requestId: string;
  retryAfter?: number;
};

export type FormatProviderError = (failure: AuthFailure) => JsonValue;
export type TokenValidationResult = "valid" | "expired" | "invalid";

export interface AuthMiddlewareOptions {
  apiKeyHeader?: string;
  formatErrors?: FormatProviderError;
  requestIds?: DeterministicIdFactory;
  retryAfterSeconds?: number;
  validateToken?: (token: string) => TokenValidationResult;
}

export const defaultFormatProviderError: FormatProviderError = (failure) => ({
  error: {
    type: failure.kind,
    code: failure.providerCode,
    message: failure.message,
  },
  request_id: failure.requestId,
});

function matchesTrigger(token: string, trigger: string): boolean {
  return token === trigger || token === trigger.replace("fixture:", "");
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const [scheme, token, ...rest] = header.trim().split(/\s+/u);
  if (
    scheme?.toLowerCase() !== "bearer" ||
    token === undefined ||
    token.length === 0 ||
    rest.length > 0
  ) {
    return undefined;
  }
  return token;
}

function basicPassword(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const [scheme, encoded, ...rest] = header.trim().split(/\s+/u);
  if (
    scheme?.toLowerCase() !== "basic" ||
    encoded === undefined ||
    encoded.length === 0 ||
    rest.length > 0
  ) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator < 0 ? undefined : decoded.slice(separator + 1);
  } catch {
    return undefined;
  }
}

function apiKeyToken(header: string | undefined): string | undefined {
  const token = header?.trim();
  return token === undefined || token.length === 0 ? undefined : token;
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareHandler {
  const formatErrors = options.formatErrors ?? defaultFormatProviderError;
  const requestIds = options.requestIds ?? createIdFactory("req");
  const retryAfter = options.retryAfterSeconds ?? 60;

  return async (context, next) => {
    const token =
      bearerToken(context.req.header("authorization")) ??
      basicPassword(context.req.header("authorization")) ??
      (options.apiKeyHeader === undefined
        ? undefined
        : apiKeyToken(context.req.header(options.apiKeyHeader)));
    let failure: Omit<AuthFailure, "requestId"> | undefined;

    if (token === undefined) {
      failure = {
        kind: "missing",
        status: 401,
        providerCode: "missing_token",
        message:
          options.apiKeyHeader === undefined
            ? "A bearer token is required."
            : `The ${options.apiKeyHeader} header is required.`,
      };
    } else if (matchesTrigger(token, EXPIRED_TOKEN)) {
      failure = {
        kind: "expired",
        status: 401,
        providerCode: "token_expired",
        message: "The access token has expired.",
      };
    } else if (matchesTrigger(token, INSUFFICIENT_SCOPE_TOKEN)) {
      failure = {
        kind: "insufficient_scope",
        status: 403,
        providerCode: "insufficient_scope",
        message: "The access token does not include the required scope.",
      };
    } else if (matchesTrigger(token, RATE_LIMITED_TOKEN)) {
      failure = {
        kind: "rate_limited",
        status: 429,
        providerCode: "rate_limited",
        message: "The provider rate limit was exceeded.",
        retryAfter,
      };
    } else {
      const validation = options.validateToken?.(token);
      if (validation === "expired") {
        failure = {
          kind: "expired",
          status: 401,
          providerCode: "token_expired",
          message: "The access token has expired.",
        };
      } else if (validation === "invalid") {
        failure = {
          kind: "missing",
          status: 401,
          providerCode: "invalid_token",
          message: "The access token is invalid.",
        };
      }
    }

    if (failure === undefined) {
      await next();
      return;
    }

    const descriptor: AuthFailure = {
      ...failure,
      requestId: requestIds.next(),
    };
    context.header("x-request-id", descriptor.requestId);
    if (descriptor.retryAfter !== undefined) {
      context.header("Retry-After", String(descriptor.retryAfter));
    }
    context.header("content-type", "application/json; charset=UTF-8");
    return context.body(
      JSON.stringify(formatErrors(descriptor)),
      descriptor.status,
    );
  };
}
