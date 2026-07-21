import { CatalogRegistry } from "@eyeball/catalog";
import {
  type CapabilityToolContract,
  type CredentialProvider,
  createExecutionId,
  type ExecuteRequest,
  type ExecutionRecord,
  EyeballError,
  JSON_SCHEMA_DRAFT_2020_12,
  type JsonValue,
  MOCK_CREDENTIAL_TRIGGER_TOKENS,
  MockCredentialProvider,
  type ProviderManifest,
  type QualifiedToolName,
  type ResolvedCredential,
  TOOL_ERROR_CODES,
  VOICE_WORKER_EXECUTION_ID_HEADER,
} from "@eyeball/core";
import { VoiceSessionDriverError } from "@eyeball/toolkits";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  type AdapterContext,
  AdapterRegistry,
  createExecutorApp,
  createExecutorJobHandlerRegistry,
  createProviderHttpClient,
  type EnsureJobResult,
  ExecutionEngine,
  type ExecutionResumeContext,
  ExecutorTaskSystem,
  InMemoryExecutionStore,
  InMemoryJobStore,
  InMemoryTaskQueue,
  type JobEnvelope,
  type JobHandlerContext,
  noopLogger,
  recoverExecutorJobs,
  type ToolkitAdapter,
} from "../src/index.js";

const API_KEY_A = "ey_test_project_a";
const API_KEY_B = "ey_test_project_b";
const PROJECT_A = "proj_a";
const PROJECT_B = "proj_b";
const USER_1 = "user_1";
const USER_2 = "user_2";
const VALID_TOKEN = "fixture:VALID_TOKEN";

interface VendorCall {
  authorization?: string;
  body: unknown;
  url: string;
}

interface HarnessOptions {
  asyncAnnotation?: boolean;
  beforeAdapterExecute?: () => Promise<void>;
  credential?: ResolvedCredential;
  credentialFailure?: Error;
  emptyOutput?: boolean;
  includeAdapter?: boolean;
  invalidOutput?: boolean;
  maxConcurrentExecutionsPerProject?: number;
  outputDefault?: boolean;
  pinnedUserId?: string;
  queueConcurrency?: number;
  readOnly?: boolean;
  rejectFirstJobAdmission?: boolean;
  token?: string;
}

class FailFirstAdmissionJobStore extends InMemoryJobStore {
  #failed = false;

  override async ensure(job: JobEnvelope): Promise<EnsureJobResult> {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("Injected durable admission failure.");
    }
    return super.ensure(job);
  }
}

function echoContract(options: HarnessOptions): CapabilityToolContract {
  return {
    capability: "ai_media_utilities",
    name: "run",
    description:
      "Return a canonical echo response for executor contract tests.",
    inputSchema: {
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      $id: "urn:eyeball:test:echo:run:input:1.0.0",
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: { type: "string", minLength: 1 },
        uppercase: { type: "boolean", default: false },
      },
    },
    outputSchema: options.outputDefault
      ? {
          $schema: JSON_SCHEMA_DRAFT_2020_12,
          $id: "urn:eyeball:test:echo:run:output-default:1.0.0",
          type: "object",
          additionalProperties: false,
          required: ["fabricated"],
          properties: {
            fabricated: { type: "boolean", default: true },
          },
        }
      : {
          $schema: JSON_SCHEMA_DRAFT_2020_12,
          $id: "urn:eyeball:test:echo:run:output:1.0.0",
          type: "object",
          additionalProperties: false,
          required: ["echo", "uppercase"],
          properties: {
            echo: { type: "string" },
            uppercase: { type: "boolean" },
          },
        },
    annotations: {
      readOnly: options.readOnly ?? true,
      destructive: options.readOnly === false,
      idempotent: true,
      async: options.asyncAnnotation ?? false,
    },
    version: "1.0.0",
  };
}

function echoManifest(options: HarnessOptions = {}): ProviderManifest {
  return {
    schemaVersion: "1.0",
    catalogVersion: "2.0",
    toolkit: {
      slug: "echo",
      displayName: "Echo",
      source: "native",
      tier: "P0",
    },
    auth: {
      class: "oauth2",
      requiredScopes: ["echo:run"],
    },
    endpoint: {
      baseUrl: "https://provider.example.test/v1",
      baseUrlOverrideEnv: "EYEBALL_ECHO_BASE_URL",
    },
    ...(options.maxConcurrentExecutionsPerProject === undefined
      ? {}
      : {
          limits: {
            maxConcurrentExecutionsPerProject:
              options.maxConcurrentExecutionsPerProject,
          },
        }),
    implements: [
      {
        capability: "ai_media_utilities",
        canonicalTool: "run",
        canonicalVersion: "1.0.0",
        operationId: "echo.run",
      },
    ],
  };
}

class EchoAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "echo";
  readonly #beforeExecute: (() => Promise<void>) | undefined;
  readonly #emptyOutput: boolean;
  readonly #invalidOutput: boolean;

  constructor(
    options: Pick<
      HarnessOptions,
      "beforeAdapterExecute" | "emptyOutput" | "invalidOutput"
    > = {},
  ) {
    this.#beforeExecute = options.beforeAdapterExecute;
    this.#emptyOutput = options.emptyOutput ?? false;
    this.#invalidOutput = options.invalidOutput ?? false;
  }

  async execute(context: AdapterContext): Promise<JsonValue> {
    if (context.tool.name !== "echo.run") {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.NOT_SUPPORTED,
        message: `Echo does not implement ${context.tool.name}.`,
      });
    }
    await this.#beforeExecute?.();
    const client = createProviderHttpClient(context);
    const response = await client("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(context.canonicalInput),
    });
    if (this.#invalidOutput) {
      return { unexpected: true };
    }
    if (this.#emptyOutput) {
      return {};
    }
    return (await response.json()) as JsonValue;
  }
}

function createVendor(calls: VendorCall[]): Hono {
  const vendor = new Hono();
  vendor.post("/echo", async (context) => {
    const authorization = context.req.header("Authorization");
    const body = await context.req.json();
    calls.push({
      ...(authorization === undefined ? {} : { authorization }),
      body,
      url: context.req.url,
    });

    if (
      authorization === `Bearer ${MOCK_CREDENTIAL_TRIGGER_TOKENS.EXPIRED_TOKEN}`
    ) {
      return context.json(
        { error: "invalid_token", message: "The access token expired." },
        401,
      );
    }
    if (
      authorization ===
      `Bearer ${MOCK_CREDENTIAL_TRIGGER_TOKENS.INSUFFICIENT_SCOPE_TOKEN}`
    ) {
      return context.json(
        { error: "insufficient_scope", message: "A scope is missing." },
        403,
      );
    }
    if (
      authorization ===
      `Bearer ${MOCK_CREDENTIAL_TRIGGER_TOKENS.RATE_LIMITED_TOKEN}`
    ) {
      context.header("Retry-After", "12");
      return context.json(
        { error: "rate_limited", message: "Echo quota exceeded." },
        429,
      );
    }

    const input = body as { message: string; uppercase: boolean };
    return context.json({
      echo: input.uppercase ? input.message.toUpperCase() : input.message,
      uppercase: input.uppercase,
    });
  });
  return vendor;
}

function createHarness(options: HarnessOptions = {}) {
  const calls: VendorCall[] = [];
  const vendor = createVendor(calls);
  const catalog = new CatalogRegistry({
    catalogVersion: "2.0",
    contracts: [echoContract(options)],
    manifests: [echoManifest(options)],
  });
  const token = options.token ?? VALID_TOKEN;
  const credential: ResolvedCredential = options.credential ?? {
    type: "oauth2",
    accessToken: token,
    scopes: ["echo:run"],
  };
  const mockCredentials = new MockCredentialProvider(
    [PROJECT_A, PROJECT_B].flatMap((projectId) =>
      [USER_1, USER_2].map((userId) => ({
        match: { projectId, userId, toolkitSlug: "echo" },
        credential,
      })),
    ),
  );
  let credentialResolveCalls = 0;
  const credentialProvider: CredentialProvider = {
    kind: "mock",
    resolve: async (context) => {
      credentialResolveCalls += 1;
      if (options.credentialFailure !== undefined) {
        throw options.credentialFailure;
      }
      return mockCredentials.resolve(context);
    },
  };
  const store = new InMemoryExecutionStore();
  const queue = new InMemoryTaskQueue({
    executionConcurrency: options.queueConcurrency ?? 1,
    ...(options.rejectFirstJobAdmission
      ? { jobStore: new FailFirstAdmissionJobStore() }
      : {}),
  });
  let executionSequence = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    vendor.request(new Request(input, init))) as typeof fetch;
  const engine = new ExecutionEngine({
    catalog,
    adapters: new AdapterRegistry(
      options.includeAdapter === false ? [] : [new EchoAdapter(options)],
    ),
    credentialProvider,
    store,
    queue,
    fetchImpl,
    env: { EYEBALL_ECHO_BASE_URL: "https://mock.vendor.test" },
    executionIdFactory: () => {
      executionSequence += 1;
      return createExecutionId(`test${executionSequence}`);
    },
  });
  queue.bindHandlers(
    createExecutorJobHandlerRegistry({
      engine,
      webhookDeliverer: engine.webhookDeliverer,
    }),
  );
  queue.start();
  const app = createExecutorApp({
    engine,
    apiKeys: {
      [API_KEY_A]:
        options.pinnedUserId === undefined
          ? PROJECT_A
          : { projectId: PROJECT_A, userId: options.pinnedUserId },
      [API_KEY_B]: PROJECT_B,
    },
    requestIdFactory: () => "req_test",
  });

  return {
    app,
    calls,
    engine,
    queue,
    store,
    get credentialResolveCalls() {
      return credentialResolveCalls;
    },
  };
}

const RECOVERY_CREATED_AT = "2026-07-18T04:00:00.000Z";

function recoverySeed(label: string) {
  const executionId = createExecutionId(label);
  const request: ExecuteRequest = {
    ...executeRequest(label, { mode: "async" }),
    input: { message: label, uppercase: false },
  };
  const record: ExecutionRecord & { status: "pending" } = {
    executionId,
    tool: "echo.run",
    toolVersion: "1.0.0",
    catalogVersion: "2.0",
    status: "pending",
    userId: USER_1,
    createdAt: RECOVERY_CREATED_AT,
  };
  const resumeContext: ExecutionResumeContext = {
    version: 1,
    tool: record.tool,
    toolVersion: record.toolVersion,
    toolkitSlug: "echo",
    requiredScopes: ["echo:run"],
    concurrencyBucketKey: `${PROJECT_A}:echo`,
  };
  return {
    executionId,
    request,
    record,
    resumeContext,
    webhookEventId: `evt_${label}`,
  };
}

function recoveryJobContext(label: string): JobHandlerContext {
  return {
    jobId: `job_${label}`,
    queueName: "execution",
    leaseAttempt: 1,
    signal: new AbortController().signal,
    now: () => "2026-07-18T04:00:05.000Z",
  };
}

function executeRequest(
  message: string,
  options: {
    mode?: "sync" | "async";
    tool?: QualifiedToolName;
    userId?: string;
  } = {},
): ExecuteRequest {
  return {
    tool: options.tool ?? "echo.run",
    userId: options.userId ?? USER_1,
    input: { message },
    mode: options.mode ?? "sync",
  };
}

function postExecute(
  app: ReturnType<typeof createExecutorApp>,
  request: unknown,
  options: {
    apiKey?: string;
    idempotencyKey?: string;
    reservedExecutionId?: string;
    userIdHeader?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey ?? API_KEY_A}`,
    "Content-Type": "application/json",
  };
  if (options.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  if (options.reservedExecutionId !== undefined) {
    headers[VOICE_WORKER_EXECUTION_ID_HEADER] = options.reservedExecutionId;
  }
  if (options.userIdHeader !== undefined) {
    headers["X-Eyeball-User-Id"] = options.userIdHeader;
  }
  return app.request("/v1/execute", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
}

function authenticatedGet(
  app: ReturnType<typeof createExecutorApp>,
  path: string,
  apiKey = API_KEY_A,
): Promise<Response> {
  return app.request(path, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

describe("RFC 001 execution API", () => {
  it("executes a validated and defaulted canonical input synchronously", async () => {
    const harness = createHarness();

    const response = await postExecute(harness.app, executeRequest("hello"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      executionId: "exe_test1",
      tool: "echo.run",
      toolVersion: "1.0.0",
      catalogVersion: "2.0",
      status: "succeeded",
      output: { echo: "hello", uppercase: false },
      latencyMs: expect.any(Number),
    });
    expect(harness.calls).toEqual([
      {
        authorization: `Bearer ${VALID_TOKEN}`,
        body: { message: "hello", uppercase: false },
        url: "https://mock.vendor.test/echo",
      },
    ]);
  });

  it("defaults a missing mode from annotations and accepts restricted names", async () => {
    const harness = createHarness();
    const request = {
      ...executeRequest("restricted"),
      tool: "echo__run",
    } as Record<string, unknown>;
    delete request.mode;

    const response = await postExecute(harness.app, request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tool: "echo.run",
      status: "succeeded",
    });
  });

  it("rejects invalid canonical input before credentials or allocation", async () => {
    const harness = createHarness();

    const response = await postExecute(harness.app, {
      ...executeRequest("ignored"),
      input: {},
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: "invalid_input",
        retryable: false,
        message: expect.stringContaining("at input"),
      },
      requestId: "req_test",
    });
    expect(harness.credentialResolveCalls).toBe(0);
    const list = await authenticatedGet(harness.app, "/v1/executions");
    expect(await list.json()).toEqual({ executions: [] });
  });

  it("normalizes an expired provider token after allocation", async () => {
    const harness = createHarness({
      token: MOCK_CREDENTIAL_TRIGGER_TOKENS.EXPIRED_TOKEN,
    });

    const response = await postExecute(harness.app, executeRequest("hello"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      executionId: "exe_test1",
      status: "failed",
      error: {
        code: "auth_expired",
        retryable: false,
        provider: { toolkit: "echo", status: 401 },
      },
    });
  });

  it("preserves insufficient-scope provider failures", async () => {
    const harness = createHarness({
      token: MOCK_CREDENTIAL_TRIGGER_TOKENS.INSUFFICIENT_SCOPE_TOKEN,
    });

    const response = await postExecute(harness.app, executeRequest("hello"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "failed",
      error: { code: "auth_insufficient_scope", retryable: false },
    });
  });

  it("honors Retry-After while normalizing rate limits", async () => {
    const harness = createHarness({
      token: MOCK_CREDENTIAL_TRIGGER_TOKENS.RATE_LIMITED_TOKEN,
    });

    const response = await postExecute(harness.app, executeRequest("hello"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "failed",
      error: {
        code: "rate_limited",
        retryable: true,
        retryAfter: 12,
        provider: { toolkit: "echo", status: 429 },
      },
    });
  });

  it("returns pending for async mode and exposes the terminal poll record", async () => {
    const harness = createHarness();

    const response = await postExecute(
      harness.app,
      executeRequest("queued", { mode: "async" }),
    );
    const pending = (await response.json()) as { executionId: string };

    expect(response.status).toBe(202);
    expect(pending).toEqual({
      executionId: "exe_test1",
      tool: "echo.run",
      toolVersion: "1.0.0",
      catalogVersion: "2.0",
      status: "pending",
    });
    await harness.queue.onIdle();
    const poll = await authenticatedGet(
      harness.app,
      `/v1/executions/${pending.executionId}`,
    );
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({
      executionId: "exe_test1",
      userId: USER_1,
      status: "succeeded",
      output: { echo: "queued", uppercase: false },
      createdAt: expect.any(String),
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      latencyMs: expect.any(Number),
    });
  });

  it("repairs a missing async job when an idempotent client retries admission", async () => {
    const harness = createHarness({ rejectFirstJobAdmission: true });
    const request = executeRequest("repair-admission", { mode: "async" });

    const rejected = await postExecute(harness.app, request, {
      idempotencyKey: "repair-admission",
    });
    expect(rejected.status).toBe(500);
    await expect(
      harness.store.get(PROJECT_A, createExecutionId("test1")),
    ).resolves.toMatchObject({ status: "pending" });

    const replay = await postExecute(harness.app, request, {
      idempotencyKey: "repair-admission",
    });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({
      executionId: "exe_test1",
      status: "pending",
    });
    await harness.queue.onIdle();
    await expect(
      harness.store.get(PROJECT_A, createExecutionId("test1")),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(harness.calls).toHaveLength(1);
  });

  it("rejects sync mode for an async-annotated tool before allocation", async () => {
    const harness = createHarness({ asyncAnnotation: true });

    const rejected = await postExecute(
      harness.app,
      executeRequest("call", { mode: "sync" }),
    );

    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      error: { code: "invalid_input" },
    });
    expect(harness.credentialResolveCalls).toBe(0);
    const accepted = await postExecute(
      harness.app,
      executeRequest("call", { mode: "async" }),
    );
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ status: "pending" });
    await harness.queue.onIdle();
  });

  it("reuses the original execution for an identical idempotent retry", async () => {
    const harness = createHarness();
    const request = executeRequest("same");

    const first = await postExecute(harness.app, request, {
      idempotencyKey: "same-request",
    });
    const second = await postExecute(harness.app, request, {
      idempotencyKey: "same-request",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()) as object).toEqual(await second.json());
    expect(harness.calls).toHaveLength(1);
    expect(harness.credentialResolveCalls).toBe(1);
    const detail = await authenticatedGet(
      harness.app,
      "/v1/executions/exe_test1",
    );
    const record = (await detail.json()) as Record<string, unknown>;
    expect(record).toMatchObject({
      executionId: "exe_test1",
      userId: USER_1,
      status: "succeeded",
    });
    expect(record).not.toHaveProperty("projectId");
    expect(record).not.toHaveProperty("idempotencyKey");
    expect(record).not.toHaveProperty("input");
    expect(record).not.toHaveProperty("mode");
  });

  it("reconciles terminal side effects when an idempotent client retries", async () => {
    const harness = createHarness();
    const workStore = harness.engine.webhookDeliverer.workStore;
    vi.spyOn(workStore, "ensureEvent").mockRejectedValueOnce(
      new Error("Injected webhook admission failure."),
    );
    const request = executeRequest("repair-terminal");

    const rejected = await postExecute(harness.app, request, {
      idempotencyKey: "repair-terminal",
    });
    expect(rejected.status).toBe(500);
    await expect(
      harness.store.get(PROJECT_A, createExecutionId("test1")),
    ).resolves.toMatchObject({ status: "succeeded" });

    const replay = await postExecute(harness.app, request, {
      idempotencyKey: "repair-terminal",
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      executionId: "exe_test1",
      status: "succeeded",
    });
    const recoverable = await harness.store.getRecoverable(
      PROJECT_A,
      createExecutionId("test1"),
    );
    expect(recoverable).toMatchObject({
      usageFinalizedAt: expect.any(String),
      webhookPublishedAt: expect.any(String),
    });
    await expect(
      workStore.getEvent(PROJECT_A, recoverable?.webhookEventId ?? "missing"),
    ).resolves.toBeDefined();
    expect(harness.calls).toHaveLength(1);
    await harness.queue.onIdle();
  });

  it("waits for an in-flight synchronous idempotent replay", async () => {
    let releaseAdapter!: () => void;
    let markStarted!: () => void;
    const adapterStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const adapterReleased = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    const harness = createHarness({
      beforeAdapterExecute: async () => {
        markStarted();
        await adapterReleased;
      },
    });
    const request = executeRequest("overlap");

    const firstPromise = postExecute(harness.app, request, {
      idempotencyKey: "overlap-request",
    });
    await adapterStarted;
    const secondPromise = postExecute(harness.app, request, {
      idempotencyKey: "overlap-request",
    });
    releaseAdapter();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(harness.calls).toHaveLength(1);
  });

  it("rejects overlapping sync dispatch at the manifest concurrency cap", async () => {
    let markStarted!: () => void;
    let releaseAdapter!: () => void;
    let invocation = 0;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    const harness = createHarness({
      maxConcurrentExecutionsPerProject: 1,
      beforeAdapterExecute: async () => {
        invocation += 1;
        if (invocation === 1) {
          markStarted();
          await released;
        }
      },
    });

    const firstPromise = postExecute(
      harness.app,
      executeRequest("first-concurrent"),
    );
    await started;
    const rejected = await postExecute(
      harness.app,
      executeRequest("second-concurrent"),
    );

    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("RateLimit-Limit")).toBe("1");
    expect(rejected.headers.get("RateLimit-Remaining")).toBe("0");
    expect(rejected.headers.get("Retry-After")).toBe("1");
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: TOOL_ERROR_CODES.RATE_LIMITED,
        retryable: true,
        retryAfter: 1,
      },
      requestId: "req_test",
    });

    releaseAdapter();
    expect((await firstPromise).status).toBe(200);
    const afterRelease = await postExecute(
      harness.app,
      executeRequest("after-release"),
    );
    expect(afterRelease.status).toBe(200);
    await expect(afterRelease.json()).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("releases a manifest concurrency permit after adapter failure", async () => {
    let markStarted!: () => void;
    let releaseFailure!: () => void;
    let invocation = 0;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const failureReleased = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const harness = createHarness({
      maxConcurrentExecutionsPerProject: 1,
      beforeAdapterExecute: async () => {
        invocation += 1;
        if (invocation === 1) {
          markStarted();
          await failureReleased;
          throw new Error("intentional adapter failure");
        }
      },
    });

    const failingPromise = postExecute(
      harness.app,
      executeRequest("failing-concurrent"),
    );
    await started;
    expect(
      (await postExecute(harness.app, executeRequest("blocked-by-failure")))
        .status,
    ).toBe(429);
    releaseFailure();
    const failed = await failingPromise;
    expect(failed.status).toBe(200);
    await expect(failed.json()).resolves.toMatchObject({
      status: "failed",
      error: { code: TOOL_ERROR_CODES.PROVIDER_ERROR },
    });

    const afterFailure = await postExecute(
      harness.app,
      executeRequest("after-failure"),
    );
    expect(afterFailure.status).toBe(200);
    await expect(afterFailure.json()).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("keeps capped async work pending until a toolkit permit is available", async () => {
    let markStarted!: () => void;
    let releaseFirst!: () => void;
    let invocation = 0;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const harness = createHarness({
      maxConcurrentExecutionsPerProject: 1,
      queueConcurrency: 2,
      beforeAdapterExecute: async () => {
        invocation += 1;
        if (invocation === 1) {
          markStarted();
          await firstReleased;
        }
      },
    });

    const first = await postExecute(
      harness.app,
      executeRequest("async-first", { mode: "async" }),
    );
    const firstBody = (await first.json()) as { executionId: string };
    await started;
    const second = await postExecute(
      harness.app,
      executeRequest("async-second", { mode: "async" }),
    );
    const secondBody = (await second.json()) as { executionId: string };
    await Promise.resolve();

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(invocation).toBe(1);
    const pendingSecond = await authenticatedGet(
      harness.app,
      `/v1/executions/${secondBody.executionId}`,
    );
    await expect(pendingSecond.json()).resolves.toMatchObject({
      status: "pending",
    });

    releaseFirst();
    await harness.queue.onIdle();
    expect(invocation).toBe(2);
    for (const executionId of [firstBody.executionId, secondBody.executionId]) {
      const terminal = await authenticatedGet(
        harness.app,
        `/v1/executions/${executionId}`,
      );
      await expect(terminal.json()).resolves.toMatchObject({
        status: "succeeded",
      });
    }
  });

  it("preserves a trusted reserved ID across idempotent worker retries", async () => {
    const harness = createHarness();
    const request = executeRequest("reserved");
    const reservedId = createExecutionId("voice_event_7");

    const first = await harness.engine.execute({
      projectId: PROJECT_A,
      request,
      idempotencyKey: "voice-session:session_1:event:7",
      executionId: reservedId,
    });
    const replay = await harness.engine.execute({
      projectId: PROJECT_A,
      request,
      idempotencyKey: "voice-session:session_1:event:7",
      executionId: reservedId,
    });

    expect(first.response.executionId).toBe(reservedId);
    expect(replay.response.executionId).toBe(reservedId);
    expect(replay.replayed).toBe(true);
    await expect(
      harness.engine.execute({
        projectId: PROJECT_A,
        request,
        idempotencyKey: "voice-session:session_1:event:7",
        executionId: createExecutionId("different_voice_event"),
      }),
    ).rejects.toMatchObject({
      httpStatus: 409,
      message:
        "Reserved execution ID does not match the existing idempotent execution.",
    });
    expect(harness.calls).toHaveLength(1);
  });

  it("accepts reserved child identities only from a pinned synchronous worker", async () => {
    const reservedExecutionId = createExecutionId("voice_http_event_7");
    const projectScoped = createHarness();
    const forbidden = await postExecute(
      projectScoped.app,
      executeRequest("reserved"),
      {
        idempotencyKey: "voice-session:session_1:event:7",
        reservedExecutionId,
      },
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({
      error: { code: "auth_insufficient_scope" },
    });

    const pinned = createHarness({ pinnedUserId: USER_1 });
    const missingIdempotency = await postExecute(
      pinned.app,
      executeRequest("reserved"),
      { reservedExecutionId },
    );
    expect(missingIdempotency.status).toBe(422);

    const asynchronous = await postExecute(
      pinned.app,
      executeRequest("reserved", { mode: "async" }),
      {
        idempotencyKey: "voice-session:session_1:event:7",
        reservedExecutionId,
      },
    );
    expect(asynchronous.status).toBe(422);

    const accepted = await postExecute(pinned.app, executeRequest("reserved"), {
      idempotencyKey: "voice-session:session_1:event:7",
      reservedExecutionId,
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      executionId: reservedExecutionId,
      status: "succeeded",
    });
  });

  it("returns 409 without allocating when idempotency parameters drift", async () => {
    const harness = createHarness();
    await postExecute(harness.app, executeRequest("first"), {
      idempotencyKey: "drift",
    });

    const conflict = await postExecute(harness.app, executeRequest("second"), {
      idempotencyKey: "drift",
    });

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: {
        code: "invalid_input",
        message:
          "Idempotency-Key was already used with different request parameters.",
        retryable: false,
      },
      requestId: "req_test",
    });
    const list = await authenticatedGet(harness.app, "/v1/executions");
    expect((await list.json()) as { executions: unknown[] }).toMatchObject({
      executions: [expect.objectContaining({ executionId: "exe_test1" })],
    });
  });

  it("requires idempotency for mutating tools before allocation", async () => {
    const harness = createHarness({ readOnly: false });

    const response = await postExecute(harness.app, executeRequest("mutation"));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_input" },
    });
    const list = await authenticatedGet(harness.app, "/v1/executions");
    expect(await list.json()).toEqual({ executions: [] });
  });

  it("returns not_supported for an unknown or stale tool without allocation", async () => {
    const harness = createHarness();

    const response = await postExecute(
      harness.app,
      executeRequest("hello", { tool: "echo.missing" }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "not_supported",
        message: "Tool echo.missing is not supported.",
        retryable: false,
      },
      requestId: "req_test",
    });
    const list = await authenticatedGet(harness.app, "/v1/executions");
    expect(await list.json()).toEqual({ executions: [] });
  });

  it("records not_supported when a materialized toolkit has no adapter", async () => {
    const harness = createHarness({ includeAdapter: false });

    const response = await postExecute(harness.app, executeRequest("hello"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      executionId: "exe_test1",
      status: "failed",
      error: { code: "not_supported", retryable: false },
    });
    expect(harness.credentialResolveCalls).toBe(0);
  });

  it("checks credential auth class and effective scopes before adapter calls", async () => {
    const wrongClass = createHarness({
      credential: {
        type: "api_key",
        values: { apiKey: "fixture:API_KEY" },
      },
    });
    const wrongClassResponse = await postExecute(
      wrongClass.app,
      executeRequest("hello"),
    );
    expect(await wrongClassResponse.json()).toMatchObject({
      status: "failed",
      error: { code: "auth_missing" },
    });
    expect(wrongClass.calls).toHaveLength(0);

    const missingScope = createHarness({
      credential: {
        type: "oauth2",
        accessToken: VALID_TOKEN,
        scopes: [],
      },
    });
    const missingScopeResponse = await postExecute(
      missingScope.app,
      executeRequest("hello"),
    );
    expect(await missingScopeResponse.json()).toMatchObject({
      status: "failed",
      error: { code: "auth_insufficient_scope" },
    });
    expect(missingScope.calls).toHaveLength(0);
  });

  it("surfaces unexpected credential-provider exceptions as HTTP 500", async () => {
    const harness = createHarness({
      credentialFailure: new TypeError("credential implementation bug"),
    });

    const response = await postExecute(harness.app, executeRequest("hello"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "provider_error",
        message: "The executor encountered an internal error.",
        retryable: false,
      },
      requestId: "req_test",
    });
  });

  it.each([
    ["provider_unavailable", "provider_unavailable", true],
    ["timeout", "timeout", true],
    ["invalid_response", "provider_error", false],
  ] as const)("preserves typed voice-driver %s errors through execution normalization", async (kind, code, retryable) => {
    const harness = createHarness({
      beforeAdapterExecute: async () => {
        throw new VoiceSessionDriverError({
          message: "Safe voice worker failure.",
          kind,
          operation: "get_session",
          ...(kind === "timeout" ? { retryable: true } : {}),
        });
      },
    });

    const response = await postExecute(harness.app, executeRequest("voice"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "failed",
      error: {
        code,
        message: "Safe voice worker failure.",
        retryable,
      },
    });
  });

  it("scopes execution reads and lists to the API key project", async () => {
    const harness = createHarness();
    const created = await postExecute(harness.app, executeRequest("private"));
    const { executionId } = (await created.json()) as { executionId: string };

    const crossProject = await authenticatedGet(
      harness.app,
      `/v1/executions/${executionId}`,
      API_KEY_B,
    );
    expect(crossProject.status).toBe(404);
    expect(await crossProject.json()).toMatchObject({
      error: { code: "not_found" },
      requestId: "req_test",
    });
    const projectBList = await authenticatedGet(
      harness.app,
      "/v1/executions",
      API_KEY_B,
    );
    expect(await projectBList.json()).toEqual({ executions: [] });
  });

  it("fails rather than returning adapter output that violates its schema", async () => {
    const harness = createHarness({ invalidOutput: true });

    const response = await postExecute(
      harness.app,
      executeRequest("bad output"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "failed",
      error: {
        code: "provider_error",
        retryable: false,
        provider: { toolkit: "echo" },
      },
    });
  });

  it("does not insert output-schema defaults into adapter results", async () => {
    const harness = createHarness({ emptyOutput: true, outputDefault: true });

    const response = await postExecute(
      harness.app,
      executeRequest("missing output"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "failed",
      error: { code: "provider_error", retryable: false },
    });
  });

  it("rejects missing and unknown API keys with the same 401 envelope", async () => {
    const harness = createHarness();
    const missing = await harness.app.request("/v1/executions");
    const unknown = await authenticatedGet(
      harness.app,
      "/v1/executions",
      "unknown",
    );

    expect(missing.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await missing.json()).toEqual(await unknown.json());
    const health = await harness.app.request("/health");
    expect(await health.json()).toEqual({
      status: "ok",
      service: "executor",
    });
  });

  it("enforces an API key's pinned end user for body and header identities", async () => {
    const harness = createHarness({ pinnedUserId: USER_1 });

    const accepted = await postExecute(
      harness.app,
      executeRequest("pinned", { userId: USER_1 }),
      { userIdHeader: USER_1 },
    );
    const wrongBody = await postExecute(
      harness.app,
      executeRequest("wrong body", { userId: USER_2 }),
    );
    const wrongHeader = await postExecute(
      harness.app,
      executeRequest("wrong header", { userId: USER_1 }),
      { userIdHeader: USER_2 },
    );

    expect(accepted.status).toBe(200);
    for (const response of [wrongBody, wrongHeader]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "auth_insufficient_scope" },
      });
    }
    expect(harness.calls).toHaveLength(1);
  });

  it("filters and paginates project execution records", async () => {
    const harness = createHarness();
    await postExecute(harness.app, executeRequest("one", { userId: USER_1 }));
    await postExecute(harness.app, executeRequest("two", { userId: USER_2 }));

    const firstPage = await authenticatedGet(
      harness.app,
      "/v1/executions?status=succeeded&limit=1",
    );
    const firstBody = (await firstPage.json()) as {
      executions: Array<{ executionId: string }>;
      nextCursor: string;
    };
    expect(firstBody.executions).toHaveLength(1);

    const restrictedFilter = await authenticatedGet(
      harness.app,
      "/v1/executions?tool=echo__run",
    );
    expect(
      (await restrictedFilter.json()) as { executions: unknown[] },
    ).toMatchObject({ executions: [expect.any(Object), expect.any(Object)] });
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    const secondPage = await authenticatedGet(
      harness.app,
      `/v1/executions?status=succeeded&limit=1&cursor=${encodeURIComponent(
        firstBody.nextCursor,
      )}`,
    );
    expect((await secondPage.json()) as object).toMatchObject({
      executions: [expect.objectContaining({ executionId: "exe_test1" })],
    });
    const userFilter = await authenticatedGet(
      harness.app,
      `/v1/executions?userId=${USER_2}&tool=echo.run`,
    );
    expect((await userFilter.json()) as object).toMatchObject({
      executions: [
        expect.objectContaining({ executionId: "exe_test2", userId: USER_2 }),
      ],
    });
  });

  it("rejects request fields outside the exact ExecuteRequest shape", async () => {
    const harness = createHarness();

    const response = await postExecute(harness.app, {
      ...executeRequest("hello"),
      projectId: "injected-project",
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_input" },
    });
    expect(harness.credentialResolveCalls).toBe(0);
  });

  it("recovers a persisted pending execution through an ID-only startup job", async () => {
    const harness = createHarness();
    const seed = recoverySeed("recovery_pending");
    await harness.store.allocate({
      projectId: PROJECT_A,
      record: seed.record,
      request: seed.request,
      recovery: {
        resumeContext: seed.resumeContext,
        webhookEventId: seed.webhookEventId,
      },
    });
    const jobStore = new InMemoryJobStore();
    await recoverExecutorJobs({
      jobStore,
      executionStore: harness.store,
      webhookWorkStore: harness.engine.webhookDeliverer.workStore,
      webhookDeliveryStore: harness.engine.webhookDeliverer.deliveryStore,
      clock: { now: () => new Date("2026-07-18T04:00:05.000Z") },
      logger: noopLogger,
    });
    const taskSystem = new ExecutorTaskSystem({
      jobStore,
      durable: true,
      manual: true,
    });
    taskSystem.bindHandlers(
      createExecutorJobHandlerRegistry({
        engine: harness.engine,
        webhookDeliverer: harness.engine.webhookDeliverer,
      }),
    );
    taskSystem.start();
    await taskSystem.runOnce();
    await taskSystem.drainOwned();
    await taskSystem.stopClaiming();

    await expect(
      harness.store.get(PROJECT_A, seed.executionId),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(harness.calls).toHaveLength(1);
    await harness.queue.onIdle();
  });

  it("resumes a running execution only when provider dispatch never began", async () => {
    const harness = createHarness();
    const seed = recoverySeed("recovery_before_dispatch");
    await harness.store.allocate({
      projectId: PROJECT_A,
      record: seed.record,
      request: seed.request,
      recovery: {
        resumeContext: seed.resumeContext,
        webhookEventId: seed.webhookEventId,
      },
    });
    await harness.store.update(PROJECT_A, {
      ...seed.record,
      status: "running",
      startedAt: "2026-07-18T04:00:01.000Z",
    });

    await expect(
      harness.engine.runExecutionJob(
        { projectId: PROJECT_A, executionId: seed.executionId },
        recoveryJobContext("before_dispatch"),
      ),
    ).resolves.toEqual({ type: "complete" });
    await expect(
      harness.store.get(PROJECT_A, seed.executionId),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(harness.calls).toHaveLength(1);
    await harness.queue.onIdle();
  });

  it("fails an ambiguous post-dispatch execution without replaying the provider", async () => {
    const harness = createHarness();
    const seed = recoverySeed("recovery_after_dispatch");
    await harness.store.allocate({
      projectId: PROJECT_A,
      record: seed.record,
      request: seed.request,
      recovery: {
        resumeContext: seed.resumeContext,
        webhookEventId: seed.webhookEventId,
      },
    });
    await harness.store.update(PROJECT_A, {
      ...seed.record,
      status: "running",
      startedAt: "2026-07-18T04:00:01.000Z",
    });
    await harness.store.markDispatchStarted(
      PROJECT_A,
      seed.executionId,
      "2026-07-18T04:00:02.000Z",
    );

    await expect(
      harness.engine.runExecutionJob(
        { projectId: PROJECT_A, executionId: seed.executionId },
        recoveryJobContext("after_dispatch"),
      ),
    ).resolves.toEqual({ type: "complete" });
    await expect(
      harness.store.get(PROJECT_A, seed.executionId),
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: TOOL_ERROR_CODES.EXECUTION_INTERRUPTED,
        retryable: false,
      },
    });
    expect(harness.calls).toHaveLength(0);
    await expect(
      harness.engine.webhookDeliverer.workStore.getEvent(
        PROJECT_A,
        seed.webhookEventId,
      ),
    ).resolves.toMatchObject({ eventId: seed.webhookEventId });
    await harness.queue.onIdle();
  });

  it("gives legacy running rows a durable terminal webhook identity without replay", async () => {
    const harness = createHarness();
    const seed = recoverySeed("recovery_legacy_running");
    await harness.store.allocate({
      projectId: PROJECT_A,
      record: seed.record,
      request: seed.request,
    });
    await harness.store.update(PROJECT_A, {
      ...seed.record,
      status: "running",
      startedAt: "2026-07-18T04:00:01.000Z",
    });

    await expect(
      harness.engine.runExecutionJob(
        { projectId: PROJECT_A, executionId: seed.executionId },
        recoveryJobContext("legacy_running"),
      ),
    ).resolves.toEqual({ type: "complete" });
    const recoverable = await harness.store.getRecoverable(
      PROJECT_A,
      seed.executionId,
    );
    expect(recoverable).toMatchObject({
      record: {
        status: "failed",
        error: { code: TOOL_ERROR_CODES.EXECUTION_INTERRUPTED },
      },
      webhookEventId: expect.stringMatching(/^evt_/u),
      webhookPublishedAt: expect.any(String),
    });
    expect(harness.calls).toHaveLength(0);
    await expect(
      harness.engine.webhookDeliverer.workStore.getEvent(
        PROJECT_A,
        recoverable?.webhookEventId ?? "missing",
      ),
    ).resolves.toBeDefined();
    await harness.queue.onIdle();
  });

  it("reconciles terminal webhook effects idempotently after a crash", async () => {
    const harness = createHarness();
    const seed = recoverySeed("recovery_terminal_effects");
    await harness.store.allocate({
      projectId: PROJECT_A,
      record: seed.record,
      request: seed.request,
      recovery: {
        resumeContext: seed.resumeContext,
        webhookEventId: seed.webhookEventId,
      },
    });
    const running: ExecutionRecord & { status: "running" } = {
      ...seed.record,
      status: "running",
      startedAt: "2026-07-18T04:00:01.000Z",
    };
    await harness.store.update(PROJECT_A, running);
    await harness.store.update(PROJECT_A, {
      ...running,
      status: "succeeded",
      completedAt: "2026-07-18T04:00:03.000Z",
      latencyMs: 2_000,
      output: { echo: "recovery_terminal_effects", uppercase: false },
    });

    for (const suffix of ["first", "replay"]) {
      await expect(
        harness.engine.runExecutionJob(
          { projectId: PROJECT_A, executionId: seed.executionId },
          recoveryJobContext(`terminal_${suffix}`),
        ),
      ).resolves.toEqual({ type: "complete" });
    }
    const recoverable = await harness.store.getRecoverable(
      PROJECT_A,
      seed.executionId,
    );
    expect(recoverable).toMatchObject({
      usageFinalizedAt: expect.any(String),
      webhookPublishedAt: expect.any(String),
    });
    await expect(
      harness.engine.webhookDeliverer.workStore.getEvent(
        PROJECT_A,
        seed.webhookEventId,
      ),
    ).resolves.toMatchObject({ eventId: seed.webhookEventId });
    expect(harness.calls).toHaveLength(0);
    await harness.queue.onIdle();
  });
});
