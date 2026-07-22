import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { DatabaseReadinessProbes } from "../../readiness.js";
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

export interface AppliedMigration {
  readonly hash: string;
  readonly createdAt: string | number | null;
}

export interface DatabaseReadinessSource {
  ping(signal?: AbortSignal): Promise<void>;
  readAppliedMigrations(
    signal?: AbortSignal,
  ): Promise<readonly AppliedMigration[]>;
}

export function createDatabaseReadiness(
  source: DatabaseReadinessSource,
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
): DatabaseReadinessProbes {
  const expected = readMigrationFiles({ migrationsFolder });
  return {
    connectivity: { check: (signal) => source.ping(signal) },
    migrations: {
      check: async (signal) => {
        const applied = await source.readAppliedMigrations(signal);
        if (
          applied.length !== expected.length ||
          applied.some(
            (migration, index) =>
              migration.hash !== expected[index]?.hash ||
              Number(migration.createdAt) !== expected[index]?.folderMillis,
          )
        ) {
          throw new Error(
            "The database migration journal does not match the executor build.",
          );
        }
      },
    },
  };
}

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
