import { PGlite } from "@electric-sql/pglite";
import type { AgentStore } from "@eyeball/toolkits";
import {
  drizzle as drizzleNodePg,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  drizzle as drizzlePglite,
  type PgliteDatabase,
} from "drizzle-orm/pglite";
import { Pool, type PoolClient } from "pg";
import type { JobStore } from "../../jobs/store.js";
import {
  type DatabaseReadinessProbes,
  DEFAULT_READINESS_PROBE_TIMEOUT_MS,
} from "../../readiness.js";
import type { FileStore } from "../../staged-files.js";
import type { ExecutionStore } from "../../store.js";
import type { TriggerEventStore } from "../../triggers/event-store.js";
import type { TriggerStateStore } from "../../triggers/state-store.js";
import type { TriggerSubscriptionStore } from "../../triggers/subscription-store.js";
import type { UsageOutboxStore } from "../../usage/outbox.js";
import type { VoiceSessionObserverStore } from "../../voice/observer-store.js";
import type { WebhookDeliveryStore } from "../../webhooks/delivery-store.js";
import type { WebhookEndpointStore } from "../../webhooks/endpoint-store.js";
import type { VoiceWebhookSourceStore } from "../../webhooks/voice-source-store.js";
import type { WebhookWorkStore } from "../../webhooks/work-store.js";
import { PostgresAgentStore } from "./agent-store.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { PostgresExecutionStore } from "./execution-store.js";
import { PostgresFileStore } from "./file-store.js";
import { JOB_STORE_READINESS_QUERIES, PostgresJobStore } from "./job-store.js";
import {
  type AppliedMigration,
  createDatabaseReadiness,
  migrate,
} from "./migrate.js";
import { type PostgresSchema, postgresSchema } from "./schema.js";
import { PostgresTriggerEventStore } from "./trigger-event-store.js";
import { PostgresTriggerStateStore } from "./trigger-state-store.js";
import { PostgresTriggerSubscriptionStore } from "./trigger-subscription-store.js";
import { PostgresUsageOutboxStore } from "./usage-outbox-store.js";
import { PostgresVoiceSessionObserverStore } from "./voice-observer-store.js";
import { PostgresVoiceWebhookSourceStore } from "./voice-source-store.js";
import { PostgresWebhookDeliveryStore } from "./webhook-delivery-store.js";
import { PostgresWebhookEndpointStore } from "./webhook-endpoint-store.js";
import { PostgresWebhookWorkStore } from "./webhook-work-store.js";

export interface PostgresStoreSet {
  agentStore: AgentStore;
  executionStore: ExecutionStore;
  fileStore: FileStore;
  webhookEndpointStore: WebhookEndpointStore;
  webhookDeliveryStore: WebhookDeliveryStore;
  triggerSubscriptionStore: TriggerSubscriptionStore;
  triggerEventStore: TriggerEventStore;
  triggerStateStore: TriggerStateStore;
  usageOutboxStore: UsageOutboxStore;
  jobStore: JobStore;
  webhookWorkStore: WebhookWorkStore;
  voiceObserverStore: VoiceSessionObserverStore;
  voiceWebhookSourceStore: VoiceWebhookSourceStore;
}

export interface PgStoreBundle extends PostgresStoreSet {
  database: NodePgDatabase<PostgresSchema>;
  pool: Pool;
  readiness: DatabaseReadinessProbes;
  close(): Promise<void>;
}

export interface PgliteStoreBundle extends PostgresStoreSet {
  client: PGlite;
  database: PgliteDatabase<PostgresSchema>;
  readiness: DatabaseReadinessProbes;
  close(): Promise<void>;
}

export interface CreatePgStoreBundleOptions {
  connectionString: string;
  maxConnections?: number;
  runMigrations?: boolean;
  migrationsFolder?: string;
}

function maxConnections(value: number | undefined): number {
  const resolved = value ?? 5;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError("Postgres pool size must be a positive safe integer.");
  }
  return resolved;
}

function stores<TQueryResult extends PgQueryResultHKT>(
  database: EyeballPostgresDatabase<TQueryResult>,
  jobStore: JobStore = new PostgresJobStore(database),
): PostgresStoreSet {
  return {
    agentStore: new PostgresAgentStore(database),
    executionStore: new PostgresExecutionStore(database),
    fileStore: new PostgresFileStore(database),
    webhookEndpointStore: new PostgresWebhookEndpointStore(database),
    webhookDeliveryStore: new PostgresWebhookDeliveryStore(database),
    triggerSubscriptionStore: new PostgresTriggerSubscriptionStore(database),
    triggerEventStore: new PostgresTriggerEventStore(database),
    triggerStateStore: new PostgresTriggerStateStore(database),
    usageOutboxStore: new PostgresUsageOutboxStore(database),
    jobStore,
    webhookWorkStore: new PostgresWebhookWorkStore(database),
    voiceObserverStore: new PostgresVoiceSessionObserverStore(database),
    voiceWebhookSourceStore: new PostgresVoiceWebhookSourceStore(database),
  };
}

async function withPgReadinessClient<T>(
  pool: Pool,
  signal: AbortSignal | undefined,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const client = await pool.connect();
  let released = false;
  const abort = () => {
    if (released) return;
    released = true;
    client.release(true);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    return await operation(client);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!released) client.release();
  }
}

/** Creates the production pg pool, migrates it, and binds every durable store. */
export async function createPgStoreBundle(
  options: CreatePgStoreBundleOptions,
): Promise<PgStoreBundle> {
  if (options.connectionString.trim().length === 0) {
    throw new TypeError("Postgres connection string must not be empty.");
  }
  const pool = new Pool({
    connectionString: options.connectionString,
    max: maxConnections(options.maxConnections),
    connectionTimeoutMillis: DEFAULT_READINESS_PROBE_TIMEOUT_MS,
  });
  const database = drizzleNodePg(pool, { schema: postgresSchema });
  try {
    if (options.runMigrations !== false) {
      await migrate({ kind: "pg", database }, options.migrationsFolder);
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
  const jobStore = new PostgresJobStore(database, async (signal) => {
    await withPgReadinessClient(pool, signal, async (client) => {
      for (const query of JOB_STORE_READINESS_QUERIES) {
        await client.query(query);
      }
    });
  });
  return {
    database,
    pool,
    readiness: createDatabaseReadiness(
      {
        ping: async (signal) => {
          await withPgReadinessClient(pool, signal, async (client) => {
            await client.query("SELECT 1");
          });
        },
        readAppliedMigrations: async (signal) => {
          return withPgReadinessClient(pool, signal, async (client) => {
            const result = await client.query<{
              hash: string;
              created_at: string | null;
            }>(
              "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC",
            );
            return result.rows.map(
              (row): AppliedMigration => ({
                hash: row.hash,
                createdAt: row.created_at,
              }),
            );
          });
        },
      },
      options.migrationsFolder,
    ),
    ...stores(database, jobStore),
    close: async () => pool.end(),
  };
}

export interface CreatePgliteStoreBundleOptions {
  dataDir?: string;
  migrationsFolder?: string;
}

/** Embedded Postgres harness used by the shared store contract tests. */
export async function createPgliteStoreBundle(
  options: CreatePgliteStoreBundleOptions = {},
): Promise<PgliteStoreBundle> {
  const client = new PGlite(options.dataDir);
  const database = drizzlePglite(client, { schema: postgresSchema });
  try {
    await migrate({ kind: "pglite", database }, options.migrationsFolder);
  } catch (error) {
    await client.close();
    throw error;
  }
  return {
    client,
    database,
    readiness: createDatabaseReadiness(
      {
        ping: async () => {
          await client.query("SELECT 1");
        },
        readAppliedMigrations: async () => {
          const result = await client.query<{
            hash: string;
            created_at: number | null;
          }>(
            "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC",
          );
          return result.rows.map(
            (row): AppliedMigration => ({
              hash: row.hash,
              createdAt: row.created_at,
            }),
          );
        },
      },
      options.migrationsFolder,
    ),
    ...stores(database),
    close: async () => client.close(),
  };
}
