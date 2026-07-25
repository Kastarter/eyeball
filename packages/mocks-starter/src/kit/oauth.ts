import { type Context, Hono } from "hono";
import type { TokenValidationResult } from "./auth.js";
import type { MockClock } from "./clock.js";
import { createIdFactory } from "./id.js";
import type { SnapshotableState } from "./state.js";

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: readonly string[];
  scopes: readonly string[];
}

export interface OAuthSimulationOptions {
  slug: string;
  clock: MockClock;
  clients: readonly OAuthClient[];
  authorizationCodeExpiresInMs?: number;
  accessTokenExpiresInMs?: number;
  refreshTokenExpiresInMs?: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  issued_at: string;
  expires_at: string;
}

export interface OAuthSimulation extends SnapshotableState {
  readonly app: Hono;
  validateAccessToken(token: string): TokenValidationResult;
}

type AuthorizationGrant = {
  code: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  expiresAtMs: number;
  consumed: boolean;
};

type AccessGrant = {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAtMs: number;
  revoked: boolean;
};

type RefreshGrant = {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAtMs: number;
  revoked: boolean;
};

type OAuthSnapshot = {
  codes: AuthorizationGrant[];
  access: AccessGrant[];
  refresh: RefreshGrant[];
  codeIds: unknown;
  accessIds: unknown;
  refreshIds: unknown;
};

const DEFAULT_CODE_EXPIRY_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_EXPIRY_MS = 60 * 60 * 1000;
const DEFAULT_REFRESH_EXPIRY_MS = 24 * 60 * 60 * 1000;

function assertPositiveDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readTokenBody(
  context: Context,
): Promise<Record<string, string>> {
  const contentType = context.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const value: unknown = await context.req.json();
    if (!isObject(value)) {
      throw new Error("OAuth request body must be an object");
    }
    const body: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") {
        body[key] = item;
      }
    }
    return body;
  }

  const parameters = new URLSearchParams(await context.req.text());
  return Object.fromEntries(parameters.entries());
}

function oauthError(
  context: Context,
  error:
    | "invalid_client"
    | "invalid_grant"
    | "invalid_request"
    | "invalid_scope",
  description: string,
  status: 400 | 401 = 400,
): Response {
  return context.json({ error, error_description: description }, status);
}

function uniqueScopes(scope: string): string[] {
  return [...new Set(scope.split(/\s+/u).filter((item) => item.length > 0))];
}

export function createOAuthSimulation(
  options: OAuthSimulationOptions,
): OAuthSimulation {
  if (!/^[a-z][a-z0-9-]*$/u.test(options.slug)) {
    throw new Error("OAuth provider slugs must use lowercase kebab-case");
  }
  if (options.clients.length === 0) {
    throw new Error("OAuth simulation requires at least one fixture client");
  }

  const codeExpiry =
    options.authorizationCodeExpiresInMs ?? DEFAULT_CODE_EXPIRY_MS;
  const accessExpiry =
    options.accessTokenExpiresInMs ?? DEFAULT_ACCESS_EXPIRY_MS;
  const refreshExpiry =
    options.refreshTokenExpiresInMs ?? DEFAULT_REFRESH_EXPIRY_MS;
  assertPositiveDuration(codeExpiry, "authorizationCodeExpiresInMs");
  assertPositiveDuration(accessExpiry, "accessTokenExpiresInMs");
  assertPositiveDuration(refreshExpiry, "refreshTokenExpiresInMs");

  const codeIds = createIdFactory(`code_${options.slug}`);
  const accessIds = createIdFactory(`access_${options.slug}`);
  const refreshIds = createIdFactory(`refresh_${options.slug}`);
  const codes = new Map<string, AuthorizationGrant>();
  const access = new Map<string, AccessGrant>();
  const refresh = new Map<string, RefreshGrant>();
  const app = new Hono();

  function clientFor(clientId: string | undefined): OAuthClient | undefined {
    return options.clients.find((client) => client.clientId === clientId);
  }

  function verifyClient(
    body: Record<string, string>,
    expectedClientId?: string,
  ): OAuthClient | undefined {
    const client = clientFor(body.client_id ?? expectedClientId);
    if (
      client === undefined ||
      (expectedClientId !== undefined && client.clientId !== expectedClientId)
    ) {
      return undefined;
    }
    if (
      client.clientSecret !== undefined &&
      body.client_secret !== client.clientSecret
    ) {
      return undefined;
    }
    return client;
  }

  function issueTokens(clientId: string, scopes: string[]): OAuthTokenResponse {
    const nowMs = options.clock.now().getTime();
    const issuedAt = options.clock.nowIso();
    const accessToken = accessIds.next();
    const refreshToken = refreshIds.next();
    access.set(accessToken, {
      token: accessToken,
      clientId,
      scopes: [...scopes],
      expiresAtMs: nowMs + accessExpiry,
      revoked: false,
    });
    refresh.set(refreshToken, {
      token: refreshToken,
      clientId,
      scopes: [...scopes],
      expiresAtMs: nowMs + refreshExpiry,
      revoked: false,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: Math.floor(accessExpiry / 1000),
      scope: scopes.join(" "),
      issued_at: issuedAt,
      expires_at: new Date(nowMs + accessExpiry).toISOString(),
    };
  }

  async function exchangeToken(
    context: Context,
    forceRefresh = false,
  ): Promise<Response> {
    let body: Record<string, string>;
    try {
      body = await readTokenBody(context);
    } catch {
      return oauthError(
        context,
        "invalid_request",
        "The token request body is invalid.",
      );
    }

    const grantType = forceRefresh ? "refresh_token" : body.grant_type;
    if (grantType === "authorization_code") {
      const grant = body.code === undefined ? undefined : codes.get(body.code);
      if (
        grant === undefined ||
        grant.consumed ||
        grant.expiresAtMs <= options.clock.now().getTime() ||
        body.redirect_uri !== grant.redirectUri
      ) {
        return oauthError(
          context,
          "invalid_grant",
          "The authorization code is invalid or expired.",
        );
      }
      const client = verifyClient(body, grant.clientId);
      if (client === undefined) {
        return oauthError(
          context,
          "invalid_client",
          "The OAuth client is invalid.",
          401,
        );
      }
      grant.consumed = true;
      return context.json(issueTokens(client.clientId, grant.scopes));
    }

    if (grantType === "refresh_token") {
      const grant =
        body.refresh_token === undefined
          ? undefined
          : refresh.get(body.refresh_token);
      if (
        grant === undefined ||
        grant.revoked ||
        grant.expiresAtMs <= options.clock.now().getTime()
      ) {
        return oauthError(
          context,
          "invalid_grant",
          "The refresh token is invalid or expired.",
        );
      }
      const client = verifyClient(body, grant.clientId);
      if (client === undefined) {
        return oauthError(
          context,
          "invalid_client",
          "The OAuth client is invalid.",
          401,
        );
      }
      grant.revoked = true;
      return context.json(issueTokens(client.clientId, grant.scopes));
    }

    return oauthError(
      context,
      "invalid_request",
      "The grant_type is not supported.",
    );
  }

  app.get("/authorize", (context) => {
    const responseType = context.req.query("response_type");
    const clientId = context.req.query("client_id");
    const redirectUri = context.req.query("redirect_uri");
    const state = context.req.query("state");
    const client = clientFor(clientId);

    if (
      responseType !== "code" ||
      client === undefined ||
      redirectUri === undefined ||
      !client.redirectUris.includes(redirectUri) ||
      state === undefined ||
      state.length === 0
    ) {
      return oauthError(
        context,
        "invalid_request",
        "The authorization request is invalid.",
      );
    }

    const requestedScopes = context.req.query("scope");
    const scopes =
      requestedScopes === undefined
        ? [...client.scopes]
        : uniqueScopes(requestedScopes);
    if (scopes.some((scope) => !client.scopes.includes(scope))) {
      return oauthError(
        context,
        "invalid_scope",
        "One or more requested scopes are not allowed.",
      );
    }

    const code = codeIds.next();
    codes.set(code, {
      code,
      clientId: client.clientId,
      redirectUri,
      scopes,
      expiresAtMs: options.clock.now().getTime() + codeExpiry,
      consumed: false,
    });

    const location = new URL(redirectUri);
    location.searchParams.set("code", code);
    location.searchParams.set("state", state);
    return context.redirect(location.toString(), 302);
  });

  app.post("/token", (context) => exchangeToken(context));
  app.post("/refresh", (context) => exchangeToken(context, true));
  app.post("/revoke", async (context) => {
    let body: Record<string, string>;
    try {
      body = await readTokenBody(context);
    } catch {
      return oauthError(
        context,
        "invalid_request",
        "The revocation request body is invalid.",
      );
    }
    const token = body.token;
    if (token === undefined) {
      return oauthError(context, "invalid_request", "A token is required.");
    }
    const accessGrant = access.get(token);
    const refreshGrant = refresh.get(token);
    if (accessGrant !== undefined) {
      accessGrant.revoked = true;
    }
    if (refreshGrant !== undefined) {
      refreshGrant.revoked = true;
    }
    return context.json({ revoked: true });
  });

  return {
    app,
    validateAccessToken(token) {
      if (!token.startsWith(`access_${options.slug}_`)) {
        return "valid";
      }
      const grant = access.get(token);
      if (grant === undefined || grant.revoked) {
        return "invalid";
      }
      return grant.expiresAtMs <= options.clock.now().getTime()
        ? "expired"
        : "valid";
    },
    reset() {
      codes.clear();
      access.clear();
      refresh.clear();
      codeIds.reset();
      accessIds.reset();
      refreshIds.reset();
    },
    snapshot(): OAuthSnapshot {
      return {
        codes: structuredClone([...codes.values()]),
        access: structuredClone([...access.values()]),
        refresh: structuredClone([...refresh.values()]),
        codeIds: codeIds.snapshot(),
        accessIds: accessIds.snapshot(),
        refreshIds: refreshIds.snapshot(),
      };
    },
    restore(snapshot) {
      const value = snapshot as OAuthSnapshot;
      if (
        !Array.isArray(value.codes) ||
        !Array.isArray(value.access) ||
        !Array.isArray(value.refresh)
      ) {
        throw new Error("Invalid OAuth snapshot");
      }
      codes.clear();
      access.clear();
      refresh.clear();
      for (const grant of value.codes) {
        codes.set(grant.code, structuredClone(grant));
      }
      for (const grant of value.access) {
        access.set(grant.token, structuredClone(grant));
      }
      for (const grant of value.refresh) {
        refresh.set(grant.token, structuredClone(grant));
      }
      codeIds.restore(value.codeIds);
      accessIds.restore(value.accessIds);
      refreshIds.restore(value.refreshIds);
    },
  };
}
