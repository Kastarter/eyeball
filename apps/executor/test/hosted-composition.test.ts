import type { ApiKeyPrincipal } from "@eyeball/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createGmailMock } from "../../../mocks/packages/mocks-email/dist/index.js";
import {
  createConfiguredApiKeyAuthenticator,
  createExecutorApp,
  createExecutorRuntime,
  createJsonLineLogger,
  RemoteKeyAuthenticator,
} from "../src/index.js";

const INTERNAL_API_SECRET =
  "hosted-composition-test-internal-secret-32-characters";
const KEY_VERIFY_URL = "https://cloud.example.test/internal/keys/verify";
const CREDENTIALS_URL =
  "https://cloud.example.test/internal/credentials/resolve";
const REMOTE_KEY = "eb_live_remote_executor_key";
const STATIC_KEY = "ey_static_executor_key";
const VOICE_GRANT_SECRET = "voice-session-grant-test-secret-at-least-32-bytes";

interface VerifyRequest {
  authorization?: string;
  cacheControl?: string;
  key: string;
}

function inProcessFetch(app: Hono): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    app.request(new Request(input, init))) as typeof fetch;
}

function createKeyCloud() {
  const app = new Hono();
  const principals = new Map<string, ApiKeyPrincipal>();
  const requests: VerifyRequest[] = [];
  app.post("/internal/keys/verify", async (context) => {
    const body = (await context.req.json()) as { key: string };
    requests.push({
      key: body.key,
      ...(context.req.header("Authorization") === undefined
        ? {}
        : { authorization: context.req.header("Authorization") }),
      ...(context.req.header("Cache-Control") === undefined
        ? {}
        : { cacheControl: context.req.header("Cache-Control") }),
    });
    const principal = principals.get(body.key);
    return principal === undefined
      ? context.json({ valid: false })
      : context.json({ valid: true, ...principal });
  });
  return { app, principals, requests };
}

function subscriptions(
  app: ReturnType<typeof createExecutorApp>,
  key: string,
  userId?: string,
): Promise<Response> {
  return app.request("/v1/subscriptions", {
    headers: {
      Authorization: `Bearer ${key}`,
      ...(userId === undefined ? {} : { "X-Eyeball-User-Id": userId }),
    },
  });
}

describe("hosted API-key composition", () => {
  it("preserves static EYEBALL_API_KEYS authentication", async () => {
    const app = createExecutorApp({
      env: { EYEBALL_API_KEYS: `${STATIC_KEY}:project_static:user_static` },
      requestIdFactory: () => "req_static_auth",
    });

    expect((await subscriptions(app, STATIC_KEY, "user_static")).status).toBe(
      200,
    );
    expect((await subscriptions(app, STATIC_KEY, "another_user")).status).toBe(
      403,
    );
    expect((await subscriptions(app, "unknown_key")).status).toBe(401);
  });

  it("authorizes a remotely verified key through an in-process cloud app", async () => {
    const cloud = createKeyCloud();
    cloud.principals.set(REMOTE_KEY, { projectId: "project_remote" });
    const app = createExecutorApp({
      apiKeyAuthenticator: new RemoteKeyAuthenticator({
        endpoint: KEY_VERIFY_URL,
        internalApiSecret: INTERNAL_API_SECRET,
        fetchImpl: inProcessFetch(cloud.app),
      }),
      env: {},
      requestIdFactory: () => "req_remote_auth",
    });

    expect((await subscriptions(app, REMOTE_KEY)).status).toBe(200);
    expect(cloud.requests).toEqual([
      {
        key: REMOTE_KEY,
        authorization: `Bearer ${INTERNAL_API_SECRET}`,
        cacheControl: "no-store",
      },
    ]);
  });

  it("propagates revocation after the positive TTL and caches negatives more briefly", async () => {
    let nowMs = 0;
    const cloud = createKeyCloud();
    cloud.principals.set(REMOTE_KEY, { projectId: "project_remote" });
    const app = createExecutorApp({
      apiKeyAuthenticator: createConfiguredApiKeyAuthenticator({
        env: {
          EYEBALL_KEY_VERIFY_URL: KEY_VERIFY_URL,
          EYEBALL_INTERNAL_API_SECRET: INTERNAL_API_SECRET,
          EYEBALL_KEY_VERIFY_POSITIVE_TTL_MS: "60",
          EYEBALL_KEY_VERIFY_NEGATIVE_TTL_MS: "5",
        },
        fetchImpl: inProcessFetch(cloud.app),
        now: () => nowMs,
      }),
      env: {},
    });

    expect((await subscriptions(app, REMOTE_KEY)).status).toBe(200);
    cloud.principals.delete(REMOTE_KEY);
    nowMs = 59;
    expect((await subscriptions(app, REMOTE_KEY)).status).toBe(200);
    nowMs = 60;
    expect((await subscriptions(app, REMOTE_KEY)).status).toBe(401);

    cloud.principals.set(REMOTE_KEY, { projectId: "project_remote" });
    nowMs = 64;
    expect((await subscriptions(app, REMOTE_KEY)).status).toBe(401);
    nowMs = 65;
    expect((await subscriptions(app, REMOTE_KEY)).status).toBe(200);
    expect(cloud.requests).toHaveLength(3);
  });

  it("fails closed with a retryable 401 and does not cache transport failures", async () => {
    const cloud = createKeyCloud();
    cloud.principals.set(REMOTE_KEY, { projectId: "project_remote" });
    const cloudFetch = inProcessFetch(cloud.app);
    let available = false;
    let attempts = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      if (!available) throw new Error("simulated transport failure");
      return cloudFetch(input, init);
    }) as typeof fetch;
    const app = createExecutorApp({
      apiKeyAuthenticator: new RemoteKeyAuthenticator({
        endpoint: KEY_VERIFY_URL,
        internalApiSecret: INTERNAL_API_SECRET,
        fetchImpl,
      }),
      env: {},
      requestIdFactory: () => "req_transport_failure",
    });

    const failed = await subscriptions(app, REMOTE_KEY);
    expect(failed.status).toBe(401);
    const failedBody = await failed.json();
    expect(failedBody).toMatchObject({
      error: {
        code: "auth_missing",
        retryable: true,
        message: "API key verification is temporarily unavailable.",
      },
    });
    expect(JSON.stringify(failedBody)).not.toContain(REMOTE_KEY);

    available = true;
    expect((await subscriptions(app, REMOTE_KEY)).status).toBe(200);
    expect(attempts).toBe(2);
    expect(cloud.requests).toHaveLength(1);
  });

  it("enforces a remote pinned user identically to a static pinned key", async () => {
    const cloud = createKeyCloud();
    cloud.principals.set(REMOTE_KEY, {
      projectId: "project_remote",
      userId: "user_pinned",
    });
    const app = createExecutorApp({
      apiKeyAuthenticator: new RemoteKeyAuthenticator({
        endpoint: KEY_VERIFY_URL,
        internalApiSecret: INTERNAL_API_SECRET,
        fetchImpl: inProcessFetch(cloud.app),
      }),
      env: {},
    });

    expect((await subscriptions(app, REMOTE_KEY, "user_pinned")).status).toBe(
      200,
    );
    expect((await subscriptions(app, REMOTE_KEY, "another_user")).status).toBe(
      403,
    );
  });

  it("checks static keys before consulting the remote verifier", async () => {
    const cloud = createKeyCloud();
    cloud.principals.set(STATIC_KEY, {
      projectId: "wrong_remote_project",
      userId: "wrong_remote_user",
    });
    cloud.principals.set(REMOTE_KEY, { projectId: "project_remote" });
    const authenticator = createConfiguredApiKeyAuthenticator({
      env: {
        EYEBALL_API_KEYS: `${STATIC_KEY}:project_static:user_static`,
        EYEBALL_KEY_VERIFY_URL: KEY_VERIFY_URL,
        EYEBALL_INTERNAL_API_SECRET: INTERNAL_API_SECRET,
      },
      fetchImpl: inProcessFetch(cloud.app),
    });
    const app = createExecutorApp({
      apiKeyAuthenticator: authenticator,
      env: {},
    });

    expect((await subscriptions(app, STATIC_KEY, "user_static")).status).toBe(
      200,
    );
    expect(cloud.requests).toHaveLength(0);
    expect((await subscriptions(app, REMOTE_KEY)).status).toBe(200);
    expect(cloud.requests.map(({ key }) => key)).toEqual([REMOTE_KEY]);
  });

  it("reports missing remote verifier configuration at startup", () => {
    expect(() =>
      createConfiguredApiKeyAuthenticator({
        env: { EYEBALL_KEY_VERIFY_URL: KEY_VERIFY_URL },
      }),
    ).toThrow(
      "EYEBALL_INTERNAL_API_SECRET is required when EYEBALL_KEY_VERIFY_URL is configured.",
    );
  });
});

describe("stock hosted runtime composition", () => {
  it("composes grant mode, reports only redacted mode metadata, and preserves static keys", async () => {
    const lines: string[] = [];
    const runtime = await createExecutorRuntime({
      env: {
        EYEBALL_VOICE_SESSION_GRANT_SECRET: VOICE_GRANT_SECRET,
        EYEBALL_API_KEYS: `${STATIC_KEY}:project_static:user_static`,
      },
      telemetry: {
        logger: createJsonLineLogger({ sink: (line) => lines.push(line) }),
      },
    });

    try {
      expect(runtime.voiceSessionGrantVerifier).toBeDefined();
      const app = createExecutorApp({
        engine: runtime.engine,
        apiKeyAuthenticator: runtime.apiKeyAuthenticator,
        voiceSessionGrantVerifier: runtime.voiceSessionGrantVerifier,
        env: {
          EYEBALL_API_KEYS: `${STATIC_KEY}:project_static:user_static`,
        },
      });
      expect((await subscriptions(app, STATIC_KEY, "user_static")).status).toBe(
        200,
      );
      const serialized = lines.join("\n");
      expect(serialized).toContain(
        '"voiceWorkerExecutionAuthMode":"session_grant"',
      );
      expect(serialized).toContain('"grantStateDurability":"process_local"');
      expect(serialized).not.toContain(VOICE_GRANT_SECRET);
    } finally {
      await runtime.close();
    }
  });

  it("leaves grant issuance disabled when the secret is unset", async () => {
    const runtime = await createExecutorRuntime({ env: {} });
    try {
      expect(runtime.voiceSessionGrantVerifier).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("fails runtime creation for a configured short grant secret", async () => {
    await expect(
      createExecutorRuntime({
        env: { EYEBALL_VOICE_SESSION_GRANT_SECRET: "too-short" },
      }),
    ).rejects.toThrow("at least 32 UTF-8 bytes");
  });

  it("uses cloud key verification and a freshly resolved cloud OAuth token during execution", async () => {
    const fixedNow = Date.parse("2026-07-20T12:00:00.000Z");
    const gmailScope = "https://www.googleapis.com/auth/gmail.modify";
    const staleCredential = {
      type: "oauth2" as const,
      accessToken: "stale-cloud-token",
      expiresAt: new Date(fixedNow + 60_000).toISOString(),
      scopes: [gmailScope],
    };
    const freshCredential = {
      type: "oauth2" as const,
      accessToken: "fresh-cloud-token",
      connectionId: "conn_cloud_gmail",
      expiresAt: new Date(fixedNow + 3_600_000).toISOString(),
      scopes: [gmailScope],
      tokenType: "Bearer",
    };
    const resolveRequests: unknown[] = [];
    const cloud = new Hono();
    cloud.post("/internal/keys/verify", async (context) => {
      const { key } = (await context.req.json()) as { key: string };
      return context.json(
        key === REMOTE_KEY
          ? { valid: true, projectId: "project_cloud" }
          : { valid: false },
      );
    });
    cloud.post("/internal/credentials/resolve", async (context) => {
      resolveRequests.push(await context.req.json());
      const nearExpiry =
        Date.parse(staleCredential.expiresAt) <= fixedNow + 5 * 60_000;
      return context.json(nearExpiry ? freshCredential : staleCredential);
    });

    const gmail = createGmailMock();
    const providerAuthorizations: Array<string | undefined> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "cloud.example.test") {
        return cloud.request(request);
      }
      if (url.hostname === "gmail.example.test") {
        providerAuthorizations.push(
          request.headers.get("Authorization") ?? undefined,
        );
        return gmail.app.request(request);
      }
      throw new Error("Unexpected in-process fetch target.");
    }) as typeof fetch;
    const env = {
      EYEBALL_KEY_VERIFY_URL: KEY_VERIFY_URL,
      EYEBALL_CREDENTIALS: "cloud",
      EYEBALL_CREDENTIALS_URL: CREDENTIALS_URL,
      EYEBALL_INTERNAL_API_SECRET: INTERNAL_API_SECRET,
      EYEBALL_GMAIL_BASE_URL: "https://gmail.example.test",
    };
    const runtime = await createExecutorRuntime({
      env,
      fetchImpl,
      clock: { now: () => new Date(fixedNow) },
    });

    try {
      const app = createExecutorApp({
        engine: runtime.engine,
        apiKeyAuthenticator: runtime.apiKeyAuthenticator,
        env,
        requestIdFactory: () => "req_hosted_execution",
      });
      const response = await app.request("/v1/execute", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REMOTE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tool: "gmail.list_emails",
          userId: "user_cloud",
          input: {},
          mode: "sync",
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        tool: "gmail.list_emails",
        status: "succeeded",
        output: { emails: [] },
      });
      expect(resolveRequests).toEqual([
        {
          projectId: "project_cloud",
          userId: "user_cloud",
          toolkit: "gmail",
        },
      ]);
      expect(providerAuthorizations).toEqual([
        `Bearer ${freshCredential.accessToken}`,
      ]);
      expect(runtime.engine.credentialProvider.kind).toBe("cloud");
    } finally {
      await runtime.close();
    }
  });
});
