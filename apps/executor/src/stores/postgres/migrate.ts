import { fileURLToPath } from "node:url";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { PostgresSchema } from "./schema.js";

export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);

export type MigrationTarget =
  | {
      kind: "pg";
      database: NodePgDatabase<PostgresSchema>;
    }
  | {
      kind: "pglite";
      database: PgliteDatabase<PostgresSchema>;
    };

/** Applies the same committed Drizzle migrations to pg and embedded PGlite. */
export async function migrate(
  target: MigrationTarget,
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
): Promise<void> {
  if (target.kind === "pg") {
    await migrateNodePg(target.database, { migrationsFolder });
    return;
  }
  await migratePglite(target.database, { migrationsFolder });
}
