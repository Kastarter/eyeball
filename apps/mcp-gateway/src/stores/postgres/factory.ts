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
import type { SessionStore } from "../../session-store.js";
import type { McpGatewayPostgresDatabase } from "./database.js";
import { migrateMcpGateway } from "./migrate.js";
import {
  type McpGatewayPostgresSchema,
  mcpGatewayPostgresSchema,
} from "./schema.js";
import { PostgresSessionStore } from "./session-store.js";

export interface McpGatewayPostgresStoreSet {
  sessionStore: SessionStore;
}

export interface PgMcpGatewayStoreBundle extends McpGatewayPostgresStoreSet {
  database: NodePgDatabase<McpGatewayPostgresSchema>;
  pool: Pool;
  close(): Promise<void>;
}

export interface PgliteMcpGatewayStoreBundle
  extends McpGatewayPostgresStoreSet {
  client: PGlite;
  database: PgliteDatabase<McpGatewayPostgresSchema>;
  close(): Promise<void>;
}

export interface CreatePgMcpGatewayStoreBundleOptions {
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
  database: McpGatewayPostgresDatabase<TQueryResult>,
): McpGatewayPostgresStoreSet {
  return { sessionStore: new PostgresSessionStore(database) };
}

/** Creates the gateway pg pool, migrates it, and binds its durable store. */
export async function createPgMcpGatewayStoreBundle(
  options: CreatePgMcpGatewayStoreBundleOptions,
): Promise<PgMcpGatewayStoreBundle> {
  if (options.connectionString.trim().length === 0) {
    throw new TypeError("Postgres connection string must not be empty.");
  }
  const pool = new Pool({
    connectionString: options.connectionString,
    max: maxConnections(options.maxConnections),
  });
  const database = drizzleNodePg(pool, { schema: mcpGatewayPostgresSchema });
  try {
    if (options.runMigrations !== false) {
      await migrateMcpGateway(
        { kind: "pg", database },
        options.migrationsFolder,
      );
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

export interface CreatePgliteMcpGatewayStoreBundleOptions {
  dataDir?: string;
  migrationsFolder?: string;
}

/** Embedded Postgres harness used by gateway session-store contract tests. */
export async function createPgliteMcpGatewayStoreBundle(
  options: CreatePgliteMcpGatewayStoreBundleOptions = {},
): Promise<PgliteMcpGatewayStoreBundle> {
  const client = new PGlite(options.dataDir);
  const database = drizzlePglite(client, {
    schema: mcpGatewayPostgresSchema,
  });
  try {
    await migrateMcpGateway(
      { kind: "pglite", database },
      options.migrationsFolder,
    );
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
