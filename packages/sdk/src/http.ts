import {
  EyeballError,
  fromHttpStatus,
  TOOL_ERROR_CODES,
  type ToolErrorCode,
} from "@eyeball/core";

const TOOL_ERROR_CODE_VALUES = new Set<string>(Object.values(TOOL_ERROR_CODES));

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedBody(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function envelopeError(body: unknown): EyeballError | undefined {
  if (!isRecord(body) || !isRecord(body.error)) {
    return undefined;
  }
  const { error } = body;
  if (
    typeof error.code !== "string" ||
    !TOOL_ERROR_CODE_VALUES.has(error.code) ||
    typeof error.message !== "string" ||
    typeof error.retryable !== "boolean"
  ) {
    return undefined;
  }
  const retryAfter =
    typeof error.retryAfter === "number" ? error.retryAfter : undefined;
  const providerDetail = isRecord(error.provider)
    ? (error.provider as never)
    : undefined;
  return new EyeballError({
    code: error.code as ToolErrorCode,
    message: error.message,
    retryable: error.retryable,
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(providerDetail === undefined ? {} : { providerDetail }),
    ...(typeof body.requestId === "string"
      ? { requestId: body.requestId }
      : {}),
  });
}

function normalizedBaseUrl(value: string, allowInsecureHttp: boolean): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (cause) {
    throw new TypeError("baseUrl must be a valid absolute HTTP(S) URL.", {
      cause,
    });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "baseUrl must be an HTTP(S) URL without credentials, query, or fragment.",
    );
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
  if (url.protocol === "http:" && !loopback && !allowInsecureHttp) {
    throw new TypeError(
      "baseUrl must use HTTPS unless it targets loopback; set allowInsecureHttp only for isolated development transports.",
    );
  }
  return url.toString().replace(/\/+$/u, "");
}

export class EyeballHttpClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    fetchImpl: typeof globalThis.fetch;
    sleep: (milliseconds: number) => Promise<void>;
    allowInsecureHttp?: boolean;
  }) {
    if (options.apiKey.trim().length === 0) {
      throw new TypeError("apiKey must not be empty.");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = normalizedBaseUrl(
      options.baseUrl,
      options.allowInsecureHttp ?? false,
    );
    this.#fetch = options.fetchImpl;
    this.#sleep = options.sleep;
  }

  async request<T>(
    path: string,
    init: Omit<RequestInit, "headers"> & {
      headers?: RequestInit["headers"];
      body?: RequestInit["body"];
    } = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.#apiKey}`);
    if (init.body !== undefined && init.body !== null) {
      headers.set("Content-Type", "application/json");
    }

    const method = (init.method ?? "GET").toUpperCase();
    const retryableRead = method === "GET" || method === "HEAD";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          ...init,
          headers,
        });
      } catch (cause) {
        throw new EyeballError({
          code: TOOL_ERROR_CODES.PROVIDER_UNAVAILABLE,
          message: "The Eyeball executor could not be reached.",
          retryable: true,
          cause,
        });
      }

      const body = parsedBody(await response.text());
      if (response.ok) {
        return body as T;
      }
      const error =
        envelopeError(body) ?? fromHttpStatus(response.status, body);
      if (
        attempt === 0 &&
        retryableRead &&
        response.status === 429 &&
        error.code === TOOL_ERROR_CODES.RATE_LIMITED &&
        error.retryAfter !== undefined
      ) {
        await this.#sleep(error.retryAfter * 1_000);
        continue;
      }
      throw error;
    }
    throw new Error("Unreachable HTTP retry state.");
  }
}

export function errorFromNormalized(value: {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  retryAfter?: number;
  provider?: unknown;
}): EyeballError {
  return new EyeballError({
    code: value.code,
    message: value.message,
    retryable: value.retryable,
    ...(value.retryAfter === undefined ? {} : { retryAfter: value.retryAfter }),
    ...(isRecord(value.provider)
      ? { providerDetail: value.provider as never }
      : {}),
  });
}
