import type { ConnectionId } from "./types/execution.js";
import type { ToolkitSlug } from "./types/tool.js";

export interface CredentialContext {
  projectId: string;
  userId: string;
  toolkitSlug: ToolkitSlug;
  connectionId?: ConnectionId;
}

export interface ResolvedCredentialBase {
  /** Actual selected connection; omitted only by local `none`/legacy env fixtures. */
  connectionId?: ConnectionId;
  expiresAt?: string;
  scopes?: readonly string[];
}

export interface OAuth2Credential extends ResolvedCredentialBase {
  type: "oauth2";
  accessToken: string;
  tokenType?: string;
}

export interface ApiKeyCredential extends ResolvedCredentialBase {
  type: "api_key";
  /** Named tuple; the adapter owns placement and signing. */
  values: Readonly<Record<string, string>>;
}

export interface BasicCredential extends ResolvedCredentialBase {
  type: "basic";
  username: string;
  password: string;
  parameters?: Readonly<Record<string, string>>;
}

export interface NoCredential extends ResolvedCredentialBase {
  type: "none";
}

export type ResolvedCredential =
  | OAuth2Credential
  | ApiKeyCredential
  | BasicCredential
  | NoCredential;

export type CredentialRefreshReason =
  | "expiring"
  | "expired"
  | "provider_unauthorized";

export type CredentialProviderErrorCode =
  | "auth_missing"
  | "auth_expired"
  | "auth_insufficient_scope"
  | "provider_unavailable";

export interface CredentialProviderErrorOptions {
  code: CredentialProviderErrorCode;
  message: string;
  retryable: boolean;
  retryAfter?: number;
  cause?: unknown;
}

export class CredentialProviderError extends Error {
  readonly code: CredentialProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfter?: number;

  constructor(options: CredentialProviderErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "CredentialProviderError";
    this.code = options.code;
    this.retryable = options.retryable;

    if (options.retryAfter !== undefined) {
      if (!Number.isFinite(options.retryAfter) || options.retryAfter < 0) {
        throw new RangeError(
          "retryAfter must be a non-negative number of seconds",
        );
      }
      this.retryAfter = options.retryAfter;
    }
  }
}

export interface CredentialRefreshContext extends CredentialContext {
  current: OAuth2Credential;
  reason: CredentialRefreshReason;
}

export interface CredentialProvider {
  readonly kind: "env" | "mock" | "local-vault" | "cloud";
  /** Verifies provider-wide configuration without resolving a user's secret. */
  checkReadiness?(signal?: AbortSignal): Promise<void>;
  resolve(context: CredentialContext): Promise<ResolvedCredential>;
  refresh?(context: CredentialRefreshContext): Promise<OAuth2Credential>;
  invalidate?(context: CredentialContext): Promise<void>;
}

export type EnvCredentialMapping =
  | {
      type: "oauth2";
      accessTokenEnv: string;
      expiresAtEnv?: string;
      scopesEnv?: string;
    }
  | { type: "api_key"; valueEnvs: Readonly<Record<string, string>> }
  | {
      type: "basic";
      usernameEnv: string;
      passwordEnv: string;
      parameterEnvs?: Readonly<Record<string, string>>;
    }
  | { type: "none" };

export interface EnvCredentialProviderOptions {
  mappings: Readonly<Record<ToolkitSlug, EnvCredentialMapping>>;
  env?: Readonly<Record<string, string | undefined>>;
  /** The only project allowed to resolve these process-wide credentials. */
  allowedProjectId: string;
  /** The only external user allowed within that project. */
  allowedUserId: string;
}

const TOOLKIT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function credentialEnvPrefix(toolkitSlug: ToolkitSlug): string {
  if (!TOOLKIT_SLUG_PATTERN.test(toolkitSlug)) {
    throw new Error(`Invalid toolkit slug: ${toolkitSlug}`);
  }
  return `EYEBALL_CRED_${toolkitSlug.toUpperCase().replaceAll("-", "_")}_`;
}

function mappingEnvNames(mapping: EnvCredentialMapping): readonly string[] {
  switch (mapping.type) {
    case "oauth2":
      return [
        mapping.accessTokenEnv,
        ...(mapping.expiresAtEnv === undefined ? [] : [mapping.expiresAtEnv]),
        ...(mapping.scopesEnv === undefined ? [] : [mapping.scopesEnv]),
      ];
    case "api_key":
      return Object.values(mapping.valueEnvs);
    case "basic":
      return [
        mapping.usernameEnv,
        mapping.passwordEnv,
        ...Object.values(mapping.parameterEnvs ?? {}),
      ];
    case "none":
      return [];
  }
}

function authMissing(message: string): CredentialProviderError {
  return new CredentialProviderError({
    code: "auth_missing",
    message,
    retryable: false,
  });
}

function readRequiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  envName: string,
  toolkitSlug: string,
): string {
  const value = env[envName];
  if (value === undefined || value.length === 0) {
    throw authMissing(`No usable ${toolkitSlug} credential is configured.`);
  }
  return value;
}

function readNamedValues(
  env: Readonly<Record<string, string | undefined>>,
  mappings: Readonly<Record<string, string>>,
  toolkitSlug: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(mappings).map(([field, envName]) => [
      field,
      readRequiredEnv(env, envName, toolkitSlug),
    ]),
  );
}

function parseScopes(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return value.split(/[\s,]+/u).filter((scope) => scope.length > 0);
}

export class EnvCredentialProvider implements CredentialProvider {
  readonly kind = "env" as const;
  readonly #mappings: Readonly<Record<ToolkitSlug, EnvCredentialMapping>>;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #allowedProjectId: string;
  readonly #allowedUserId: string;

  constructor(options: EnvCredentialProviderOptions) {
    this.#mappings = options.mappings;
    this.#env = options.env ?? process.env;
    this.#allowedProjectId = options.allowedProjectId;
    this.#allowedUserId = options.allowedUserId;

    for (const [toolkitSlug, mapping] of Object.entries(options.mappings)) {
      const prefix = credentialEnvPrefix(toolkitSlug);
      for (const envName of mappingEnvNames(mapping)) {
        if (!envName.startsWith(prefix)) {
          throw new Error(
            `Credential environment variable ${envName} must use the ${prefix}* convention.`,
          );
        }
      }
    }
  }

  async checkReadiness(): Promise<void> {
    if (
      this.#allowedProjectId.trim().length === 0 ||
      this.#allowedUserId.trim().length === 0
    ) {
      throw new Error(
        "Environment credential provider scope IDs must not be empty.",
      );
    }
  }

  async resolve(context: CredentialContext): Promise<ResolvedCredential> {
    if (
      context.projectId !== this.#allowedProjectId ||
      context.userId !== this.#allowedUserId
    ) {
      throw authMissing(
        "No usable connection exists for this project and user.",
      );
    }
    if (context.connectionId !== undefined) {
      throw authMissing(
        "Environment credentials do not provide named connection records.",
      );
    }

    const mapping = this.#mappings[context.toolkitSlug];
    if (mapping === undefined) {
      throw authMissing(
        `No usable ${context.toolkitSlug} credential is configured.`,
      );
    }

    switch (mapping.type) {
      case "oauth2": {
        const accessToken = readRequiredEnv(
          this.#env,
          mapping.accessTokenEnv,
          context.toolkitSlug,
        );
        const expiresAt =
          mapping.expiresAtEnv === undefined
            ? undefined
            : this.#env[mapping.expiresAtEnv];
        if (expiresAt !== undefined) {
          const expiry = Date.parse(expiresAt);
          if (Number.isNaN(expiry) || expiry <= Date.now()) {
            throw new CredentialProviderError({
              code: "auth_expired",
              message: `The configured ${context.toolkitSlug} credential is expired.`,
              retryable: false,
            });
          }
        }
        const scopes = parseScopes(
          mapping.scopesEnv === undefined
            ? undefined
            : this.#env[mapping.scopesEnv],
        );
        return {
          type: "oauth2",
          accessToken,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(scopes === undefined ? {} : { scopes }),
        };
      }
      case "api_key":
        return {
          type: "api_key",
          values: readNamedValues(
            this.#env,
            mapping.valueEnvs,
            context.toolkitSlug,
          ),
        };
      case "basic": {
        const parameters =
          mapping.parameterEnvs === undefined
            ? undefined
            : readNamedValues(
                this.#env,
                mapping.parameterEnvs,
                context.toolkitSlug,
              );
        return {
          type: "basic",
          username: readRequiredEnv(
            this.#env,
            mapping.usernameEnv,
            context.toolkitSlug,
          ),
          password: readRequiredEnv(
            this.#env,
            mapping.passwordEnv,
            context.toolkitSlug,
          ),
          ...(parameters === undefined ? {} : { parameters }),
        };
      }
      case "none":
        return { type: "none" };
    }
  }
}

export interface MockCredentialFixture {
  match: CredentialContext;
  credential: ResolvedCredential;
  refreshTo?: OAuth2Credential;
}

export const MOCK_CREDENTIAL_TRIGGER_TOKENS = {
  EXPIRED_TOKEN: "fixture:EXPIRED_TOKEN",
  INSUFFICIENT_SCOPE_TOKEN: "fixture:INSUFFICIENT_SCOPE_TOKEN",
  RATE_LIMITED_TOKEN: "fixture:RATE_LIMITED_TOKEN",
} as const;

export type MockCredentialTriggerToken =
  (typeof MOCK_CREDENTIAL_TRIGGER_TOKENS)[keyof typeof MOCK_CREDENTIAL_TRIGGER_TOKENS];

function assertFixtureSecret(value: string, description: string): void {
  if (!value.startsWith("fixture:")) {
    throw new Error(`${description} must start with fixture:.`);
  }
}

function assertFixtureCredential(credential: ResolvedCredential): void {
  switch (credential.type) {
    case "oauth2":
      assertFixtureSecret(credential.accessToken, "Mock OAuth2 access token");
      break;
    case "api_key":
      for (const [field, value] of Object.entries(credential.values)) {
        assertFixtureSecret(value, `Mock API key field ${field}`);
      }
      break;
    case "basic":
      assertFixtureSecret(credential.password, "Mock Basic password");
      break;
    case "none":
      break;
  }
}

function cloneCredential(credential: ResolvedCredential): ResolvedCredential {
  switch (credential.type) {
    case "oauth2":
      return {
        ...credential,
        ...(credential.scopes === undefined
          ? {}
          : { scopes: [...credential.scopes] }),
      };
    case "api_key":
      return { ...credential, values: { ...credential.values } };
    case "basic":
      return {
        ...credential,
        ...(credential.parameters === undefined
          ? {}
          : { parameters: { ...credential.parameters } }),
      };
    case "none":
      return { ...credential };
  }
}

function baseMatch(
  fixture: MockCredentialFixture,
  context: CredentialContext,
): boolean {
  return (
    fixture.match.projectId === context.projectId &&
    fixture.match.userId === context.userId &&
    fixture.match.toolkitSlug === context.toolkitSlug
  );
}

export class MockCredentialProvider implements CredentialProvider {
  readonly kind = "mock" as const;
  readonly #fixtures: readonly MockCredentialFixture[];

  constructor(fixtures: readonly MockCredentialFixture[]) {
    for (const fixture of fixtures) {
      assertFixtureCredential(fixture.credential);
      if (fixture.refreshTo !== undefined) {
        assertFixtureCredential(fixture.refreshTo);
      }
      if (
        fixture.credential.connectionId !== undefined &&
        fixture.credential.connectionId !== fixture.match.connectionId
      ) {
        throw new Error(
          "Mock fixture match and credential connection IDs differ.",
        );
      }
      if (
        fixture.refreshTo?.connectionId !== undefined &&
        fixture.refreshTo.connectionId !== fixture.match.connectionId
      ) {
        throw new Error(
          "Mock fixture match and refresh credential connection IDs differ.",
        );
      }
    }
    this.#fixtures = [...fixtures];
  }

  async checkReadiness(): Promise<void> {}

  #candidates(context: CredentialContext): readonly MockCredentialFixture[] {
    return this.#fixtures.filter((fixture) => baseMatch(fixture, context));
  }

  #select(context: CredentialContext): MockCredentialFixture {
    const candidates = this.#candidates(context);
    if (context.connectionId !== undefined) {
      const matches = candidates.filter(
        (fixture) => fixture.match.connectionId === context.connectionId,
      );
      if (matches.length === 1 && matches[0] !== undefined) {
        return matches[0];
      }
      throw authMissing("No usable mock connection exists for this context.");
    }

    if (candidates.length === 1 && candidates[0] !== undefined) {
      return candidates[0];
    }
    const defaults = candidates.filter(
      (fixture) => fixture.match.connectionId === undefined,
    );
    if (defaults.length === 1 && defaults[0] !== undefined) {
      return defaults[0];
    }
    throw authMissing(
      "No unambiguous mock connection exists for this context.",
    );
  }

  async resolve(context: CredentialContext): Promise<ResolvedCredential> {
    const fixture = this.#select(context);
    const credential = cloneCredential(fixture.credential);
    return fixture.match.connectionId === undefined
      ? credential
      : { ...credential, connectionId: fixture.match.connectionId };
  }

  async refresh(context: CredentialRefreshContext): Promise<OAuth2Credential> {
    const selectedConnectionId =
      context.connectionId ?? context.current.connectionId;
    const candidates = this.#candidates(context).filter(
      (fixture) =>
        fixture.credential.type === "oauth2" &&
        fixture.credential.accessToken === context.current.accessToken &&
        (selectedConnectionId === undefined ||
          fixture.match.connectionId === selectedConnectionId),
    );
    const fixture = candidates.length === 1 ? candidates[0] : undefined;
    if (fixture?.refreshTo === undefined) {
      throw new CredentialProviderError({
        code: "auth_expired",
        message: "The mock OAuth2 credential cannot be refreshed.",
        retryable: false,
      });
    }
    const refreshed = cloneCredential(fixture.refreshTo) as OAuth2Credential;
    return fixture.match.connectionId === undefined
      ? refreshed
      : { ...refreshed, connectionId: fixture.match.connectionId };
  }
}

/** Public contract implemented by the executor's hosted HTTP client. */
export interface CloudCredentialProvider extends CredentialProvider {
  readonly kind: "cloud";
}

/** Compatibility placeholder; stock hosted composition lives in `@eyeball/executor`. */
export class CloudCredentialProviderStub implements CloudCredentialProvider {
  readonly kind = "cloud" as const;

  async checkReadiness(): Promise<void> {
    throw new Error("The cloud credential provider is not configured.");
  }

  async resolve(_context: CredentialContext): Promise<ResolvedCredential> {
    throw new Error(
      "not_implemented: configure the executor RemoteCredentialProvider with EYEBALL_CREDENTIALS=cloud.",
    );
  }
}
