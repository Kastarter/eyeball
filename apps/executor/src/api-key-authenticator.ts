import { createHash } from "node:crypto";
import {
  type ApiKeyPrincipal,
  type ApiKeyringInput,
  materializeApiKeyring,
  parseApiKeyring,
} from "@eyeball/core";

export interface ApiKeyAuthenticationSuccess extends ApiKeyPrincipal {
  readonly valid: true;
}

export interface ApiKeyAuthenticationFailure {
  readonly valid: false;
}

export type ApiKeyAuthenticationResult =
  | ApiKeyAuthenticationSuccess
  | ApiKeyAuthenticationFailure;

export interface ApiKeyAuthenticator {
  verify(key: string): Promise<ApiKeyAuthenticationResult>;
}

export interface RemoteKeyAuthenticatorOptions {
  endpoint: string;
  internalApiSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  timeoutMs?: number;
  maxCacheEntries?: number;
}

export interface ConfiguredApiKeyAuthenticatorOptions {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CachedAuthentication {
  readonly expiresAt: number;
  readonly result: ApiKeyAuthenticationResult;
}

const DEFAULT_POSITIVE_TTL_MS = 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CACHE_ENTRIES = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024;
const MAX_KEY_CHARACTERS = 1_024;

const INVALID_RESULT: ApiKeyAuthenticationFailure = Object.freeze({
  valid: false,
});

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function remoteEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("EYEBALL_KEY_VERIFY_URL must be a valid absolute URL.");
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
      "EYEBALL_KEY_VERIFY_URL must use HTTPS without credentials, a query, or a fragment (HTTP is allowed only for loopback development).",
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

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function durationFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be an integer number of milliseconds.`);
  }
  return Number(raw);
}

function internalApiSecret(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const value = env.EYEBALL_INTERNAL_API_SECRET?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(
      "EYEBALL_INTERNAL_API_SECRET is required when EYEBALL_KEY_VERIFY_URL is configured.",
    );
  }
  return value;
}

function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function unavailable(): Error {
  return new Error("The remote API-key verifier is unavailable.");
}

async function responseJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    throw unavailable();
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw unavailable();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw unavailable();
  }
}

function authenticationResult(value: unknown): ApiKeyAuthenticationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unavailable();
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.valid === false) return INVALID_RESULT;
  if (
    candidate.valid !== true ||
    typeof candidate.projectId !== "string" ||
    candidate.projectId.trim().length === 0 ||
    (candidate.userId !== undefined &&
      (typeof candidate.userId !== "string" ||
        candidate.userId.trim().length === 0))
  ) {
    throw unavailable();
  }
  return Object.freeze({
    valid: true,
    projectId: candidate.projectId,
    ...(candidate.userId === undefined ? {} : { userId: candidate.userId }),
  });
}

/** Preserves the existing in-process `EYEBALL_API_KEYS` behavior. */
export class StaticKeyringAuthenticator implements ApiKeyAuthenticator {
  readonly #keyring: ReadonlyMap<string, ApiKeyPrincipal>;

  constructor(apiKeys: ApiKeyringInput) {
    this.#keyring = materializeApiKeyring(apiKeys);
  }

  async verify(key: string): Promise<ApiKeyAuthenticationResult> {
    const principal = this.#keyring.get(key);
    if (principal === undefined) return INVALID_RESULT;
    return {
      valid: true,
      projectId: principal.projectId,
      ...(principal.userId === undefined ? {} : { userId: principal.userId }),
    };
  }
}

/** Tries authenticators in order and returns the first valid principal. */
export class CompositeApiKeyAuthenticator implements ApiKeyAuthenticator {
  readonly #authenticators: readonly ApiKeyAuthenticator[];

  constructor(authenticators: readonly ApiKeyAuthenticator[]) {
    if (authenticators.length === 0) {
      throw new Error("At least one API-key authenticator is required.");
    }
    this.#authenticators = [...authenticators];
  }

  async verify(key: string): Promise<ApiKeyAuthenticationResult> {
    for (const authenticator of this.#authenticators) {
      const result = await authenticator.verify(key);
      if (result.valid) return result;
    }
    return INVALID_RESULT;
  }
}

/** HTTP verifier for keys issued and revoked by Eyeball Cloud. */
export class RemoteKeyAuthenticator implements ApiKeyAuthenticator {
  readonly #endpoint: URL;
  readonly #internalApiSecret: string;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => number;
  readonly #positiveTtlMs: number;
  readonly #negativeTtlMs: number;
  readonly #timeoutMs: number;
  readonly #maxCacheEntries: number;
  readonly #cache = new Map<string, CachedAuthentication>();
  readonly #inFlight = new Map<string, Promise<ApiKeyAuthenticationResult>>();

  constructor(options: RemoteKeyAuthenticatorOptions) {
    if (options.internalApiSecret.length < 32) {
      throw new Error(
        "EYEBALL_INTERNAL_API_SECRET must contain at least 32 characters.",
      );
    }
    const positiveTtlMs = positiveInteger(
      options.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS,
      "Remote API-key positive cache TTL",
    );
    const negativeTtlMs = nonNegativeInteger(
      options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS,
      "Remote API-key negative cache TTL",
    );
    if (negativeTtlMs >= positiveTtlMs) {
      throw new Error(
        "Remote API-key negative cache TTL must be shorter than the positive cache TTL.",
      );
    }
    this.#endpoint = remoteEndpoint(options.endpoint);
    this.#internalApiSecret = options.internalApiSecret;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#positiveTtlMs = positiveTtlMs;
    this.#negativeTtlMs = negativeTtlMs;
    this.#timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Remote API-key request timeout",
    );
    this.#maxCacheEntries = positiveInteger(
      options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
      "Remote API-key cache entry limit",
    );
  }

  async verify(key: string): Promise<ApiKeyAuthenticationResult> {
    if (key.length === 0 || key.length > MAX_KEY_CHARACTERS) {
      return INVALID_RESULT;
    }
    const hash = keyHash(key);
    const cached = this.#cache.get(hash);
    if (cached !== undefined) {
      if (cached.expiresAt > this.#now()) return cached.result;
      this.#cache.delete(hash);
    }
    const existing = this.#inFlight.get(hash);
    if (existing !== undefined) return existing;

    const pending = this.#request(key)
      .then((result) => {
        this.#cacheResult(hash, result);
        return result;
      })
      .finally(() => {
        this.#inFlight.delete(hash);
      });
    this.#inFlight.set(hash, pending);
    return pending;
  }

  async #request(key: string): Promise<ApiKeyAuthenticationResult> {
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
        body: JSON.stringify({ key }),
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) throw unavailable();
    return authenticationResult(await responseJson(response));
  }

  #cacheResult(hash: string, result: ApiKeyAuthenticationResult): void {
    const ttl = result.valid ? this.#positiveTtlMs : this.#negativeTtlMs;
    if (ttl === 0) return;
    this.#cache.delete(hash);
    if (this.#cache.size >= this.#maxCacheEntries) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(hash, { result, expiresAt: this.#now() + ttl });
  }
}

export function createConfiguredApiKeyAuthenticator(
  options: ConfiguredApiKeyAuthenticatorOptions = {},
): ApiKeyAuthenticator {
  const env = options.env ?? process.env;
  const authenticators: ApiKeyAuthenticator[] = [
    new StaticKeyringAuthenticator(parseApiKeyring(env.EYEBALL_API_KEYS)),
  ];
  const endpoint = env.EYEBALL_KEY_VERIFY_URL?.trim();
  if (endpoint !== undefined && endpoint.length > 0) {
    authenticators.push(
      new RemoteKeyAuthenticator({
        endpoint,
        internalApiSecret: internalApiSecret(env),
        positiveTtlMs: durationFromEnvironment(
          env,
          "EYEBALL_KEY_VERIFY_POSITIVE_TTL_MS",
          DEFAULT_POSITIVE_TTL_MS,
        ),
        negativeTtlMs: durationFromEnvironment(
          env,
          "EYEBALL_KEY_VERIFY_NEGATIVE_TTL_MS",
          DEFAULT_NEGATIVE_TTL_MS,
        ),
        ...(options.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
    );
  }
  return authenticators.length === 1
    ? (authenticators[0] as ApiKeyAuthenticator)
    : new CompositeApiKeyAuthenticator(authenticators);
}
