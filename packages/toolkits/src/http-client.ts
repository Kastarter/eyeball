import {
  type AdapterContext,
  EyeballError,
  fromHttpStatus,
  type JsonValue,
  type ResolvedCredential,
  TOOL_ERROR_CODES,
} from "@eyeball/core";

export type ProviderHttpClient = (
  path: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ProviderHttpClientOptions {
  /** Explicit provider authorization value; null intentionally omits auth. */
  authorization?: string | null;
}

function apiKeyBearerValue(
  credential: Extract<ResolvedCredential, { type: "api_key" }>,
): string {
  const preferredFields = ["apiKey", "api_key", "accessToken", "token", "key"];
  for (const field of preferredFields) {
    const value = credential.values[field];
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }

  const first = Object.entries(credential.values).sort(([left], [right]) =>
    left.localeCompare(right),
  )[0]?.[1];
  if (first === undefined || first.length === 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_MISSING,
      message: "The resolved API-key credential has no usable value.",
    });
  }
  return first;
}

function authorizationHeader(
  credential: ResolvedCredential,
): string | undefined {
  switch (credential.type) {
    case "oauth2":
      return `Bearer ${credential.accessToken}`;
    case "api_key":
      return `Bearer ${apiKeyBearerValue(credential)}`;
    case "basic":
      return `Basic ${Buffer.from(
        `${credential.username}:${credential.password}`,
      ).toString("base64")}`;
    case "none":
      return undefined;
  }
}

function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  const date = Date.parse(value);
  return Number.isNaN(date)
    ? undefined
    : Math.max(0, Math.ceil((date - now.valueOf()) / 1_000));
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.clone().text();
  if (text.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function resolveProviderUrl(baseUrl: string, path: string | URL): URL {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const resolved = new URL(path, base);
  if (resolved.origin !== base.origin) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.NOT_SUPPORTED,
      message: "Provider requests must stay on the configured provider origin.",
    });
  }
  return resolved;
}

/** Creates an authenticated same-origin client for a toolkit adapter. */
export function createProviderHttpClient(
  context: AdapterContext,
  options: ProviderHttpClientOptions = {},
): ProviderHttpClient {
  return async (path, init = {}) => {
    const url = resolveProviderUrl(context.baseUrl, path);
    const headers = new Headers(init.headers);
    const authorization =
      options.authorization === undefined
        ? authorizationHeader(context.credential)
        : (options.authorization ?? undefined);
    if (authorization !== undefined) {
      headers.set("Authorization", authorization);
    }

    let response: Response;
    try {
      response = await context.fetchImpl(url, { ...init, headers });
    } catch (error) {
      throw new EyeballError({
        code: isAbortError(error)
          ? TOOL_ERROR_CODES.TIMEOUT
          : TOOL_ERROR_CODES.PROVIDER_UNAVAILABLE,
        message: isAbortError(error)
          ? "The provider request timed out."
          : "The provider could not be reached.",
        cause: error,
      });
    }

    if (response.status < 400) {
      return response;
    }

    const body = await responseBody(response);
    const mapped = fromHttpStatus(response.status, body);
    const retryAfter =
      parseRetryAfter(
        response.headers.get("Retry-After"),
        context.clock.now(),
      ) ?? mapped.retryAfter;
    throw new EyeballError({
      code: mapped.code,
      message: mapped.message,
      retryable: mapped.retryable,
      ...(retryAfter === undefined ? {} : { retryAfter }),
      providerDetail: {
        toolkit: context.tool.toolkit,
        status: response.status,
      },
      cause: mapped,
    });
  };
}
