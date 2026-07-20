import { PGlite } from "@electric-sql/pglite";
import {
  drizzle as drizzleNodePg,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  drizzle as drizzlePglite,
  type PgliteDatabase,
} from "drizzle-orm/pglite";
import { Pool } from "pg";
import type { JobStore } from "../../jobs/store.js";
import type { ExecutionStore } from "../../store.js";
import type { TriggerStateStore } from "../../triggers/state-store.js";
import type { TriggerSubscriptionStore } from "../../triggers/subscription-store.js";
import type { UsageOutboxStore } from "../../usage/outbox.js";
import type { WebhookDeliveryStore } from "../../webhooks/delivery-store.js";
import type { WebhookEndpointStore } from "../../webhooks/endpoint-store.js";
import type { WebhookWorkStore } from "../../webhooks/work-store.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { PostgresExecutionStore } from "./execution-store.js";
import { PostgresJobStore } from "./job-store.js";
import { migrate } from "./migrate.js";
import { type PostgresSchema, postgresSchema } from "./schema.js";
import { PostgresTriggerStateStore } from "./trigger-state-store.js";
import { PostgresTriggerSubscriptionStore } from "./trigger-subscription-store.js";
import { PostgresUsageOutboxStore } from "./usage-outbox-store.js";
import { PostgresWebhookDeliveryStore } from "./webhook-delivery-store.js";
import { PostgresWebhookEndpointStore } from "./webhook-endpoint-store.js";
import { PostgresWebhookWorkStore } from "./webhook-work-store.js";

export interface PostgresStoreSet {
  executionStore: ExecutionStore;
  webhookEndpointStore: WebhookEndpointStore;
  webhookDeliveryStore: WebhookDeliveryStore;
  triggerSubscriptionStore: TriggerSubscriptionStore;
  triggerStateStore: TriggerStateStore;
  usageOutboxStore: UsageOutboxStore;
  jobStore: JobStore;
  webhookWorkStore: WebhookWorkStore;
}

export interface PgStoreBundle extends PostgresStoreSet {
  database: NodePgDatabase<PostgresSchema>;
  pool: Pool;
  close(): Promise<void>;
}

export interface PgliteStoreBundle extends PostgresStoreSet {
  client: PGlite;
  database: PgliteDatabase<PostgresSchema>;
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
): PostgresStoreSet {
  return {
    executionStore: new PostgresExecutionStore(database),
    webhookEndpointStore: new PostgresWebhookEndpointStore(database),
    webhookDeliveryStore: new PostgresWebhookDeliveryStore(database),
    triggerSubscriptionStore: new PostgresTriggerSubscriptionStore(database),
    triggerStateStore: new PostgresTriggerStateStore(database),
    usageOutboxStore: new PostgresUsageOutboxStore(database),
    jobStore: new PostgresJobStore(database),
    webhookWorkStore: new PostgresWebhookWorkStore(database),
  };
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
  return {
    database,
    pool,
    ...stores(database),
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
    ...stores(database),
    close: async () => client.close(),
  };
}
