import type { JsonValue, ToolkitSlug } from "./types/tool.js";

/** Stable normalized error codes shared by tools, the executor, and SDK clients. */
export const TOOL_ERROR_CODES = {
  INVALID_INPUT: "invalid_input",
  AUTH_MISSING: "auth_missing",
  AUTH_EXPIRED: "auth_expired",
  AUTH_INSUFFICIENT_SCOPE: "auth_insufficient_scope",
  NOT_FOUND: "not_found",
  RATE_LIMITED: "rate_limited",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  PROVIDER_ERROR: "provider_error",
  TIMEOUT: "timeout",
  NOT_SUPPORTED: "not_supported",
} as const;

export type ToolErrorCode =
  (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

export const DEFAULT_ERROR_RETRYABILITY: Readonly<
  Record<ToolErrorCode, boolean>
> = {
  invalid_input: false,
  auth_missing: false,
  auth_expired: false,
  auth_insufficient_scope: false,
  not_found: false,
  rate_limited: true,
  provider_unavailable: true,
  provider_error: false,
  timeout: false,
  not_supported: false,
};

export interface ProviderErrorDetail {
  toolkit: ToolkitSlug;
  status?: number;
  code?: string;
  requestId?: string;
  /** Sanitized provider payload; secrets and auth headers are forbidden. */
  detail?: JsonValue;
}

/** Credential-safe error body returned by public execution and webhook boundaries. */
export interface NormalizedToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  /** Non-negative seconds; used with rate_limited when known. */
  retryAfter?: number;
  provider?: ProviderErrorDetail;
}

export interface ErrorEnvelope {
  error: NormalizedToolError;
  requestId: string;
  /** Pre-allocation errors have no execution identity. */
  executionId?: never;
}

export interface EyeballErrorOptions {
  code: ToolErrorCode;
  message: string;
  retryable?: boolean;
  retryAfter?: number;
  providerDetail?: ProviderErrorDetail;
  /** API request correlation identifier; not part of the normalized tool error body. */
  requestId?: string;
  /** Execution that can be polled or reconciled after this client-side error. */
  executionId?: string;
  cause?: unknown;
}

/** Normalized SDK and executor failure with stable taxonomy and retry metadata. */
export class EyeballError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly retryAfter?: number;
  readonly providerDetail?: ProviderErrorDetail;
  readonly requestId?: string;
  readonly executionId?: string;

  /**
   * Creates a normalized error while applying taxonomy retry defaults.
   *
   * @param options Stable code, safe message, and optional correlation metadata.
   * @throws RangeError When `retryAfter` is negative or not finite.
   */
  constructor(options: EyeballErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "EyeballError";
    this.code = options.code;
    this.retryable =
      options.retryable ?? DEFAULT_ERROR_RETRYABILITY[options.code];

    if (options.retryAfter !== undefined) {
      if (!Number.isFinite(options.retryAfter) || options.retryAfter < 0) {
        throw new RangeError(
          "retryAfter must be a non-negative number of seconds",
        );
      }
      this.retryAfter = options.retryAfter;
    }

    if (options.providerDetail !== undefined) {
      this.providerDetail = options.providerDetail;
    }
    if (options.requestId !== undefined) {
      this.requestId = options.requestId;
    }
    if (options.executionId !== undefined) {
      this.executionId = options.executionId;
    }
  }

  /** Returns the credential-safe normalized error body used on public boundaries. */
  toJSON(): NormalizedToolError {
    const normalized: NormalizedToolError = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };

    if (this.retryAfter !== undefined) {
      normalized.retryAfter = this.retryAfter;
    }
    if (this.providerDetail !== undefined) {
      normalized.provider = this.providerDetail;
    }

    return normalized;
  }
}

function errorText(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }

  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFromBody(status: number, body: unknown): string {
  if (typeof body === "string" && body.trim().length > 0) {
    return body;
  }

  if (isRecord(body)) {
    for (const key of ["message", "error_description", "detail", "error"]) {
      const value = body[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
      if (isRecord(value) && typeof value.message === "string") {
        return value.message;
      }
    }
  }

  return `Provider request failed with HTTP ${status}.`;
}

function parseRetryAfterValue(
  value: unknown,
  milliseconds: boolean,
): number | undefined {
  if (typeof value === "number" || typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return milliseconds ? numeric / 1_000 : numeric;
    }

    if (typeof value === "string") {
      const date = Date.parse(value);
      if (!Number.isNaN(date)) {
        return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
      }
    }
  }

  return undefined;
}

/** Extracts retry delay seconds from common provider body/header envelope fields. */
export function extractRetryAfter(body: unknown): number | undefined {
  const seen = new WeakSet<object>();

  function visit(value: unknown, depth: number): number | undefined {
    if (depth > 5 || !isRecord(value)) {
      return undefined;
    }
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);

    for (const [key, fieldValue] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replaceAll("-", "_");
      if (normalizedKey === "retry_after" || normalizedKey === "retryafter") {
        const parsed = parseRetryAfterValue(fieldValue, false);
        if (parsed !== undefined) {
          return parsed;
        }
      }
      if (
        normalizedKey === "retry_after_ms" ||
        normalizedKey === "retryafterms"
      ) {
        const parsed = parseRetryAfterValue(fieldValue, true);
        if (parsed !== undefined) {
          return parsed;
        }
      }
    }

    for (const nested of Object.values(value)) {
      const parsed = visit(nested, depth + 1);
      if (parsed !== undefined) {
        return parsed;
      }
    }

    return undefined;
  }

  return visit(body, 0);
}

function unauthorizedCode(body: unknown): ToolErrorCode {
  const text = errorText(body).toLowerCase();
  return /expired|invalid[_ -]?token|invalid[_ -]?grant|token[_ -]?revoked/.test(
    text,
  )
    ? TOOL_ERROR_CODES.AUTH_EXPIRED
    : TOOL_ERROR_CODES.AUTH_MISSING;
}

/** Maps an error HTTP response into RFC 001's closed error taxonomy. */
export function fromHttpStatus(status: number, body?: unknown): EyeballError {
  if (!Number.isInteger(status) || status < 0 || status > 599) {
    throw new RangeError(`Invalid HTTP status: ${status}`);
  }
  if (status >= 200 && status < 400) {
    throw new RangeError(`HTTP ${status} is not an error status`);
  }

  let code: ToolErrorCode;
  if (status === 0 || status >= 500) {
    code = TOOL_ERROR_CODES.PROVIDER_UNAVAILABLE;
  } else if (status === 400 || status === 409 || status === 422) {
    code = TOOL_ERROR_CODES.INVALID_INPUT;
  } else if (status === 401) {
    code = unauthorizedCode(body);
  } else if (status === 403) {
    code = TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE;
  } else if (status === 404) {
    code = TOOL_ERROR_CODES.NOT_FOUND;
  } else if (status === 408) {
    code = TOOL_ERROR_CODES.TIMEOUT;
  } else if (status === 429) {
    code = TOOL_ERROR_CODES.RATE_LIMITED;
  } else {
    code = TOOL_ERROR_CODES.PROVIDER_ERROR;
  }

  const retryAfter =
    code === TOOL_ERROR_CODES.RATE_LIMITED
      ? extractRetryAfter(body)
      : undefined;
  return new EyeballError({
    code,
    message: messageFromBody(status, body),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
}

export function createErrorEnvelope(
  error: EyeballError | NormalizedToolError,
  requestId: string,
): ErrorEnvelope {
  return {
    error: error instanceof EyeballError ? error.toJSON() : error,
    requestId,
  };
}
