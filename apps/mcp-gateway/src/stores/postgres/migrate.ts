import { fileURLToPath } from "node:url";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { McpGatewayPostgresSchema } from "./schema.js";

export const MCP_GATEWAY_MIGRATIONS_SCHEMA = "eyeball_mcp_gateway";
export const MCP_GATEWAY_MIGRATIONS_TABLE = "__drizzle_migrations";
export const DEFAULT_MCP_GATEWAY_MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);

export type McpGatewayMigrationTarget =
  | {
      kind: "pg";
      database: NodePgDatabase<McpGatewayPostgresSchema>;
    }
  | {
      kind: "pglite";
      database: PgliteDatabase<McpGatewayPostgresSchema>;
    };

/** Applies the gateway-owned migration stream with an independent ledger. */
export async function migrateMcpGateway(
  target: McpGatewayMigrationTarget,
  migrationsFolder = DEFAULT_MCP_GATEWAY_MIGRATIONS_FOLDER,
): Promise<void> {
  const options = {
    migrationsFolder,
    migrationsSchema: MCP_GATEWAY_MIGRATIONS_SCHEMA,
    migrationsTable: MCP_GATEWAY_MIGRATIONS_TABLE,
  };
  if (target.kind === "pg") {
    await migrateNodePg(target.database, options);
    return;
  }
  await migratePglite(target.database, options);
}
