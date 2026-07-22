import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteStoreBundle } from "../src/stores/postgres/factory.js";
import {
  DEFAULT_MIGRATIONS_FOLDER,
  migrate,
} from "../src/stores/postgres/migrate.js";

let through0008: string;

describe("execution cancellation migration", () => {
  beforeAll(async () => {
    const scratchRoot = process.env.EYEBALL_TEST_TMPDIR ?? tmpdir();
    await mkdir(scratchRoot, { recursive: true });
    through0008 = await mkdtemp(
      join(scratchRoot, "executor-migrations-through-0008-"),
    );
    await mkdir(join(through0008, "meta"), { recursive: true });

    const migrationFiles = (await readdir(DEFAULT_MIGRATIONS_FOLDER))
      .filter((name) => /^000[0-8]_.*\.sql$/.test(name))
      .sort();
    expect(migrationFiles).toHaveLength(9);
    for (const file of migrationFiles) {
      await cp(join(DEFAULT_MIGRATIONS_FOLDER, file), join(through0008, file));
    }

    const journal = JSON.parse(
      await readFile(
        join(DEFAULT_MIGRATIONS_FOLDER, "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, 9);
    await writeFile(
      join(through0008, "meta", "_journal.json"),
      `${JSON.stringify(journal, null, 2)}\n`,
    );
  });

  afterAll(async () => {
    await rm(through0008, { recursive: true, force: true });
  });

  it("applies to an empty database", async () => {
    const bundle = await createPgliteStoreBundle();
    try {
      await bundle.client.query(`
        INSERT INTO task_jobs (
          job_id, queue_name, kind, payload, state, run_after,
          created_at, updated_at, completed_at
        ) VALUES (
          'job_fresh', 'execution', 'execution.run.v1', '{}'::jsonb, 'cancelled',
          '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z',
          '2026-07-21T00:00:01.000Z', '2026-07-21T00:00:01.000Z'
        )
      `);

      const result = await bundle.client.query<{ state: string }>(
        "SELECT state FROM task_jobs WHERE job_id = 'job_fresh'",
      );
      expect(result.rows).toEqual([{ state: "cancelled" }]);
    } finally {
      await bundle.close();
    }
  });

  it("upgrades a database migrated through 0008", async () => {
    const bundle = await createPgliteStoreBundle({
      migrationsFolder: through0008,
    });
    try {
      await bundle.client.query(`
        INSERT INTO task_jobs (
          job_id, queue_name, kind, payload, state, run_after,
          created_at, updated_at
        ) VALUES (
          'job_upgrade', 'execution', 'execution.run.v1', '{}'::jsonb, 'pending',
          '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z',
          '2026-07-21T00:00:00.000Z'
        )
      `);

      await migrate(
        { kind: "pglite", database: bundle.database },
        DEFAULT_MIGRATIONS_FOLDER,
      );
      await bundle.client.query(`
        UPDATE task_jobs
        SET state = 'cancelled',
            completed_at = '2026-07-21T00:00:01.000Z',
            updated_at = '2026-07-21T00:00:01.000Z'
        WHERE job_id = 'job_upgrade'
      `);

      const result = await bundle.client.query<{
        state: string;
        completed_at: string | null;
      }>(
        "SELECT state, completed_at FROM task_jobs WHERE job_id = 'job_upgrade'",
      );
      expect(result.rows[0]?.state).toBe("cancelled");
      expect(result.rows[0]?.completed_at).not.toBeNull();
    } finally {
      await bundle.close();
    }
  });
});
