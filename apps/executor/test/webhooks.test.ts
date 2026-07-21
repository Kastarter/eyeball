import { CatalogRegistry } from "@eyeball/catalog";
import {
  type CapabilityToolContract,
  type Clock,
  type CredentialProvider,
  createExecutionId,
  createFileId,
  JSON_SCHEMA_DRAFT_2020_12,
  type JsonValue,
  type ProviderManifest,
  verifyWebhookSignature,
  voiceSessionExecutionId,
  WEBHOOK_ID_HEADER,
  type WebhookDelivery,
} from "@eyeball/core";
import { type Handler, Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  type AdapterContext,
  AdapterRegistry,
  createExecutorApp,
  ExecutionEngine,
  InMemoryJobStore,
  InMemoryTaskQueue,
  InMemoryVoiceWebhookSourceStore,
  InMemoryWebhookDeliveryStore,
  InMemoryWebhookEndpointStore,
  InMemoryWebhookWorkStore,
  type ToolkitAdapter,
  WebhookDeliverer,
} from "../src/index.js";

const API_KEY = "ey_test_webhooks";
const PINNED_API_KEY = "ey_test_webhooks_pinned";
const OTHER_API_KEY = "ey_test_webhooks_other";
const PROJECT_ID = "proj_webhooks";
const OTHER_PROJECT_ID = "proj_webhooks_other";
const USER_ID = "user_webhooks";
const START = "2026-07-17T12:00:00.000Z";

const contract: CapabilityToolContract = {
  capability: "email",
  name: "send_email",
  description: "Return a deterministic webhook test response.",
  inputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: "urn:eyeball:test:webhooks:run:input:1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      message: { type: "string", minLength: 1 },
      attachments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["fileId"],
          properties: {
            fileId: { type: "string", pattern: "^file_[A-Za-z0-9_-]+$" },
            name: { type: "string", minLength: 1 },
            mimeType: { type: "string", minLength: 1 },
          },
        },
      },
    },
  },
  outputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: "urn:eyeball:test:webhooks:run:output:1.0.0",
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
};

const manifest: ProviderManifest = {
  schemaVersion: "1.0",
  catalogVersion: "2.0",
  toolkit: {
    slug: "webhook-fixture",
    displayName: "Webhook fixture",
    source: "native",
    tier: "P0",
  },
  auth: { class: "none", requiredScopes: [] },
  endpoint: {
    baseUrl: "https://provider.example.test",
    baseUrlOverrideEnv: "EYEBALL_WEBHOOK_FIXTURE_BASE_URL",
  },
  implements: [
    {
      capability: "email",
      canonicalTool: "send_email",
      canonicalVersion: "1.0.0",
      operationId: "webhook-fixture.send_email",
    },
  ],
};

class FixtureAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "webhook-fixture";

  async execute(context: AdapterContext): Promise<JsonValue> {
    return { echo: context.canonicalInput.message as string };
  }
}

const credentialProvider: CredentialProvider = {
  kind: "mock",
  resolve: async () => ({ type: "none" }),
};

class ManualWebhookClock implements Clock {
  #now: number;
  readonly #waiters: Array<{ at: number; resolve: () => void }> = [];

  constructor(initial = START) {
    this.#now = Date.parse(initial);
  }

  now(): Date {
    return new Date(this.#now);
  }

  sleep = (milliseconds: number): Promise<void> => {
    if (milliseconds === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#waiters.push({ at: this.#now + milliseconds, resolve });
    });
  };

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      if (waiter !== undefined && waiter.at <= this.#now) {
        this.#waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

interface HarnessOptions {
  receiver?: Hono;
  clock?: ManualWebhookClock;
  retryDelaysMs?: readonly number[];
}

function inProcessFetch(receiver: Hono): typeof globalThis.fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => receiver.request(new Request(input, init))) as typeof globalThis.fetch;
}

function createHarness(options: HarnessOptions = {}) {
  const clock = options.clock ?? new ManualWebhookClock();
  const endpointStore = new InMemoryWebhookEndpointStore();
  const deliveryStore = new InMemoryWebhookDeliveryStore();
  const receiver = options.receiver ?? new Hono();
  const webhookDeliverer = new WebhookDeliverer({
    endpointStore,
    deliveryStore,
    fetchImpl: inProcessFetch(receiver),
    clock,
    sleep: clock.sleep,
    ...(options.retryDelaysMs === undefined
      ? {}
      : { retryDelaysMs: options.retryDelaysMs }),
  });
  let executionSequence = 0;
  const engine = new ExecutionEngine({
    catalog: new CatalogRegistry({
      catalogVersion: "2.0",
      contracts: [contract],
      manifests: [manifest],
    }),
    adapters: new AdapterRegistry([new FixtureAdapter()]),
    credentialProvider,
    clock,
    webhookDeliverer,
    executionIdFactory: () => {
      executionSequence += 1;
      return createExecutionId(`webhook${executionSequence}`);
    },
  });
  const app = createExecutorApp({
    engine,
    apiKeys: {
      [API_KEY]: PROJECT_ID,
      [PINNED_API_KEY]: { projectId: PROJECT_ID, userId: USER_ID },
      [OTHER_API_KEY]: OTHER_PROJECT_ID,
    },
    requestIdFactory: () => "req_webhook_test",
  });
  return {
    app,
    clock,
    deliveryStore,
    endpointStore,
    engine,
    webhookDeliverer,
  };
}

function auth(apiKey = API_KEY): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

function postJson(
  app: ReturnType<typeof createExecutorApp>,
  path: string,
  body: unknown,
  apiKey = API_KEY,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { ...auth(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createEndpoint(
  harness: ReturnType<typeof createHarness>,
  events: readonly (
    | "execution.completed"
    | "execution.failed"
    | "voice.session.event"
    | "voice.transcript.ready"
    | "voice.observer.failed"
  )[] = ["execution.completed"],
) {
  return harness.endpointStore.create(PROJECT_ID, {
    url: "https://receiver.example.test/hook",
    events,
    active: true,
    createdAt: harness.clock.now().toISOString(),
  });
}

function execute(engine: ExecutionEngine, message = "delivered") {
  return engine.execute({
    projectId: PROJECT_ID,
    request: {
      tool: "webhook-fixture.send_email",
      userId: USER_ID,
      input: { message },
      mode: "sync",
    },
  });
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  for (let iteration = 0; iteration < 100; iteration += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

async function onlyDelivery(
  harness: ReturnType<typeof createHarness>,
  endpointId: string,
): Promise<WebhookDelivery> {
  const page = await harness.deliveryStore.list(PROJECT_ID, endpointId, {
    limit: 100,
  });
  const delivery = page.deliveries[0];
  if (delivery === undefined) throw new Error("Expected one webhook delivery.");
  return delivery;
}

describe("webhook endpoint API", () => {
  it("keeps endpoints project-scoped and returns the signing secret only once", async () => {
    const harness = createHarness();
    const createdResponse = await postJson(harness.app, "/v1/webhooks", {
      url: "https://receiver.example.test/hook",
      events: ["execution.completed", "voice.session.event"],
      active: true,
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      endpointId: string;
      secret: string;
      secretPrefix: string;
    };
    expect(created.endpointId).toMatch(/^whe_/u);
    expect(created.secret).toMatch(/^whsec_/u);
    expect(created.secret.startsWith(created.secretPrefix)).toBe(true);

    const listResponse = await harness.app.request("/v1/webhooks", {
      headers: auth(),
    });
    const listBody = (await listResponse.json()) as {
      webhooks: Array<Record<string, unknown>>;
    };
    expect(listBody.webhooks).toHaveLength(1);
    expect(listBody.webhooks[0]).not.toHaveProperty("secret");
    expect(listBody.webhooks[0]).toMatchObject({
      endpointId: created.endpointId,
      secretPrefix: created.secretPrefix,
    });

    const getResponse = await harness.app.request(
      `/v1/webhooks/${created.endpointId}`,
      { headers: auth() },
    );
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.not.toHaveProperty("secret");

    const updateResponse = await harness.app.request(
      `/v1/webhooks/${created.endpointId}`,
      {
        method: "PATCH",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ events: ["execution.failed"], active: false }),
      },
    );
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      endpointId: created.endpointId,
      events: ["execution.failed"],
      active: false,
    });

    const rotateResponse = await harness.app.request(
      `/v1/webhooks/${created.endpointId}/rotate-secret`,
      { method: "POST", headers: auth() },
    );
    expect(rotateResponse.status).toBe(200);
    const rotated = (await rotateResponse.json()) as {
      endpointId: string;
      secret: string;
      secretPrefix: string;
    };
    expect(rotated.endpointId).toBe(created.endpointId);
    expect(rotated.secret).toMatch(/^whsec_/u);
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.secret.startsWith(rotated.secretPrefix)).toBe(true);

    const otherProject = await harness.app.request("/v1/webhooks", {
      headers: auth(OTHER_API_KEY),
    });
    await expect(otherProject.json()).resolves.toEqual({ webhooks: [] });

    const pinned = await harness.app.request("/v1/webhooks", {
      headers: auth(PINNED_API_KEY),
    });
    expect(pinned.status).toBe(403);

    const deleted = await harness.app.request(
      `/v1/webhooks/${created.endpointId}`,
      { method: "DELETE", headers: auth() },
    );
    expect(deleted.status).toBe(204);
    const missing = await harness.app.request(
      `/v1/webhooks/${created.endpointId}`,
      { headers: auth() },
    );
    expect(missing.status).toBe(404);
  });

  it("rejects private, FQDN-loopback, and IPv4-mapped IPv6 receiver addresses", async () => {
    const harness = createHarness();
    for (const url of [
      "https://127.0.0.1/hook",
      "https://2130706433/hook",
      "https://0x7f000001/hook",
      "https://0177.0.0.1/hook",
      "https://127.1/hook",
      "https://localhost./hook",
      "https://localhost%2e/hook",
      "https://service.localhost./hook",
      "https://metadata.local./hook",
      "https://[::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
    ]) {
      const response = await postJson(harness.app, "/v1/webhooks", {
        url,
        events: ["execution.completed"],
      });
      expect(response.status).toBe(422);
    }
  });
});

describe("signed webhook delivery", () => {
  it("delivers a valid RFC envelope and exposes its successful delivery log", async () => {
    let secret = "";
    const received: Array<{
      body: string;
      redirect: RequestRedirect;
      valid: boolean;
      webhookId: string | null;
    }> = [];
    const receiver = new Hono();
    receiver.post("/hook", async (context) => {
      const body = await context.req.text();
      received.push({
        body,
        redirect: context.req.raw.redirect,
        valid: verifyWebhookSignature({
          payload: body,
          headers: context.req.raw.headers,
          secret,
          now: Date.parse(START),
        }),
        webhookId: context.req.header(WEBHOOK_ID_HEADER) ?? null,
      });
      return context.body(null, 204);
    });
    const harness = createHarness({ receiver });
    const endpoint = await createEndpoint(harness);
    secret = endpoint.secret;

    const sessionId = "session_webhook_source";
    const executionId = voiceSessionExecutionId(sessionId, "webhook:event:1");
    const idempotencyKey = `voice-session:${sessionId}:event:1`;
    const attachmentId = createFileId("webhook_attachment");
    const command = {
      projectId: PROJECT_ID,
      executionId,
      idempotencyKey,
      source: { kind: "voice_session" as const, sessionId },
      request: {
        tool: "webhook-fixture.send_email" as const,
        userId: USER_ID,
        input: {
          message: "delivered",
          attachments: [
            {
              fileId: attachmentId,
              name: "private-webhook-attachment.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
        mode: "sync" as const,
      },
    };
    const outcome = await harness.engine.execute(command);
    expect(outcome.response.status).toBe("succeeded");
    await harness.webhookDeliverer.onIdle();

    expect(received).toHaveLength(1);
    expect(received[0]?.valid).toBe(true);
    expect(received[0]?.redirect).toBe("manual");
    const event = JSON.parse(received[0]?.body ?? "{}") as {
      id: string;
      type: string;
      projectId: string;
      data: Record<string, unknown> & { status: string };
    };
    expect(event).toMatchObject({
      type: "execution.succeeded",
      projectId: PROJECT_ID,
      data: {
        status: "succeeded",
        source: { kind: "voice_session", sessionId },
        attachments: { count: 1, fileIds: [attachmentId] },
      },
    });
    for (const privateField of [
      "projectId",
      "input",
      "mode",
      "connectionId",
      "idempotencyKey",
      "requestHash",
    ]) {
      expect(event.data).not.toHaveProperty(privateField);
    }
    expect(received[0]?.body).not.toContain(idempotencyKey);
    expect(received[0]?.body).not.toContain("private-webhook-attachment.pdf");
    expect(received[0]?.body).not.toContain("application/pdf");
    expect(received[0]?.webhookId).toBe(event.id);

    const logResponse = await harness.app.request(
      `/v1/webhooks/${endpoint.endpointId}/deliveries`,
      { headers: auth() },
    );
    expect(logResponse.status).toBe(200);
    await expect(logResponse.json()).resolves.toMatchObject({
      deliveries: [
        {
          endpointId: endpoint.endpointId,
          eventId: event.id,
          eventType: "execution.succeeded",
          status: "succeeded",
          attempts: [{ attempt: 1, statusCode: 204 }],
        },
      ],
    });
    const replay = await harness.engine.execute(command);
    expect(replay.replayed).toBe(true);
    await harness.webhookDeliverer.onIdle();
    expect(received).toHaveLength(1);
    await expect(
      harness.engine.getExecution(PROJECT_ID, executionId),
    ).resolves.toMatchObject({ replayed: true });
    const afterReplay = await harness.app.request(
      `/v1/webhooks/${endpoint.endpointId}/deliveries`,
      { headers: auth() },
    );
    const history = JSON.stringify(await afterReplay.json());
    expect(history.match(/whd_/gu)).toHaveLength(1);
    expect(history).not.toContain("payload");
    expect(history).not.toContain(idempotencyKey);
  });

  it("projects replay provenance when a replay repairs webhook admission", async () => {
    const received: string[] = [];
    const receiver = new Hono();
    receiver.post("/hook", async (context) => {
      received.push(await context.req.text());
      return context.body(null, 204);
    });
    const harness = createHarness({ receiver });
    await createEndpoint(harness);
    vi.spyOn(
      harness.webhookDeliverer.workStore,
      "ensureEvent",
    ).mockRejectedValueOnce(new Error("Injected webhook admission failure."));
    const idempotencyKey = "webhook-replay-before-claim";
    const run = () =>
      harness.engine.execute({
        projectId: PROJECT_ID,
        idempotencyKey,
        request: {
          tool: "webhook-fixture.send_email",
          userId: USER_ID,
          input: { message: "replay-before-claim" },
          mode: "sync",
        },
      });

    await expect(run()).rejects.toThrow("Injected webhook admission failure.");
    expect(received).toHaveLength(0);

    const replay = await run();
    expect(replay.replayed).toBe(true);
    await harness.webhookDeliverer.onIdle();

    expect(received).toHaveLength(1);
    const event = JSON.parse(received[0] ?? "{}") as {
      data: Record<string, unknown>;
    };
    expect(event.data).toMatchObject({
      status: "succeeded",
      replayed: true,
    });
    expect(received[0]).not.toContain(idempotencyKey);
  });

  it("follows the injected retry schedule and succeeds on the third attempt", async () => {
    const attempts: string[] = [];
    const receiver = new Hono();
    receiver.post("/hook", (context) => {
      attempts.push(context.req.header("Eyeball-Webhook-Timestamp") ?? "");
      return attempts.length < 3
        ? context.json({ retry: true }, 503)
        : context.body(null, 204);
    });
    const harness = createHarness({ receiver });
    const endpoint = await createEndpoint(harness);

    await execute(harness.engine);
    await until(
      () => attempts.length === 1,
      "First webhook attempt did not run.",
    );
    let delivery = await onlyDelivery(harness, endpoint.endpointId);
    expect(delivery).toMatchObject({
      status: "pending",
      nextRetryAt: "2026-07-17T12:00:30.000Z",
      attempts: [{ attempt: 1, statusCode: 503 }],
    });

    harness.clock.advance(29_999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(attempts).toHaveLength(1);
    harness.clock.advance(1);
    await until(
      () => attempts.length === 2,
      "Second webhook attempt did not run.",
    );
    delivery = await onlyDelivery(harness, endpoint.endpointId);
    expect(delivery.nextRetryAt).toBe("2026-07-17T12:02:30.000Z");

    harness.clock.advance(120_000);
    await until(
      () => attempts.length === 3,
      "Third webhook attempt did not run.",
    );
    await harness.webhookDeliverer.onIdle();
    delivery = await onlyDelivery(harness, endpoint.endpointId);
    expect(delivery.status).toBe("succeeded");
    expect(delivery.attempts.map(({ statusCode }) => statusCode)).toEqual([
      503, 503, 204,
    ]);
    expect(attempts).toEqual(["1784289600", "1784289630", "1784289750"]);
  });

  it("re-resolves the endpoint URL and signing secret before a retry", async () => {
    let secret = "";
    const received: Array<{ body: string; path: string; valid: boolean }> = [];
    const receiver = new Hono();
    const receive: Handler = async (context) => {
      const body = await context.req.text();
      received.push({
        body,
        path: context.req.path,
        valid: verifyWebhookSignature({
          payload: body,
          headers: context.req.raw.headers,
          secret,
          now: Date.parse(START),
        }),
      });
      return received.length === 1
        ? context.json({ retry: true }, 503)
        : context.body(null, 204);
    };
    receiver.post("/hook", receive);
    receiver.post("/rotated", receive);
    const harness = createHarness({ receiver });
    const endpoint = await createEndpoint(harness);
    secret = endpoint.secret;

    await execute(harness.engine, "resolve-current-endpoint");
    await until(
      () => received.length === 1,
      "First webhook attempt did not run.",
    );
    const rotated = await harness.endpointStore.rotateSecret(
      PROJECT_ID,
      endpoint.endpointId,
      harness.clock.now().toISOString(),
    );
    if (rotated === undefined) throw new Error("Expected endpoint rotation.");
    secret = rotated.secret;
    await harness.endpointStore.update(PROJECT_ID, endpoint.endpointId, {
      url: "https://receiver.example.test/rotated",
      updatedAt: harness.clock.now().toISOString(),
    });
    harness.clock.advance(30_000);
    await until(
      () => received.length === 2,
      "Rotated webhook retry did not run.",
    );
    await harness.webhookDeliverer.onIdle();

    expect(received.map(({ path }) => path)).toEqual(["/hook", "/rotated"]);
    expect(received.map(({ valid }) => valid)).toEqual([true, true]);
    expect(received[1]?.body).toBe(received[0]?.body);
  });

  it("delivers immediately when an event timestamp is ahead of the worker clock", async () => {
    let received = 0;
    const receiver = new Hono();
    receiver.post("/hook", (context) => {
      received += 1;
      return context.body(null, 204);
    });
    const harness = createHarness({ receiver });
    await createEndpoint(harness);

    await harness.webhookDeliverer.enqueueExecution(PROJECT_ID, {
      executionId: createExecutionId("future_webhook"),
      tool: "webhook-fixture.send_email",
      toolVersion: "1.0.0",
      catalogVersion: "2.0",
      status: "succeeded",
      userId: USER_ID,
      createdAt: START,
      startedAt: START,
      completedAt: "2026-07-17T13:00:00.000Z",
      output: { echo: "future" },
      latencyMs: 0,
    });

    await harness.webhookDeliverer.onIdle();
    expect(received).toBe(1);
  });

  it("gives up after five attempts and retains every response status", async () => {
    let attemptCount = 0;
    const receiver = new Hono();
    receiver.post("/hook", (context) => {
      attemptCount += 1;
      return context.json({ unavailable: true }, 503);
    });
    const harness = createHarness({ receiver });
    const endpoint = await createEndpoint(harness);

    await execute(harness.engine);
    for (let expected = 1; expected <= 4; expected += 1) {
      await until(
        () => attemptCount === expected,
        `Webhook attempt ${expected} did not run.`,
      );
      const delivery = await onlyDelivery(harness, endpoint.endpointId);
      if (delivery.nextRetryAt === undefined) {
        throw new Error("Retrying delivery omitted nextRetryAt.");
      }
      harness.clock.advance(
        Date.parse(delivery.nextRetryAt) - harness.clock.now().valueOf(),
      );
    }
    await until(() => attemptCount === 5, "Fifth webhook attempt did not run.");
    await harness.webhookDeliverer.onIdle();

    const delivery = await onlyDelivery(harness, endpoint.endpointId);
    expect(delivery.status).toBe("failed");
    expect(delivery).not.toHaveProperty("nextRetryAt");
    expect(delivery.attempts).toHaveLength(5);
    expect(delivery.attempts.map(({ statusCode }) => statusCode)).toEqual([
      503, 503, 503, 503, 503,
    ]);
  });

  it("finalizes execution without waiting for a hanging receiver", async () => {
    let started: (() => void) | undefined;
    const receiverStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const receiver = new Hono();
    receiver.post("/hook", () => {
      started?.();
      return new Promise<Response>(() => undefined);
    });
    const harness = createHarness({ receiver });
    await createEndpoint(harness);

    const outcome = await Promise.race([
      execute(harness.engine),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Execution waited for webhook delivery.")),
          100,
        ),
      ),
    ]);
    expect(outcome.response.status).toBe("succeeded");
    await Promise.race([
      receiverStarted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Webhook was not scheduled.")), 100),
      ),
    ]);
    const execution = await harness.engine.getExecution(
      PROJECT_ID,
      outcome.response.executionId,
    );
    expect(execution.status).toBe("succeeded");
  });
});

describe("durable voice webhook sources", () => {
  it("reconstructs session, transcript, and observer-failure bodies on a new deliverer", async () => {
    const received: string[] = [];
    const receiver = new Hono();
    receiver.post("/hook", async (context) => {
      const body = (await context.req.json()) as { type: string };
      received.push(body.type);
      return context.body(null, 204);
    });
    const clock = new ManualWebhookClock();
    const endpointStore = new InMemoryWebhookEndpointStore();
    const deliveryStore = new InMemoryWebhookDeliveryStore();
    const jobStore = new InMemoryJobStore();
    const workStore = new InMemoryWebhookWorkStore(deliveryStore, jobStore);
    const sourceStore = new InMemoryVoiceWebhookSourceStore();
    const dormantQueue = new InMemoryTaskQueue({ jobStore, clock });
    const first = new WebhookDeliverer({
      endpointStore,
      deliveryStore,
      workStore,
      voiceSourceStore: sourceStore,
      queue: dormantQueue,
      fetchImpl: inProcessFetch(receiver),
      clock,
    });
    const endpoint = await endpointStore.create(PROJECT_ID, {
      url: "https://receiver.example.test/hook",
      events: [
        "voice.session.event",
        "voice.transcript.ready",
        "voice.observer.failed",
      ],
      active: true,
      createdAt: START,
    });
    const sessionId = "session_durable_voice_source";
    await first.enqueueVoiceSessionEvent({
      projectId: PROJECT_ID,
      endpointIds: [endpoint.endpointId],
      event: {
        id: "voice_event_durable_source",
        sessionId,
        sequence: 1,
        createdAt: START,
        data: { type: "session.lifecycle", to: "created" },
      },
    });
    await first.enqueueVoiceTranscript({
      projectId: PROJECT_ID,
      endpointIds: [endpoint.endpointId],
      createdAt: START,
      transcript: {
        id: `transcript_${sessionId}`,
        sessionId,
        agentId: "va_durable_source",
        agentRevision: 1,
        transport: "chat",
        final: true,
        startedAt: START,
        turns: [],
      },
    });
    const failure = {
      sessionId,
      agentId: "va_durable_source",
      agentRevision: 1,
      lastHandledSequence: 1,
      attempts: 20,
      reason: "retry_exhausted" as const,
      operation: "get_events" as const,
      error: {
        code: "provider_unavailable" as const,
        message: "The remote voice worker is unavailable.",
        retryable: true,
      },
    };
    await first.enqueueVoiceObserverFailure({
      projectId: PROJECT_ID,
      endpointIds: [endpoint.endpointId],
      createdAt: START,
      data: failure,
    });
    await first.enqueueVoiceObserverFailure({
      projectId: PROJECT_ID,
      endpointIds: [endpoint.endpointId],
      createdAt: START,
      data: failure,
    });

    const resumedQueue = new InMemoryTaskQueue({ jobStore, clock });
    const resumed = new WebhookDeliverer({
      endpointStore,
      deliveryStore,
      workStore,
      voiceSourceStore: sourceStore,
      queue: resumedQueue,
      fetchImpl: inProcessFetch(receiver),
      clock,
    });
    resumedQueue.bindHandlers({
      "execution.run.v1": async () => ({ type: "complete" }),
      "webhook.select.v1": (payload, context) =>
        resumed.handleWebhookSelectJob(payload, context),
      "webhook.deliver.v1": (payload, context) =>
        resumed.handleWebhookDeliverJob(payload, context),
    });
    resumedQueue.start();
    await until(async () => {
      await resumedQueue.runOnce();
      return received.length === 3;
    }, "Reconstructed voice webhook jobs did not run.");
    await resumed.onIdle();

    expect(received.sort()).toEqual([
      "voice.observer.failed",
      "voice.session.event",
      "voice.transcript.ready",
    ]);
    const page = await deliveryStore.list(PROJECT_ID, endpoint.endpointId, {
      limit: 100,
    });
    expect(page.deliveries).toHaveLength(3);
    await resumedQueue.stopClaiming();
    await resumedQueue.drainOwned();
  });

  it("defers legacy voice work whose durable source has not been rehydrated", async () => {
    const clock = new ManualWebhookClock();
    const endpointStore = new InMemoryWebhookEndpointStore();
    const deliveryStore = new InMemoryWebhookDeliveryStore();
    const jobStore = new InMemoryJobStore();
    const workStore = new InMemoryWebhookWorkStore(deliveryStore, jobStore);
    const endpoint = await endpointStore.create(PROJECT_ID, {
      url: "https://receiver.example.test/hook",
      events: ["voice.session.event"],
      active: true,
      createdAt: START,
    });
    await workStore.ensureEvent({
      projectId: PROJECT_ID,
      eventId: "legacy_voice_event",
      eventType: "voice.session.event",
      sourceKind: "voice-session-event",
      sourceId: "legacy_voice_event",
      endpointIds: [endpoint.endpointId],
      createdAt: START,
      selectionRunAfter: START,
    });
    const [materialized] = await workStore.materializeEvent({
      projectId: PROJECT_ID,
      eventId: "legacy_voice_event",
      endpointIds: [endpoint.endpointId],
      materializedAt: START,
    });
    if (materialized === undefined)
      throw new Error("Expected delivery materialization.");
    const deliverer = new WebhookDeliverer({
      endpointStore,
      deliveryStore,
      workStore,
      voiceSourceStore: new InMemoryVoiceWebhookSourceStore(),
      queue: new InMemoryTaskQueue({ jobStore, clock }),
      clock,
    });
    const result = await deliverer.handleWebhookDeliverJob(
      {
        projectId: PROJECT_ID,
        deliveryId: materialized.delivery.deliveryId,
      },
      {
        jobId: "job_missing_voice_source",
        queueName: "webhook-delivery",
        leaseAttempt: 1,
        signal: new AbortController().signal,
        now: () => clock.now().toISOString(),
      },
    );

    expect(result).toEqual({
      type: "reschedule",
      runAfter: "2026-07-17T12:00:01.000Z",
    });
    await expect(
      deliveryStore.get(PROJECT_ID, materialized.delivery.deliveryId),
    ).resolves.toMatchObject({ status: "pending" });
  });
});
