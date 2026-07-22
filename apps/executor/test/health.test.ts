import { MockCredentialProvider } from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  createExecutorApp,
  createExecutorReadiness,
  createExecutorRuntime,
  createPgliteStoreBundle,
  type DatabaseReadinessProbes,
  ExecutionEngine,
  type ManagedTaskQueue,
  QueueNotAcceptingError,
  RemoteCredentialProvider,
  app as stockApp,
} from "../src/index.js";

const READY_REPORT = {
  status: "ready",
  service: "executor",
  checks: {
    database: { status: "ok" },
    migrations: { status: "ok" },
    credentials: { status: "ok" },
    queue: { status: "ok" },
  },
} as const;

function appWithDatabase(
  database: DatabaseReadinessProbes,
  probeTimeoutMs?: number,
) {
  const credentialProvider = new MockCredentialProvider([]);
  const engine = new ExecutionEngine({ credentialProvider });
  return createExecutorApp({
    engine,
    readiness: createExecutorReadiness({
      database,
      credentialProvider,
      queue: engine.queue,
      ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }),
    }),
  });
}

describe("executor health endpoints", () => {
  it("keeps liveness public and dependency-free", async () => {
    const engine = new ExecutionEngine();
    const queue = engine.queue as ManagedTaskQueue;
    await queue.stopClaiming();
    const app = createExecutorApp({ engine });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "executor",
    });
  });

  it("reports zero-config readiness without authentication", async () => {
    const response = await stockApp.request("/ready");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(READY_REPORT);
  });

  it("fails closed when the database becomes unreachable", async () => {
    const bundle = await createPgliteStoreBundle();
    await bundle.close();

    const response = await appWithDatabase(bundle.readiness).request("/ready");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      service: "executor",
      checks: {
        database: { status: "error" },
        migrations: { status: "error" },
        credentials: { status: "ok" },
        queue: { status: "ok" },
      },
    });
  });

  it("fails closed when the committed migration journal is not fully applied", async () => {
    const bundle = await createPgliteStoreBundle();
    try {
      expect(
        (await appWithDatabase(bundle.readiness).request("/ready")).status,
      ).toBe(200);
      await bundle.client.query(`
        DELETE FROM drizzle.__drizzle_migrations
        WHERE created_at = (
          SELECT MAX(created_at) FROM drizzle.__drizzle_migrations
        )
      `);

      const response = await appWithDatabase(bundle.readiness).request(
        "/ready",
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        status: "not_ready",
        checks: {
          database: { status: "ok" },
          migrations: { status: "error" },
          credentials: { status: "ok" },
          queue: { status: "ok" },
        },
      });
    } finally {
      await bundle.close();
    }
  });

  it("bounds a readiness probe that never settles", async () => {
    const neverSettles = new Promise<void>(() => {});
    const response = await appWithDatabase(
      {
        connectivity: { check: () => neverSettles },
        migrations: { check: async () => {} },
      },
      25,
    ).request("/ready");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      service: "executor",
      checks: {
        database: { status: "error" },
        migrations: { status: "ok" },
        credentials: { status: "ok" },
        queue: { status: "ok" },
      },
    });
  });

  it("fails closed on a misconfigured cloud credential endpoint", async () => {
    const secret = "credential-readiness-secret-at-least-32-characters";
    const provider = new RemoteCredentialProvider({
      endpoint: "https://cloud.example.test/internal/credentials/wrong",
      internalApiSecret: secret,
      fetchImpl: async () =>
        Response.json({ error: { code: "not_found" } }, { status: 404 }),
    });
    const engine = new ExecutionEngine({ credentialProvider: provider });
    const response = await createExecutorApp({ engine }).request("/ready");
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({
      status: "not_ready",
      service: "executor",
      checks: {
        database: { status: "ok" },
        migrations: { status: "ok" },
        credentials: { status: "error" },
        queue: { status: "ok" },
      },
    });
    expect(text).not.toContain(secret);
    expect(text).not.toContain("cloud.example.test");
  });

  it("accepts the cloud resolver's sentinel missing-credential response", async () => {
    const requests: Array<{
      authorization: string | null;
      body: string | undefined;
    }> = [];
    const provider = new RemoteCredentialProvider({
      endpoint: "https://cloud.example.test/internal/credentials/resolve",
      internalApiSecret: "credential-readiness-secret-at-least-32-characters",
      fetchImpl: async (_input, init) => {
        requests.push({
          authorization: new Headers(init?.headers).get("Authorization"),
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return Response.json(
          { error: { code: "auth_missing" } },
          { status: 404 },
        );
      },
    });
    const engine = new ExecutionEngine({ credentialProvider: provider });

    const response = await createExecutorApp({ engine }).request("/ready");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(READY_REPORT);
    expect(requests).toEqual([
      {
        authorization:
          "Bearer credential-readiness-secret-at-least-32-characters",
        body: JSON.stringify({
          projectId: "__eyeball_readiness_probe__",
          userId: "eyeball-readiness-probe",
          toolkit: "eyeball-readiness-probe",
          connectionId: "__eyeball_readiness_probe__",
        }),
      },
    ]);
  });

  it("rejects a wrong internal route's generic schema error", async () => {
    const provider = new RemoteCredentialProvider({
      endpoint: "https://cloud.example.test/internal/keys/verify",
      internalApiSecret: "credential-readiness-secret-at-least-32-characters",
      fetchImpl: async () =>
        Response.json({ error: { code: "invalid_request" } }, { status: 422 }),
    });
    const engine = new ExecutionEngine({ credentialProvider: provider });

    const response = await createExecutorApp({ engine }).request("/ready");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      checks: { credentials: { status: "error" } },
    });
  });

  it("fails closed when a cloud resolver backing dependency fails", async () => {
    const provider = new RemoteCredentialProvider({
      endpoint: "https://cloud.example.test/internal/credentials/resolve",
      internalApiSecret: "credential-readiness-secret-at-least-32-characters",
      fetchImpl: async () =>
        Response.json(
          { error: { code: "provider_unavailable" } },
          { status: 503 },
        ),
    });
    const engine = new ExecutionEngine({ credentialProvider: provider });

    const response = await createExecutorApp({ engine }).request("/ready");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      checks: { credentials: { status: "error" } },
    });
  });

  it("fails closed when the durable queue rejects admission", async () => {
    const bundle = await createPgliteStoreBundle();
    const runtime = await createExecutorRuntime({
      env: {
        EYEBALL_DATABASE_URL: "postgresql://readiness.invalid/eyeball",
      },
      persistenceFactory: async () => bundle,
    });
    try {
      const queue = runtime.engine.queue as ManagedTaskQueue;
      await queue.stopClaiming();
      const submission = queue.submit({
        kind: "execution.run.v1",
        payload: {
          projectId: "project_readiness_rejected",
          executionId: "exe_readiness_rejected",
        },
      });

      await expect(submission.accepted).rejects.toBeInstanceOf(
        QueueNotAcceptingError,
      );

      const response = await createExecutorApp({
        engine: runtime.engine,
        readiness: runtime.readiness,
      }).request("/ready");

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        status: "not_ready",
        service: "executor",
        checks: {
          database: { status: "ok" },
          migrations: { status: "ok" },
          credentials: { status: "ok" },
          queue: { status: "error" },
        },
      });
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when the durable admission table is unavailable", async () => {
    const bundle = await createPgliteStoreBundle();
    const runtime = await createExecutorRuntime({
      env: {
        EYEBALL_DATABASE_URL: "postgresql://readiness.invalid/eyeball",
      },
      persistenceFactory: async () => bundle,
    });
    const app = createExecutorApp({
      engine: runtime.engine,
      readiness: runtime.readiness,
    });
    try {
      expect((await app.request("/ready")).status).toBe(200);
      await bundle.client.query('DROP TABLE "task_jobs"');

      const queue = runtime.engine.queue as ManagedTaskQueue;
      const submission = queue.submit({
        kind: "execution.run.v1",
        payload: {
          projectId: "project_readiness_store_failure",
          executionId: "exe_readiness_store_failure",
        },
      });
      await expect(submission.accepted).rejects.toThrow();
      await expect(submission.completed).rejects.toThrow();

      const response = await app.request("/ready");

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        status: "not_ready",
        service: "executor",
        checks: {
          database: { status: "ok" },
          migrations: { status: "ok" },
          credentials: { status: "ok" },
          queue: { status: "error" },
        },
      });
    } finally {
      await runtime.close();
    }
  });
});
