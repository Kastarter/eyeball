import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createExecutionId } from "@eyeball/core";
import { afterAll, expect, it, vi } from "vitest";
import { createPgliteStoreBundle } from "../../executor/src/stores/postgres/factory.js";
import { InMemorySessionStore } from "../src/session-store.js";
import {
  createPgliteMcpGatewayStoreBundle,
  type PgliteMcpGatewayStoreBundle,
} from "../src/stores/postgres/factory.js";
import { registerSessionStoreContractSuite } from "./helpers/session-store-contract-suite.js";

let pgliteBundlePromise: Promise<PgliteMcpGatewayStoreBundle> | undefined;

function pgliteBundle(): Promise<PgliteMcpGatewayStoreBundle> {
  pgliteBundlePromise ??= createPgliteMcpGatewayStoreBundle();
  return pgliteBundlePromise;
}

afterAll(async () => {
  if (pgliteBundlePromise !== undefined) {
    await (await pgliteBundlePromise).close();
  }
});

registerSessionStoreContractSuite([
  {
    name: "in-memory",
    createStore: async () => new InMemorySessionStore(),
  },
  {
    name: "PGlite",
    createStore: async () => (await pgliteBundle()).sessionStore,
  },
]);

it("migrates the session aggregate and expiry index", async () => {
  const bundle = await pgliteBundle();
  const columns = await bundle.client.query<{
    column_name: string;
    data_type: string;
  }>(
    `select column_name, data_type
       from information_schema.columns
      where table_schema = 'public' and table_name = 'mcp_sessions'
      order by ordinal_position`,
  );
  expect(columns.rows).toEqual([
    { column_name: "session_id", data_type: "text" },
    { column_name: "protocol_version", data_type: "text" },
    { column_name: "auth_binding", data_type: "text" },
    { column_name: "tasks_enabled", data_type: "boolean" },
    { column_name: "created_at", data_type: "timestamp with time zone" },
    { column_name: "expires_at", data_type: "timestamp with time zone" },
    { column_name: "catalog_version", data_type: "text" },
    { column_name: "tasks", data_type: "jsonb" },
  ]);
  const indexes = await bundle.client.query<{ indexname: string }>(
    `select indexname
       from pg_indexes
      where schemaname = 'public' and tablename = 'mcp_sessions'`,
  );
  expect(indexes.rows.map(({ indexname }) => indexname)).toContain(
    "mcp_sessions_expiry_idx",
  );
});

it("keeps executor and gateway migration histories independent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eyeball-shared-migrations-"));
  try {
    const executor = await createPgliteStoreBundle({ dataDir: directory });
    await executor.close();
    const gateway = await createPgliteMcpGatewayStoreBundle({
      dataDir: directory,
    });
    try {
      const schemas = await gateway.client.query<{ schema_name: string }>(
        `select schema_name
           from information_schema.schemata
          where schema_name in ('drizzle', 'eyeball_mcp_gateway')
          order by schema_name`,
      );
      expect(schemas.rows.map(({ schema_name }) => schema_name)).toEqual([
        "drizzle",
        "eyeball_mcp_gateway",
      ]);
      const executorLedger = await gateway.client.query<{ count: number }>(
        "select count(*)::int as count from drizzle.__drizzle_migrations",
      );
      const gatewayLedger = await gateway.client.query<{ count: number }>(
        "select count(*)::int as count from eyeball_mcp_gateway.__drizzle_migrations",
      );
      expect(executorLedger.rows[0]?.count).toBeGreaterThanOrEqual(5);
      expect(gatewayLedger.rows[0]?.count).toBe(1);
    } finally {
      await gateway.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reopens negotiated fields plus working and cancelled tasks from disk", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "eyeball-mcp-session-restart-"),
  );
  let first: PgliteMcpGatewayStoreBundle | undefined;
  let restored: PgliteMcpGatewayStoreBundle | undefined;
  try {
    first = await createPgliteMcpGatewayStoreBundle({ dataDir: directory });
    const taskId = createExecutionId("gateway_restart_task");
    const cancelledTaskId = createExecutionId("gateway_cancelled_task");
    const session = {
      sessionId: "gateway_restart_session",
      protocolVersion: "2025-06-18",
      authBinding: "sha256_restart_binding",
      tasksEnabled: true,
      createdAt: "2026-07-20T06:00:00.000Z",
      expiresAt: "2026-07-20T07:00:00.000Z",
      catalogVersion: "1.1",
      tasks: {
        [taskId]: {
          taskId,
          tool: "gmail.list_emails" as const,
          executionStatus: "running" as const,
          status: "working" as const,
          createdAt: "2026-07-20T06:00:01.000Z",
          lastUpdatedAt: "2026-07-20T06:00:02.000Z",
          ttl: 120_000,
          pollInterval: 1_000,
          progress: 0.5,
        },
        [cancelledTaskId]: {
          taskId: cancelledTaskId,
          tool: "twilio.start_call" as const,
          executionStatus: "cancelled" as const,
          status: "cancelled" as const,
          statusMessage: "Execution cancelled before provider dispatch.",
          createdAt: "2026-07-20T06:00:03.000Z",
          lastUpdatedAt: "2026-07-20T06:00:04.000Z",
          ttl: 120_000,
          pollInterval: 1_000,
          progress: 2,
        },
      },
    };
    await first.sessionStore.set(session);
    await first.close();
    first = undefined;

    restored = await createPgliteMcpGatewayStoreBundle({ dataDir: directory });
    await expect(restored.sessionStore.get(session.sessionId)).resolves.toEqual(
      session,
    );
  } finally {
    await first?.close();
    await restored?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("closes PGlite when gateway migration setup fails", async () => {
  const close = vi.spyOn(PGlite.prototype, "close");
  const missing = join(tmpdir(), `missing-mcp-migrations-${Date.now()}`);
  try {
    await expect(
      createPgliteMcpGatewayStoreBundle({ migrationsFolder: missing }),
    ).rejects.toBeInstanceOf(Error);
    expect(close).toHaveBeenCalled();
  } finally {
    close.mockRestore();
  }
});
