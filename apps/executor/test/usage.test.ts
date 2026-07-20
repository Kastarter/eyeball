import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogRegistry } from "@eyeball/catalog";
import {
  type CredentialProvider,
  createExecutionId,
  type ExecuteRequest,
  type ExecutorLogger,
  JSON_SCHEMA_DRAFT_2020_12,
  MockCredentialProvider,
  type ProviderManifest,
  TOOL_ERROR_CODES,
} from "@eyeball/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  AdapterRegistry,
  CloudUsageClient,
  CloudUsageGate,
  cloudUsageConfiguration,
  createExecutorApp,
  createExecutorRuntime,
  createExecutorTelemetryRuntime,
  createPgliteStoreBundle,
  deriveUsageIdempotencyKey,
  ExecutionEngine,
  ExecutionRequestError,
  InMemoryExecutionStore,
  InMemoryUsageOutboxStore,
  PromiseTaskQueue,
  type ToolkitAdapter,
  UsageOutboxFlusher,
} from "../src/index.js";

const PROJECT_ID = "proj_usage";
const USER_ID = "user_usage";
const INTERNAL_SECRET = "usage-test-secret-with-at-least-32-characters";
const SESSION_SECRET = "usage-test-session-secret-at-least-32-characters";
const CLOUD_PASSWORD = "correct horse battery staple";
// The private Cloud checkout is an ignored sibling; OSS-only checkouts skip this one integration.
const CLOUD_CONTROL_ENTRY = fileURLToPath(
  new URL("../../../cloud/apps/control/src/index.ts", import.meta.url),
);

interface CloudControlApp {
  request(input: string | Request, init?: RequestInit): Promise<Response>;
}

interface CloudControlModule {
  createControlApp(options: {
    database: unknown;
    sessionSecret: string;
    internalApiSecret: string;
    secureCookies: boolean;
    now: () => Date;
  }): CloudControlApp;
  createPgliteDatabase(): Promise<{
    database: unknown;
    client: { query(sql: string): Promise<unknown> };
    close(): Promise<void>;
  }>;
}

async function loadCloudControl(): Promise<CloudControlModule> {
  return (await import(CLOUD_CONTROL_ENTRY)) as unknown as CloudControlModule;
}

const manifest: ProviderManifest = {
  schemaVersion: "1.0",
  catalogVersion: "2.0",
  toolkit: {
    slug: "usage-echo",
    displayName: "Usage Echo",
    source: "native",
    tier: "P0",
  },
  auth: { class: "api_key", requiredScopes: [] },
  endpoint: { baseUrl: "https://usage-echo.invalid" },
  implements: [
    {
      capability: "ai_media_utilities",
      canonicalTool: "run",
      canonicalVersion: "1.0.0",
      operationId: "usage-echo.run",
    },
  ],
};

const catalog = new CatalogRegistry({
  catalogVersion: "2.0",
  contracts: [
    {
      capability: "ai_media_utilities",
      name: "run",
      description: "Usage-gate test tool.",
      inputSchema: {
        $schema: JSON_SCHEMA_DRAFT_2020_12,
        $id: "urn:eyeball:test:usage:input:1.0.0",
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: { message: { type: "string" } },
      },
      outputSchema: {
        $schema: JSON_SCHEMA_DRAFT_2020_12,
        $id: "urn:eyeball:test:usage:output:1.0.0",
        type: "object",
        additionalProperties: false,
        required: ["echo"],
        properties: { echo: { type: "string" } },
      },
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        async: false,
      },
      version: "1.0.0",
    },
  ],
  manifests: [manifest],
});

const adapter: ToolkitAdapter = {
  toolkitSlug: "usage-echo",
  execute: async ({ canonicalInput }) => ({ echo: canonicalInput.message }),
};

function request(mode: "sync" | "async" = "sync"): ExecuteRequest {
  return {
    tool: "usage-echo.run",
    userId: USER_ID,
    input: { message: "hello" },
    mode,
  };
}

function runtimeUsageRequest(): ExecuteRequest {
  return {
    tool: "voice-agents.list_voice_agents",
    userId: USER_ID,
    input: {},
    mode: "sync",
  };
}

function runtimeUsageEnvironment(
  options: { credentials?: "cloud"; strict?: string } = {},
): Readonly<Record<string, string | undefined>> {
  return {
    EYEBALL_USAGE_URL: "http://localhost",
    EYEBALL_INTERNAL_API_SECRET: INTERNAL_SECRET,
    EYEBALL_USAGE_FLUSH_INTERVAL_MS: "60000",
    EYEBALL_USAGE_DRAIN_TIMEOUT_MS: "100",
    ...(options.credentials === undefined
      ? {}
      : { EYEBALL_CREDENTIALS: options.credentials }),
    ...(options.strict === undefined
      ? {}
      : { EYEBALL_USAGE_STRICT: options.strict }),
  };
}

function runtimeCredentialProvider(): MockCredentialProvider {
  return new MockCredentialProvider([
    {
      match: {
        projectId: PROJECT_ID,
        userId: USER_ID,
        toolkitSlug: "voice-agents",
      },
      credential: { type: "none" },
    },
  ]);
}

const unavailableUsageFetch = (async () =>
  new Response(null, { status: 503 })) as typeof fetch;

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata?: Readonly<Record<string, unknown>>;
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

class FakeUsageCloud {
  readonly app = new Hono();
  readonly reservations = new Map<
    string,
    {
      id: string;
      projectId: string;
      executionId: string | null;
      createdAt: string;
    }
  >();
  readonly committed = new Set<string>();
  reserveCalls = 0;
  reportCalls = 0;
  releaseCalls = 0;
  allowed = true;
  available = true;

  constructor() {
    this.app.post("/internal/usage/reserve", async (context) => {
      if (!this.available) return context.json({ error: "down" }, 503);
      this.reserveCalls += 1;
      const body = await context.req.json<{
        projectId: string;
        idempotencyKey: string;
        executionId?: string;
      }>();
      if (!this.allowed) {
        return context.json({
          allowed: false,
          reservation: null,
          upgradeMessage: "Monthly execution quota reached.",
        });
      }
      const reservation = this.reservations.get(body.idempotencyKey) ?? {
        id: `usr_${this.reservations.size + 1}`,
        projectId: body.projectId,
        executionId: body.executionId ?? null,
        createdAt: "2026-07-18T00:00:00.000Z",
      };
      this.reservations.set(body.idempotencyKey, reservation);
      return context.json({
        allowed: true,
        projectId: body.projectId,
        dimension: "execution",
        requested: 1,
        used: this.committed.size,
        reserved: this.reservations.size,
        limit: 1_000,
        remaining: 999,
        plan: "free",
        billing: null,
        reservation: {
          ...reservation,
          organizationId: "org_usage",
          month: "2026-07-01",
          quantity: 1,
          idempotencyKey: body.idempotencyKey,
          state: "reserved",
          expiresAt: "2026-07-18T00:15:00.000Z",
          updatedAt: reservation.createdAt,
        },
      });
    });
    this.app.post("/internal/usage/report", async (context) => {
      if (!this.available) return context.json({ error: "down" }, 503);
      this.reportCalls += 1;
      const body = await context.req.json<{
        events: readonly { idempotencyKey: string }[];
      }>();
      let accepted = 0;
      let duplicates = 0;
      for (const event of body.events) {
        if (this.committed.has(event.idempotencyKey)) duplicates += 1;
        else {
          this.committed.add(event.idempotencyKey);
          accepted += 1;
        }
      }
      return context.json({ accepted, duplicates }, 202);
    });
    this.app.post("/internal/usage/release", async (context) => {
      this.releaseCalls += 1;
      const body = await context.req.json<{ idempotencyKey: string }>();
      const reservation = this.reservations.get(body.idempotencyKey);
      if (reservation === undefined)
        return context.json({ error: "missing" }, 404);
      return context.json({
        reservation: {
          ...reservation,
          organizationId: "org_usage",
          month: "2026-07-01",
          quantity: 1,
          idempotencyKey: body.idempotencyKey,
          state: "released",
          expiresAt: "2026-07-18T00:15:00.000Z",
          updatedAt: reservation.createdAt,
        },
      });
    });
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    this.app.request(new Request(input, init))) as typeof fetch;
}

interface CloudTenant {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly organizationId: string;
  readonly projectId: string;
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

async function createCloudTenant(app: CloudControlApp): Promise<CloudTenant> {
  const signup = await app.request("/v1/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "executor-usage@example.test",
      password: CLOUD_PASSWORD,
    }),
  });
  expect(signup.status).toBe(201);
  const { csrfToken } = (await signup.json()) as { csrfToken: string };
  const cookie = cloudAuthCookies(signup);
  const authenticatedHeaders = {
    "Content-Type": "application/json",
    Cookie: cookie,
    "X-CSRF-Token": csrfToken,
  };
  const organization = await app.request("/v1/orgs", {
    method: "POST",
    headers: authenticatedHeaders,
    body: JSON.stringify({ name: "Executor usage", slug: "executor-usage" }),
  });
  expect(organization.status).toBe(201);
  const organizationId = (
    (await organization.json()) as { organization: { id: string } }
  ).organization.id;
  const project = await app.request(`/v1/orgs/${organizationId}/projects`, {
    method: "POST",
    headers: authenticatedHeaders,
    body: JSON.stringify({
      name: "Executor usage project",
      slug: "executor-usage-project",
      environment: "dev",
    }),
  });
  expect(project.status).toBe(201);
  const projectId = ((await project.json()) as { project: { id: string } })
    .project.id;
  return { cookie, csrfToken, organizationId, projectId };
}

function harness(
  options: {
    cloud?: FakeUsageCloud;
    credentialProvider?: CredentialProvider;
    projectId?: string;
    strict?: boolean;
    store?: InMemoryExecutionStore;
    usageFetch?: typeof fetch;
    withUsage?: boolean;
  } = {},
) {
  const logs: CapturedLog[] = [];
  const telemetry = createExecutorTelemetryRuntime({
    logger: captureLogger(logs),
  });
  const cloud = options.cloud ?? new FakeUsageCloud();
  const projectId = options.projectId ?? PROJECT_ID;
  const outbox = new InMemoryUsageOutboxStore();
  const client = new CloudUsageClient({
    baseUrl: "http://localhost",
    internalApiSecret: INTERNAL_SECRET,
    fetchImpl: options.usageFetch ?? cloud.fetch,
  });
  const gate = new CloudUsageGate({
    client,
    outboxStore: outbox,
    telemetry,
    strict: options.strict,
  });
  const store = options.store ?? new InMemoryExecutionStore();
  let sequence = 0;
  const queue = new PromiseTaskQueue(1);
  const engine = new ExecutionEngine({
    catalog,
    adapters: new AdapterRegistry([adapter]),
    credentialProvider:
      options.credentialProvider ??
      new MockCredentialProvider([
        {
          match: {
            projectId,
            userId: USER_ID,
            toolkitSlug: "usage-echo",
          },
          credential: {
            type: "api_key",
            values: { apiKey: "fixture:test-key" },
          },
        },
      ]),
    store,
    queue,
    telemetryRuntime: telemetry,
    ...(options.withUsage === false ? {} : { usageGate: gate }),
    executionIdFactory: () => {
      sequence += 1;
      return createExecutionId(`usage_${sequence}`);
    },
  });
  const flusher = new UsageOutboxFlusher({
    client,
    store: outbox,
    telemetry,
    alertAfterAttempts: 2,
  });
  return {
    cloud,
    engine,
    flusher,
    gate,
    logs,
    outbox,
    queue,
    store,
    telemetry,
  };
}

describe("cloud usage admission and reporting", () => {
  it("derives a stable opaque key from the full executor idempotency identity", () => {
    const identity = {
      projectId: PROJECT_ID,
      executionId: createExecutionId("usage_identity"),
      request: request(),
      catalogVersion: "2.0",
      idempotencyKey: "private-client-key",
    };
    const first = deriveUsageIdempotencyKey(identity);
    expect(deriveUsageIdempotencyKey(identity)).toBe(first);
    expect(first).toMatch(/^usage_[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain(identity.idempotencyKey);
    expect(
      deriveUsageIdempotencyKey({
        ...identity,
        request: { ...request(), input: { message: "different" } },
      }),
    ).not.toBe(first);
  });

  it("reserves before allocation and reports a terminal execution", async () => {
    const test = harness();
    await expect(
      test.engine.execute({ projectId: PROJECT_ID, request: request() }),
    ).resolves.toMatchObject({ response: { status: "succeeded" } });
    await test.gate.onIdle();
    expect(test.cloud.reserveCalls).toBe(1);
    expect(await test.outbox.depth()).toBe(1);
    await expect(test.flusher.flushOnce()).resolves.toEqual({
      selected: 1,
      sent: 1,
      failed: 0,
    });
    expect(test.cloud.committed.size).toBe(1);
    expect(await test.outbox.depth()).toBe(0);
  });

  it("rejects quota denial without allocating or reporting an execution", async () => {
    const cloud = new FakeUsageCloud();
    cloud.allowed = false;
    const test = harness({ cloud });
    const app = createExecutorApp({
      engine: test.engine,
      apiKeys: { ey_usage_test: PROJECT_ID },
    });
    const response = await app.request("/v1/execute", {
      method: "POST",
      headers: {
        Authorization: "Bearer ey_usage_test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request()),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: TOOL_ERROR_CODES.RATE_LIMITED,
        retryable: false,
        message: expect.stringContaining("quota"),
      },
    });
    await expect(test.store.list(PROJECT_ID, { limit: 10 })).resolves.toEqual({
      executions: [],
    });
    expect(cloud.reportCalls).toBe(0);
    expect(await test.outbox.depth()).toBe(0);
  });

  it("fails open with warning and metric, while strict mode fails closed", async () => {
    const openCloud = new FakeUsageCloud();
    openCloud.available = false;
    const open = harness({ cloud: openCloud });
    const openMetric = vi.spyOn(open.telemetry, "recordUsageReservation");
    await expect(
      open.engine.execute({ projectId: PROJECT_ID, request: request() }),
    ).resolves.toMatchObject({ response: { status: "succeeded" } });
    expect(openMetric).toHaveBeenCalledWith("fail_open");
    expect(open.logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "usage.reservation_failed_open",
      }),
    );

    const strictCloud = new FakeUsageCloud();
    strictCloud.available = false;
    const strict = harness({ cloud: strictCloud, strict: true });
    const strictFailure = strict.engine.execute({
      projectId: PROJECT_ID,
      request: request(),
    });
    await expect(strictFailure).rejects.toBeInstanceOf(ExecutionRequestError);
    await expect(strictFailure).rejects.toMatchObject({
      httpStatus: 429,
      code: TOOL_ERROR_CODES.RATE_LIMITED,
      retryable: true,
    });
    await expect(strict.store.list(PROJECT_ID, { limit: 10 })).resolves.toEqual(
      { executions: [] },
    );
  });

  it("retains terminal usage while Cloud is down and flushes after recovery", async () => {
    const test = harness();
    await test.engine.execute({ projectId: PROJECT_ID, request: request() });
    await test.gate.onIdle();
    test.cloud.available = false;
    await expect(test.flusher.flushOnce()).resolves.toMatchObject({
      failed: 1,
    });
    await expect(test.flusher.flushOnce(true)).resolves.toMatchObject({
      failed: 1,
    });
    expect(await test.outbox.depth()).toBe(1);
    expect(
      (await test.outbox.listReady(new Date().toISOString(), 50, true))[0],
    ).toMatchObject({
      state: "failed",
      attempts: 2,
    });
    expect(test.logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "usage.outbox_retry_alert",
      }),
    );
    test.cloud.available = true;
    await expect(test.flusher.flushOnce(true)).resolves.toMatchObject({
      sent: 1,
    });
    expect(test.cloud.committed.size).toBe(1);
    await expect(test.flusher.flushOnce(true)).resolves.toMatchObject({
      selected: 0,
    });
  });

  it("reserves an async idempotent submit only once", async () => {
    const test = harness();
    const command = {
      projectId: PROJECT_ID,
      request: request("async"),
      idempotencyKey: "async-submit",
    };
    await expect(test.engine.execute(command)).resolves.toMatchObject({
      statusCode: 202,
      replayed: false,
    });
    await test.queue.onIdle();
    await test.gate.onIdle();
    test.cloud.allowed = false;
    await expect(test.engine.execute(command)).resolves.toMatchObject({
      replayed: true,
    });
    expect(test.cloud.reserveCalls).toBe(1);
    expect(await test.outbox.depth()).toBe(1);
  });

  it("best-effort releases a reservation when allocation fails", async () => {
    class FailingStore extends InMemoryExecutionStore {
      override async allocate(): Promise<never> {
        throw new Error("allocation unavailable");
      }
    }
    const test = harness({ store: new FailingStore() });
    await expect(
      test.engine.execute({ projectId: PROJECT_ID, request: request() }),
    ).rejects.toThrow("allocation unavailable");
    expect(test.cloud.releaseCalls).toBe(1);
  });

  it("releases instead of reporting when execution fails before dispatch", async () => {
    const test = harness({
      credentialProvider: new MockCredentialProvider([]),
    });
    await expect(
      test.engine.execute({ projectId: PROJECT_ID, request: request() }),
    ).resolves.toMatchObject({ response: { status: "failed" } });
    await test.gate.onIdle();
    expect(test.cloud.releaseCalls).toBe(1);
    expect(test.cloud.reportCalls).toBe(0);
    expect(await test.outbox.depth()).toBe(0);
  });

  it("keeps the default NoopUsageGate free of remote and outbox behavior", async () => {
    const test = harness({ withUsage: false });
    await expect(
      test.engine.execute({ projectId: PROJECT_ID, request: request() }),
    ).resolves.toMatchObject({ response: { status: "succeeded" } });
    expect(test.engine.usageGate.enabled).toBe(false);
    expect(test.cloud.reserveCalls).toBe(0);
    expect(await test.outbox.depth()).toBe(0);
  });

  it("composes the Cloud gate and flusher from hosted runtime environment", async () => {
    const cloud = new FakeUsageCloud();
    const runtime = await createExecutorRuntime({
      env: {
        EYEBALL_USAGE_URL: "http://localhost",
        EYEBALL_INTERNAL_API_SECRET: INTERNAL_SECRET,
        EYEBALL_USAGE_FLUSH_INTERVAL_MS: "60000",
        EYEBALL_USAGE_DRAIN_TIMEOUT_MS: "100",
      },
      credentialProvider: new MockCredentialProvider([]),
      fetchImpl: cloud.fetch,
    });
    try {
      expect(runtime.engine.usageGate).toBeInstanceOf(CloudUsageGate);
      expect(runtime.usageOutboxFlusher).toBeInstanceOf(UsageOutboxFlusher);
    } finally {
      await runtime.close();
    }
  });

  it.each([
    ["1", true],
    ["true", true],
    ["0", false],
    ["false", false],
  ] as const)("accepts the explicit EYEBALL_USAGE_STRICT=%s override", (strictValue, strict) => {
    expect(
      cloudUsageConfiguration(runtimeUsageEnvironment({ strict: strictValue })),
    ).toMatchObject({ strict, strictSource: "explicit_override" });
  });

  it("defaults hosted cloud-credential composition to retryable fail-closed admission", async () => {
    const logs: CapturedLog[] = [];
    const runtime = await createExecutorRuntime({
      env: runtimeUsageEnvironment({ credentials: "cloud" }),
      credentialProvider: runtimeCredentialProvider(),
      fetchImpl: unavailableUsageFetch,
      telemetry: { logger: captureLogger(logs) },
    });
    try {
      const execution = runtime.engine.execute({
        projectId: PROJECT_ID,
        request: runtimeUsageRequest(),
      });
      await expect(execution).rejects.toMatchObject({
        httpStatus: 429,
        code: TOOL_ERROR_CODES.RATE_LIMITED,
        retryable: true,
      });
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "usage.enforcement_configured",
          metadata: expect.objectContaining({
            enforcementMode: "strict",
            resolution: "hosted_default",
            hostedComposition: true,
            explicitRelaxation: false,
          }),
        }),
      );
    } finally {
      await runtime.close();
    }
  });

  it("keeps the unset self-hosted composition fail open", async () => {
    const logs: CapturedLog[] = [];
    const runtime = await createExecutorRuntime({
      env: runtimeUsageEnvironment(),
      credentialProvider: runtimeCredentialProvider(),
      fetchImpl: unavailableUsageFetch,
      telemetry: { logger: captureLogger(logs) },
    });
    try {
      await expect(
        runtime.engine.execute({
          projectId: PROJECT_ID,
          request: runtimeUsageRequest(),
        }),
      ).resolves.toMatchObject({ response: { status: "succeeded" } });
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "usage.enforcement_configured",
          metadata: expect.objectContaining({
            enforcementMode: "fail_open",
            resolution: "self_hosted_default",
            hostedComposition: false,
            explicitRelaxation: false,
          }),
        }),
      );
    } finally {
      await runtime.close();
    }
  });

  it("honors and warns on an explicit hosted fail-open relaxation", async () => {
    const logs: CapturedLog[] = [];
    const runtime = await createExecutorRuntime({
      env: runtimeUsageEnvironment({ credentials: "cloud", strict: "0" }),
      credentialProvider: runtimeCredentialProvider(),
      fetchImpl: unavailableUsageFetch,
      telemetry: { logger: captureLogger(logs) },
    });
    try {
      await expect(
        runtime.engine.execute({
          projectId: PROJECT_ID,
          request: runtimeUsageRequest(),
        }),
      ).resolves.toMatchObject({ response: { status: "succeeded" } });
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "usage.enforcement_configured",
          metadata: expect.objectContaining({
            enforcementMode: "fail_open",
            resolution: "explicit_override",
            hostedComposition: true,
            explicitRelaxation: true,
          }),
        }),
      );
    } finally {
      await runtime.close();
    }
  });

  it("rejects an invalid explicit usage enforcement value at startup", async () => {
    await expect(
      createExecutorRuntime({
        env: runtimeUsageEnvironment({ strict: "sometimes" }),
        credentialProvider: runtimeCredentialProvider(),
        fetchImpl: unavailableUsageFetch,
      }),
    ).rejects.toThrow(
      "EYEBALL_USAGE_STRICT must be 1, true, 0, or false when set.",
    );
  });

  it("survives a PGlite restart and flushes the pending report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eyeball-usage-outbox-"));
    try {
      const executionId = createExecutionId("usage_restart");
      const payload = {
        projectId: PROJECT_ID,
        executionId,
        idempotencyKey: "usage_restart_key",
        dimension: "execution" as const,
        quantity: 1 as const,
        occurredAt: "2026-07-18T00:00:00.000Z",
      };
      const first = await createPgliteStoreBundle({ dataDir: directory });
      await first.usageOutboxStore.enqueue(payload, payload.occurredAt);
      await first.close();

      const restored = await createPgliteStoreBundle({ dataDir: directory });
      try {
        expect(await restored.usageOutboxStore.depth()).toBe(1);
        const cloud = new FakeUsageCloud();
        const telemetry = createExecutorTelemetryRuntime({
          logger: captureLogger([]),
        });
        const client = new CloudUsageClient({
          baseUrl: "http://localhost",
          internalApiSecret: INTERNAL_SECRET,
          fetchImpl: cloud.fetch,
        });
        const flusher = new UsageOutboxFlusher({
          client,
          store: restored.usageOutboxStore,
          telemetry,
        });
        await expect(flusher.flushOnce()).resolves.toMatchObject({ sent: 1 });
        expect(cloud.committed).toEqual(new Set([payload.idempotencyKey]));
        expect(await restored.usageOutboxStore.depth()).toBe(0);
      } finally {
        await restored.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(existsSync(CLOUD_CONTROL_ENTRY))(
    "integrates with the real Cloud app for commit, dedupe, totals, and denial",
    async () => {
      const { createControlApp, createPgliteDatabase } =
        await loadCloudControl();
      const cloudDatabase = await createPgliteDatabase();
      try {
        const now = () => new Date("2026-07-20T12:00:00.000Z");
        const control = createControlApp({
          database: cloudDatabase.database,
          sessionSecret: SESSION_SECRET,
          internalApiSecret: INTERNAL_SECRET,
          secureCookies: false,
          now,
        });
        const tenant = await createCloudTenant(control);
        let reportAvailable = true;
        let reportFailureBody: string | undefined;
        const controlFetch = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url = new URL(String(input));
          if (!reportAvailable && url.pathname === "/internal/usage/report") {
            return new Response(JSON.stringify({ error: "temporarily_down" }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }
          const response = await control.request(new Request(input, init));
          if (url.pathname === "/internal/usage/report" && !response.ok) {
            reportFailureBody = await response.clone().text();
          }
          return response;
        }) as typeof fetch;
        const integrated = harness({
          projectId: tenant.projectId,
          usageFetch: controlFetch,
        });
        await expect(
          integrated.engine.execute({
            projectId: tenant.projectId,
            request: request(),
          }),
        ).resolves.toMatchObject({ response: { status: "succeeded" } });
        await integrated.gate.onIdle();
        const pending = (
          await integrated.outbox.listReady(now().toISOString(), 50, true)
        )[0];
        if (pending === undefined)
          throw new Error("Expected a terminal usage report.");

        reportAvailable = false;
        await expect(integrated.flusher.flushOnce(true)).resolves.toMatchObject(
          {
            failed: 1,
          },
        );
        reportAvailable = true;
        const recovered = await integrated.flusher.flushOnce(true);
        expect(recovered, reportFailureBody).toMatchObject({ sent: 1 });
        const directClient = new CloudUsageClient({
          baseUrl: "http://localhost",
          internalApiSecret: INTERNAL_SECRET,
          fetchImpl: controlFetch,
        });
        await expect(directClient.report([pending.payload])).resolves.toEqual({
          accepted: 0,
          duplicates: 1,
        });

        const usage = await control.request(
          `/v1/orgs/${tenant.organizationId}/usage`,
          { headers: { Cookie: tenant.cookie } },
        );
        expect(usage.status).toBe(200);
        await expect(usage.json()).resolves.toMatchObject({
          usage: { totals: { executions: 1, projects: 1 } },
        });

        await cloudDatabase.client.query(
          "update plans set included_executions = 0 where key = 'free'",
        );
        const denied = harness({
          projectId: tenant.projectId,
          usageFetch: controlFetch,
        });
        await expect(
          denied.engine.execute({
            projectId: tenant.projectId,
            executionId: createExecutionId("usage_denied"),
            request: request(),
          }),
        ).rejects.toMatchObject({
          httpStatus: 429,
          code: TOOL_ERROR_CODES.RATE_LIMITED,
        });
        await expect(
          denied.store.list(tenant.projectId, { limit: 10 }),
        ).resolves.toEqual({ executions: [] });
        expect(await denied.outbox.depth()).toBe(0);
      } finally {
        await cloudDatabase.close();
      }
    },
  );
});
