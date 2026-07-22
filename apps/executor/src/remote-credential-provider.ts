import {
  type ConnectionId,
  type CredentialContext,
  type CredentialProvider,
  CredentialProviderError,
  type CredentialProviderErrorCode,
  isConnectionId,
  type ResolvedCredential,
} from "@eyeball/core";

export interface RemoteCredentialProviderOptions {
  endpoint: string;
  internalApiSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const READINESS_SENTINEL = {
  projectId: "__eyeball_readiness_probe__",
  userId: "eyeball-readiness-probe",
  toolkit: "eyeball-readiness-probe",
  connectionId: "__eyeball_readiness_probe__",
} as const;
const ERROR_CODES = new Set<CredentialProviderErrorCode>([
  "auth_missing",
  "auth_expired",
  "auth_insufficient_scope",
  "provider_unavailable",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined | null {
  return value === undefined ? undefined : (requiredString(value) ?? null);
}

function optionalScopes(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((scope) => typeof scope !== "string" || scope.length === 0)
  ) {
    return null;
  }
  return [...value];
}

interface ParsedCredentialBase {
  connectionId?: ConnectionId;
  expiresAt?: string;
  scopes?: readonly string[];
}

function invalidResponse(): CredentialProviderError {
  return new CredentialProviderError({
    code: "provider_unavailable",
    message: "The cloud credential service returned an invalid response.",
    retryable: true,
  });
}

function parseBase(value: Record<string, unknown>): ParsedCredentialBase {
  const connectionId = optionalString(value.connectionId);
  const expiresAt = optionalString(value.expiresAt);
  const scopes = optionalScopes(value.scopes);
  if (
    connectionId === null ||
    (connectionId !== undefined && !isConnectionId(connectionId)) ||
    expiresAt === null ||
    scopes === null ||
    (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt)))
  ) {
    throw invalidResponse();
  }
  return {
    ...(connectionId === undefined
      ? {}
      : { connectionId: connectionId as ConnectionId }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(scopes === undefined ? {} : { scopes }),
  };
}

/** Parses only the public `ResolvedCredential` union and drops unknown fields. */
export function parseRemoteResolvedCredential(
  value: unknown,
): ResolvedCredential {
  if (!isObject(value)) throw invalidResponse();
  const base = parseBase(value);
  switch (value.type) {
    case "oauth2": {
      const accessToken = requiredString(value.accessToken);
      const tokenType = optionalString(value.tokenType);
      if (accessToken === undefined || tokenType === null) {
        throw invalidResponse();
      }
      return {
        type: "oauth2",
        accessToken,
        ...base,
        ...(tokenType === undefined ? {} : { tokenType }),
      };
    }
    case "api_key": {
      if (!isObject(value.values)) throw invalidResponse();
      const entries = Object.entries(value.values);
      if (
        entries.length === 0 ||
        entries.some(
          ([field, entry]) =>
            field.length === 0 ||
            typeof entry !== "string" ||
            entry.length === 0,
        )
      ) {
        throw invalidResponse();
      }
      return {
        type: "api_key",
        values: Object.fromEntries(entries) as Readonly<Record<string, string>>,
        ...base,
      };
    }
    case "basic": {
      const username = requiredString(value.username);
      const password = requiredString(value.password);
      if (username === undefined || password === undefined) {
        throw invalidResponse();
      }
      let parameters: Readonly<Record<string, string>> | undefined;
      if (value.parameters !== undefined) {
        if (!isObject(value.parameters)) throw invalidResponse();
        const entries = Object.entries(value.parameters);
        if (
          entries.some(
            ([field, entry]) =>
              field.length === 0 ||
              typeof entry !== "string" ||
              entry.length === 0,
          )
        ) {
          throw invalidResponse();
        }
        parameters = Object.fromEntries(entries) as Readonly<
          Record<string, string>
        >;
      }
      return {
        type: "basic",
        username,
        password,
        ...base,
        ...(parameters === undefined ? {} : { parameters }),
      };
    }
    case "none":
      return { type: "none", ...base };
    default:
      throw invalidResponse();
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function credentialEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("EYEBALL_CREDENTIALS_URL must be a valid absolute URL.");
  }
  if (
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" && isLoopbackHostname(endpoint.hostname)
      )) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error(
      "EYEBALL_CREDENTIALS_URL must use HTTPS without credentials, a query, or a fragment (HTTP is allowed only for loopback development).",
    );
  }
  return endpoint;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function responseError(
  value: unknown,
  status: number,
): CredentialProviderError {
  const candidate =
    isObject(value) && isObject(value.error) ? value.error.code : undefined;
  const code =
    typeof candidate === "string" &&
    ERROR_CODES.has(candidate as CredentialProviderErrorCode)
      ? (candidate as CredentialProviderErrorCode)
      : status >= 500
        ? "provider_unavailable"
        : "auth_missing";
  return new CredentialProviderError({
    code,
    message:
      code === "provider_unavailable"
        ? "The cloud credential service is temporarily unavailable."
        : code === "auth_expired"
          ? "The selected cloud connection must be reauthorized."
          : code === "auth_insufficient_scope"
            ? "The selected cloud connection lacks a required scope."
            : "No usable cloud connection exists for this context.",
    retryable: code === "provider_unavailable",
  });
}

async function responseJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    throw invalidResponse();
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw invalidResponse();
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw invalidResponse();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse();
  }
}

/** Executor-owned HTTP client for the Eyeball Cloud credential bridge. */
export class RemoteCredentialProvider implements CredentialProvider {
  readonly kind = "cloud" as const;
  readonly #endpoint: URL;
  readonly #internalApiSecret: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: RemoteCredentialProviderOptions) {
    if (options.internalApiSecret.length < 32) {
      throw new Error(
        "EYEBALL_INTERNAL_API_SECRET must contain at least 32 characters.",
      );
    }
    this.#endpoint = credentialEndpoint(options.endpoint);
    this.#internalApiSecret = options.internalApiSecret;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Cloud credential request timeout",
    );
  }

  async checkReadiness(signal?: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetchImpl(this.#endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#internalApiSecret}`,
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(READINESS_SENTINEL),
        cache: "no-store",
        redirect: "manual",
        signal:
          signal === undefined
            ? AbortSignal.timeout(this.#timeoutMs)
            : AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
      });
    } catch {
      throw new Error("The cloud credential endpoint could not be reached.");
    }
    const body = await responseJson(response);
    if (
      response.status !== 404 ||
      !isObject(body) ||
      !isObject(body.error) ||
      body.error.code !== "auth_missing"
    ) {
      throw new Error(
        "The cloud credential endpoint did not accept the readiness probe.",
      );
    }
  }

  async resolve(context: CredentialContext): Promise<ResolvedCredential> {
    let response: Response;
    try {
      response = await this.#fetchImpl(this.#endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#internalApiSecret}`,
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: context.projectId,
          userId: context.userId,
          toolkit: context.toolkitSlug,
          ...(context.connectionId === undefined
            ? {}
            : { connectionId: context.connectionId }),
        }),
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new CredentialProviderError({
        code: "provider_unavailable",
        message: "The cloud credential service could not be reached.",
        retryable: true,
      });
    }
    const body = await responseJson(response);
    if (!response.ok) throw responseError(body, response.status);
    return parseRemoteResolvedCredential(body);
  }
}
