import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExecutorLogger } from "@eyeball/core";
import { describe, expect, it, vi } from "vitest";
import {
  createGmailMock,
  createResendMock,
} from "../../../mocks/packages/mocks-email/dist/index.js";
import {
  createConfiguredApiKeyAuthenticator,
  createExecutorApp,
  createExecutorRuntime,
} from "../src/index.js";

const CLOUD_CONTROL_ENTRY = fileURLToPath(
  new URL("../../../cloud/apps/control/src/index.ts", import.meta.url),
);
const CLOUD_ORIGIN = "https://cloud.example.test";
const KEY_VERIFY_URL = `${CLOUD_ORIGIN}/internal/keys/verify`;
const CREDENTIALS_URL = `${CLOUD_ORIGIN}/internal/credentials/resolve`;
const RESEND_ORIGIN = "https://resend.example.test";
const GMAIL_ORIGIN = "https://gmail.example.test";
const OAUTH_ORIGIN = "https://oauth.example.test";
const OAUTH_TOKEN_URL = "https://oauth.example.test/token";
const INTERNAL_API_SECRET =
  "fixture-hosted-internal-api-secret-at-least-32-characters";
const SESSION_SECRET = "fixture-hosted-session-secret-at-least-32-characters";
const OAUTH_INTENT_SECRET =
  "fixture-hosted-oauth-intent-secret-at-least-32-characters";
const CLOUD_PASSWORD = "correct horse battery staple";
const VAULT_MASTER_KEY = Buffer.alloc(32, 42).toString("base64");
const END_USER_ID = "release_gate_end_user";
const RESEND_API_KEY = "fixture:hosted-resend-api-key";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const STALE_ACCESS_TOKEN = "fixture:stale-gmail-access-token";
const INITIAL_REFRESH_TOKEN = "fixture:initial-gmail-refresh-token";
const REFRESHED_ACCESS_TOKEN = "fixture:refreshed-gmail-access-token";
const ROTATED_REFRESH_TOKEN = "fixture:rotated-gmail-refresh-token";
const OAUTH_CLIENT_SECRET = "fixture:hosted-gmail-client-secret";
const DOCUMENTED_POSITIVE_KEY_TTL_MS = 60_000;
const DOCUMENTED_NEGATIVE_KEY_TTL_MS = 5_000;

interface CloudControlApp {
  request(input: string | Request, init?: RequestInit): Promise<Response>;
}

interface CloudDatabaseBundle {
  readonly database: unknown;
  readonly client: { query(sql: string): Promise<unknown> };
  close(): Promise<void>;
}

interface CloudVault {
  putOAuthApp(input: {
    organizationId: string;
    toolkit: string;
    clientId: string;
    clientSecret: string;
    scopes: readonly string[];
    redirectBase: string;
    actorUserId: string;
  }): Promise<{ id: string }>;
  createOAuthConnection(input: {
    organizationId: string;
    projectId: string;
    externalUserId: string;
    toolkit: string;
    oauthAppId: string;
    providerAccountLabel: string;
    actorUserId: string;
  }): Promise<{ id: string }>;
  storeOAuthCredential(input: {
    connectionId: string;
    credential: {
      type: "oauth2";
      accessToken: string;
      refreshToken: string;
      expiresAt: string;
      scopes: readonly string[];
      tokenType: string;
    };
    actorUserId: string;
  }): Promise<unknown>;
}

interface CloudControlModule {
  readonly EnvKeyWrapper: new (options: {
    masterKey: string;
    version: number;
  }) => unknown;
  readonly VaultService: new (options: {
    database: unknown;
    keyWrapper: unknown;
    oauthEndpoints: Readonly<Record<string, { tokenUrl: string }>>;
    oauthIntentSecret: string;
    oauthCallbackUrl: string;
    fetchImpl: typeof fetch;
    now: () => Date;
  }) => CloudVault;
  createControlApp(options: {
    database: unknown;
    sessionSecret: string;
    internalApiSecret: string;
    secureCookies: boolean;
    now: () => Date;
    vault: CloudVault;
  }): CloudControlApp;
  createPgliteDatabase(): Promise<CloudDatabaseBundle>;
}

interface CloudSession {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly userId: string;
}

interface CapturedLog {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface ExecutionRequestBody {
  readonly tool: string;
  readonly userId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly mode: "sync";
}

interface ExecutionResponseBody {
  readonly executionId?: string;
  readonly status?: string;
  readonly output?: unknown;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly retryable?: boolean;
  };
}

interface ProviderAuthorization {
  readonly toolkit: "gmail" | "resend";
  readonly authorization: string | null;
  readonly pathname: string;
}

async function loadCloudControl(): Promise<CloudControlModule> {
  return (await import(CLOUD_CONTROL_ENTRY)) as unknown as CloudControlModule;
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function cloudAuthCookies(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const session = /eyeball_cloud_session=([^;,\s]+)/u.exec(header)?.[1];
  const csrf = /eyeball_cloud_csrf=([^;,\s]+)/u.exec(header)?.[1];
  if (session === undefined || csrf === undefined) {
    throw new Error("Cloud signup did not set session and CSRF cookies.");
  }
  return `eyeball_cloud_session=${session}; eyeball_cloud_csrf=${csrf}`;
}

function cloudRequest(
  app: CloudControlApp,
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    auth?: CloudSession;
    body?: unknown;
  } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.body !== undefined)
    headers.set("Content-Type", "application/json");
  if (options.auth !== undefined) {
    headers.set("Cookie", options.auth.cookie);
    if (method !== "GET") {
      headers.set("X-CSRF-Token", options.auth.csrfToken);
    }
  }
  return app.request(path, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

function captureLogger(logs: CapturedLog[]): ExecutorLogger {
  return Object.fromEntries(
    (["debug", "info", "warn", "error"] as const).map((level) => [
      level,
      (message: string, metadata?: Readonly<Record<string, unknown>>) => {
        logs.push({
          level,
          message,
          ...(metadata === undefined ? {} : { metadata }),
        });
      },
    ]),
  ) as unknown as ExecutorLogger;
}

async function execute(
  app: ReturnType<typeof createExecutorApp>,
  apiKey: string,
  request: ExecutionRequestBody,
  idempotencyKey: string,
): Promise<{ response: Response; body: ExecutionResponseBody }> {
  const response = await app.request("/v1/execute", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "X-Eyeball-User-Id": request.userId,
    },
    body: JSON.stringify(request),
  });
  return { response, body: await json<ExecutionResponseBody>(response) };
}

async function currentUsage(
  app: CloudControlApp,
  session: CloudSession,
  organizationId: string,
): Promise<{
  totals: { executions: number; projects: number };
  limits: { executions: number | null };
}> {
  const response = await cloudRequest(app, `/v1/orgs/${organizationId}/usage`, {
    auth: session,
  });
  expect(response.status).toBe(200);
  return (
    await json<{
      usage: {
        totals: { executions: number; projects: number };
        limits: { executions: number | null };
      };
    }>(response)
  ).usage;
}

describe("hosted cross-app release gate", () => {
  it.runIf(existsSync(CLOUD_CONTROL_ENTRY))(
    "provisions, executes, refreshes, bills exactly once, serializes quota, and revokes",
    async () => {
      const cloudModule = await loadCloudControl();
      const cloudDatabase = await cloudModule.createPgliteDatabase();
      const resend = createResendMock();
      const gmail = createGmailMock();
      const providerAuthorizations: ProviderAuthorization[] = [];
      const oauthRefreshBodies: string[] = [];
      const logs: CapturedLog[] = [];
      let keyVerificationRequests = 0;
      let nowMs = Date.parse("2026-07-20T12:00:00.000Z");
      const now = () => new Date(nowMs);
      const clock = { now };
      let control: CloudControlApp | undefined;

      const fetchImpl = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin === CLOUD_ORIGIN) {
          if (control === undefined) {
            throw new Error("Cloud control app was called before composition.");
          }
          if (url.pathname === "/internal/keys/verify") {
            keyVerificationRequests += 1;
          }
          return control.request(request);
        }
        if (url.origin === OAUTH_ORIGIN) {
          oauthRefreshBodies.push(await request.text());
          return new Response(
            JSON.stringify({
              access_token: REFRESHED_ACCESS_TOKEN,
              refresh_token: ROTATED_REFRESH_TOKEN,
              expires_in: 3_600,
              token_type: "Bearer",
              scope: GMAIL_SCOPE,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.origin === RESEND_ORIGIN) {
          providerAuthorizations.push({
            toolkit: "resend",
            authorization: request.headers.get("Authorization"),
            pathname: url.pathname,
          });
          return resend.app.request(request);
        }
        if (url.origin === GMAIL_ORIGIN) {
          providerAuthorizations.push({
            toolkit: "gmail",
            authorization: request.headers.get("Authorization"),
            pathname: url.pathname,
          });
          return gmail.app.request(request);
        }
        throw new Error(`Unexpected in-process fetch target: ${url.origin}`);
      }) as typeof fetch;

      const keyWrapper = new cloudModule.EnvKeyWrapper({
        masterKey: VAULT_MASTER_KEY,
        version: 1,
      });
      const vault = new cloudModule.VaultService({
        database: cloudDatabase.database,
        keyWrapper,
        oauthEndpoints: { gmail: { tokenUrl: OAUTH_TOKEN_URL } },
        oauthIntentSecret: OAUTH_INTENT_SECRET,
        oauthCallbackUrl: `${CLOUD_ORIGIN}/oauth/callback`,
        fetchImpl,
        now,
      });
      control = cloudModule.createControlApp({
        database: cloudDatabase.database,
        sessionSecret: SESSION_SECRET,
        internalApiSecret: INTERNAL_API_SECRET,
        secureCookies: false,
        now,
        vault,
      });

      let runtime:
        | Awaited<ReturnType<typeof createExecutorRuntime>>
        | undefined;
      let runtimeClosed = false;
      let restoreExecuteSpy: (() => void) | undefined;
      try {
        // Provisioning: exercise the same authenticated Cloud HTTP surface as the dashboard.
        const signup = await cloudRequest(control, "/v1/auth/signup", {
          method: "POST",
          body: {
            email: "hosted-release-gate@example.test",
            password: CLOUD_PASSWORD,
          },
        });
        expect(signup.status).toBe(201);
        const signupBody = await json<{
          user: { id: string };
          csrfToken: string;
        }>(signup);
        const session: CloudSession = {
          cookie: cloudAuthCookies(signup),
          csrfToken: signupBody.csrfToken,
          userId: signupBody.user.id,
        };
        expect(session.cookie).toContain("eyeball_cloud_session=");
        expect(session.cookie).toContain("eyeball_cloud_csrf=");
        expect(session.csrfToken).toHaveLength(43);

        const organizationResponse = await cloudRequest(control, "/v1/orgs", {
          method: "POST",
          auth: session,
          body: { name: "Hosted release gate", slug: "hosted-release-gate" },
        });
        expect(organizationResponse.status).toBe(201);
        const organizationId = (
          await json<{ organization: { id: string } }>(organizationResponse)
        ).organization.id;

        const projectResponse = await cloudRequest(
          control,
          `/v1/orgs/${organizationId}/projects`,
          {
            method: "POST",
            auth: session,
            body: {
              name: "Hosted production",
              slug: "hosted-production",
              environment: "prod",
            },
          },
        );
        expect(projectResponse.status).toBe(201);
        const project = (
          await json<{
            project: { id: string; environment: "dev" | "prod" };
          }>(projectResponse)
        ).project;
        expect(project.environment).toBe("prod");

        const keyResponse = await cloudRequest(
          control,
          `/v1/projects/${project.id}/api-keys`,
          {
            method: "POST",
            auth: session,
            body: {
              name: "Hosted executor release gate",
              pinnedUserId: END_USER_ID,
            },
          },
        );
        expect(keyResponse.status).toBe(201);
        const createdKey = await json<{
          apiKey: { id: string; prefix: string };
          key: string;
        }>(keyResponse);
        expect(createdKey.key).toMatch(/^eb_live_[A-Za-z0-9_-]{43}$/u);
        const listedKeys = await cloudRequest(
          control,
          `/v1/projects/${project.id}/api-keys`,
          { auth: session },
        );
        expect(listedKeys.status).toBe(200);
        const listedKeyText = await listedKeys.text();
        expect(listedKeyText).toContain(createdKey.apiKey.prefix);
        expect(listedKeyText).not.toContain(createdKey.key);

        // Hosted executor: all three Cloud clients share one in-process bridge; no static keys.
        const env: Readonly<Record<string, string | undefined>> = {
          EYEBALL_KEY_VERIFY_URL: KEY_VERIFY_URL,
          EYEBALL_CREDENTIALS: "cloud",
          EYEBALL_CREDENTIALS_URL: CREDENTIALS_URL,
          EYEBALL_USAGE_URL: CLOUD_ORIGIN,
          EYEBALL_USAGE_STRICT: "1",
          EYEBALL_USAGE_FLUSH_INTERVAL_MS: "3600000",
          EYEBALL_USAGE_DRAIN_TIMEOUT_MS: "1000",
          EYEBALL_INTERNAL_API_SECRET: INTERNAL_API_SECRET,
          EYEBALL_RESEND_BASE_URL: RESEND_ORIGIN,
          EYEBALL_GMAIL_BASE_URL: GMAIL_ORIGIN,
        };
        expect(env).not.toHaveProperty("EYEBALL_API_KEYS");
        const apiKeyAuthenticator = createConfiguredApiKeyAuthenticator({
          env,
          fetchImpl,
          now: () => nowMs,
        });
        runtime = await createExecutorRuntime({
          env,
          apiKeyAuthenticator,
          fetchImpl,
          telemetry: { logger: captureLogger(logs) },
          clock,
        });
        const flusher = runtime.usageOutboxFlusher;
        if (flusher === undefined) {
          throw new Error("Hosted runtime did not compose the usage flusher.");
        }
        flusher.stop();
        await flusher.onIdle();
        expect(runtime.engine.credentialProvider.kind).toBe("cloud");
        const executeSpy = vi.spyOn(runtime.engine, "execute");
        restoreExecuteSpy = () => executeSpy.mockRestore();
        let requestSequence = 0;
        const executor = createExecutorApp({
          engine: runtime.engine,
          apiKeyAuthenticator: runtime.apiKeyAuthenticator,
          env,
          requestIdFactory: () => {
            requestSequence += 1;
            return `req_hosted_e2e_${requestSequence}`;
          },
        });

        // Scenario 1: a newly revealed Cloud key and real vault API-key connection work immediately.
        const connectionResponse = await cloudRequest(
          control,
          `/v1/projects/${project.id}/connections`,
          {
            method: "POST",
            auth: session,
            body: {
              authType: "api_key",
              externalUserId: END_USER_ID,
              toolkit: "resend",
              providerAccountLabel: "Release gate Resend",
              fields: { apiKey: RESEND_API_KEY },
            },
          },
        );
        expect(connectionResponse.status).toBe(201);
        await expect(connectionResponse.json()).resolves.toMatchObject({
          connection: { status: "active", toolkit: "resend" },
        });
        const resendExecutionRequest: ExecutionRequestBody = {
          tool: "resend.send_email",
          userId: END_USER_ID,
          input: {
            to: ["recipient@example.test"],
            subject: "Hosted release gate",
            body: "The in-process Resend fixture accepted this execution.",
            x_provider: { resend: { from: "sender@example.test" } },
          },
          mode: "sync",
        };
        const firstExecution = await execute(
          executor,
          createdKey.key,
          resendExecutionRequest,
          "hosted-e2e-resend-1",
        );
        expect(firstExecution.response.status).toBe(200);
        expect(firstExecution.body).toMatchObject({
          status: "succeeded",
          tool: "resend.send_email",
          output: { acceptedRecipients: ["recipient@example.test"] },
        });
        expect(providerAuthorizations).toContainEqual({
          toolkit: "resend",
          authorization: `Bearer ${RESEND_API_KEY}`,
          pathname: "/emails",
        });
        expect(keyVerificationRequests).toBe(1);
        const firstExecutionId = firstExecution.body.executionId;
        if (firstExecutionId === undefined) {
          throw new Error("The first hosted execution did not return an ID.");
        }
        const storedExecution = await executor.request(
          `/v1/executions/${firstExecutionId}`,
          {
            headers: {
              Authorization: `Bearer ${createdKey.key}`,
              "X-Eyeball-User-Id": END_USER_ID,
            },
          },
        );
        expect(storedExecution.status).toBe(200);
        await expect(storedExecution.json()).resolves.toMatchObject({
          executionId: firstExecutionId,
          status: "succeeded",
          tool: "resend.send_email",
        });

        // Scenario 3: seed the same encrypted near-expiry fixture path as Cloud vault tests.
        const oauthApp = await vault.putOAuthApp({
          organizationId,
          toolkit: "gmail",
          clientId: "fixture-hosted-gmail-client",
          clientSecret: OAUTH_CLIENT_SECRET,
          scopes: [GMAIL_SCOPE],
          redirectBase: `${CLOUD_ORIGIN}/oauth/callback`,
          actorUserId: session.userId,
        });
        const oauthConnection = await vault.createOAuthConnection({
          organizationId,
          projectId: project.id,
          externalUserId: END_USER_ID,
          toolkit: "gmail",
          oauthAppId: oauthApp.id,
          providerAccountLabel: "Release gate Gmail",
          actorUserId: session.userId,
        });
        await vault.storeOAuthCredential({
          connectionId: oauthConnection.id,
          credential: {
            type: "oauth2",
            accessToken: STALE_ACCESS_TOKEN,
            refreshToken: INITIAL_REFRESH_TOKEN,
            expiresAt: new Date(nowMs + 60_000).toISOString(),
            scopes: [GMAIL_SCOPE],
            tokenType: "Bearer",
          },
          actorUserId: session.userId,
        });
        const gmailExecutionRequest: ExecutionRequestBody = {
          tool: "gmail.list_emails",
          userId: END_USER_ID,
          input: {},
          mode: "sync",
        };
        const firstOAuthExecution = await execute(
          executor,
          createdKey.key,
          gmailExecutionRequest,
          "hosted-e2e-gmail-1",
        );
        expect(firstOAuthExecution.response.status).toBe(200);
        expect(firstOAuthExecution.body).toMatchObject({
          status: "succeeded",
          output: { emails: [] },
        });
        expect(oauthRefreshBodies).toHaveLength(1);
        expect(oauthRefreshBodies[0]).toContain(
          `refresh_token=${encodeURIComponent(INITIAL_REFRESH_TOKEN)}`,
        );
        expect(
          providerAuthorizations.filter(({ toolkit }) => toolkit === "gmail"),
        ).toEqual([
          expect.objectContaining({
            authorization: `Bearer ${REFRESHED_ACCESS_TOKEN}`,
          }),
        ]);

        const secondOAuthExecution = await execute(
          executor,
          createdKey.key,
          gmailExecutionRequest,
          "hosted-e2e-gmail-2",
        );
        expect(secondOAuthExecution.response.status).toBe(200);
        expect(secondOAuthExecution.body.status).toBe("succeeded");
        expect(oauthRefreshBodies).toHaveLength(1);
        expect(
          providerAuthorizations
            .filter(({ toolkit }) => toolkit === "gmail")
            .map(({ authorization }) => authorization),
        ).toEqual([
          `Bearer ${REFRESHED_ACCESS_TOKEN}`,
          `Bearer ${REFRESHED_ACCESS_TOKEN}`,
        ]);

        // Scenario 4: three unique terminals plus one HTTP replay bill exactly three.
        const replayCallIndex = executeSpy.mock.results.length;
        const replay = await execute(
          executor,
          createdKey.key,
          gmailExecutionRequest,
          "hosted-e2e-gmail-2",
        );
        expect(replay.response.status).toBe(200);
        expect(replay.body).toEqual(secondOAuthExecution.body);
        const replayCall = executeSpy.mock.results[replayCallIndex];
        if (replayCall === undefined || replayCall.type !== "return") {
          throw new Error("The replay did not return an executor outcome.");
        }
        await expect(replayCall.value).resolves.toMatchObject({
          replayed: true,
          response: { executionId: secondOAuthExecution.body.executionId },
        });
        expect(oauthRefreshBodies).toHaveLength(1);
        expect(
          providerAuthorizations.filter(({ toolkit }) => toolkit === "gmail"),
        ).toHaveLength(2);
        await runtime.engine.usageGate.onIdle();
        await expect(flusher.flushOnce(true)).resolves.toEqual({
          selected: 3,
          sent: 3,
          failed: 0,
        });
        await expect(
          currentUsage(control, session, organizationId),
        ).resolves.toMatchObject({
          totals: { executions: 3, projects: 1 },
        });

        // Scenario 5: with one hard-limit slot left, concurrent requests admit one.
        await cloudDatabase.client.query(
          "update plans set included_executions = 4 where key = 'free'",
        );
        const concurrentRequests = await Promise.all([
          execute(
            executor,
            createdKey.key,
            {
              ...resendExecutionRequest,
              input: {
                ...resendExecutionRequest.input,
                subject: "Hosted last slot A",
              },
            },
            "hosted-e2e-last-slot-a",
          ),
          execute(
            executor,
            createdKey.key,
            {
              ...resendExecutionRequest,
              input: {
                ...resendExecutionRequest.input,
                subject: "Hosted last slot B",
              },
            },
            "hosted-e2e-last-slot-b",
          ),
        ]);
        expect(
          concurrentRequests
            .map(({ response }) => response.status)
            .sort((left, right) => left - right),
        ).toEqual([200, 429]);
        const winner = concurrentRequests.find(
          ({ response }) => response.status === 200,
        );
        const denied = concurrentRequests.find(
          ({ response }) => response.status === 429,
        );
        expect(winner?.body.status).toBe("succeeded");
        expect(denied?.body).toMatchObject({
          error: { code: "rate_limited", retryable: false },
        });
        await runtime.engine.usageGate.onIdle();
        await expect(flusher.flushOnce(true)).resolves.toEqual({
          selected: 1,
          sent: 1,
          failed: 0,
        });
        await expect(
          currentUsage(control, session, organizationId),
        ).resolves.toMatchObject({
          totals: expect.objectContaining({ executions: 4, projects: 1 }),
          limits: expect.objectContaining({ executions: 4 }),
        });

        // Scenario 2: revocation reaches the executor at the documented 60-second bound.
        const revoke = await cloudRequest(
          control,
          `/v1/projects/${project.id}/api-keys/${createdKey.apiKey.id}`,
          { method: "DELETE", auth: session },
        );
        expect(revoke.status).toBe(200);
        const revokedAtMs = nowMs;
        nowMs = revokedAtMs + DOCUMENTED_POSITIVE_KEY_TTL_MS - 1;
        const cachedBeforeExpiry = await executor.request("/v1/subscriptions", {
          headers: { Authorization: `Bearer ${createdKey.key}` },
        });
        expect(cachedBeforeExpiry.status).toBe(200);
        expect(keyVerificationRequests).toBe(1);

        nowMs = revokedAtMs + DOCUMENTED_POSITIVE_KEY_TTL_MS;
        const rejectedExecution = await execute(
          executor,
          createdKey.key,
          resendExecutionRequest,
          "hosted-e2e-after-revocation",
        );
        expect(rejectedExecution.response.status).toBe(401);
        expect(rejectedExecution.body).toMatchObject({
          error: { code: "auth_missing", retryable: false },
        });
        const measuredRevocationWindowMs = nowMs - revokedAtMs;
        expect(measuredRevocationWindowMs).toBe(DOCUMENTED_POSITIVE_KEY_TTL_MS);
        expect(measuredRevocationWindowMs).toBeLessThanOrEqual(
          DOCUMENTED_POSITIVE_KEY_TTL_MS,
        );
        expect(keyVerificationRequests).toBe(2);

        nowMs += DOCUMENTED_NEGATIVE_KEY_TTL_MS - 1;
        expect(
          (
            await executor.request("/v1/subscriptions", {
              headers: { Authorization: `Bearer ${createdKey.key}` },
            })
          ).status,
        ).toBe(401);
        expect(keyVerificationRequests).toBe(2);
        nowMs += 1;
        expect(
          (
            await executor.request("/v1/subscriptions", {
              headers: { Authorization: `Bearer ${createdKey.key}` },
            })
          ).status,
        ).toBe(401);
        expect(keyVerificationRequests).toBe(3);

        await runtime.close();
        runtimeClosed = true;

        // Executor logs must never contain the reveal-once key or any credential material.
        expect(logs.length).toBeGreaterThan(0);
        const serializedLogs = JSON.stringify(logs);
        for (const secret of [
          CLOUD_PASSWORD,
          createdKey.key,
          RESEND_API_KEY,
          STALE_ACCESS_TOKEN,
          INITIAL_REFRESH_TOKEN,
          REFRESHED_ACCESS_TOKEN,
          ROTATED_REFRESH_TOKEN,
          OAUTH_CLIENT_SECRET,
          INTERNAL_API_SECRET,
          SESSION_SECRET,
          OAUTH_INTENT_SECRET,
          VAULT_MASTER_KEY,
        ]) {
          expect(serializedLogs).not.toContain(secret);
        }
      } finally {
        restoreExecuteSpy?.();
        if (!runtimeClosed) await runtime?.close();
        await cloudDatabase.close();
      }
    },
    60_000,
  );
});
