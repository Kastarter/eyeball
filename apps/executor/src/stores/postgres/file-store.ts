import type {
  FileId,
  ResolvedFile,
  StagedFileMetadata,
  StagedFilePage,
} from "@eyeball/core";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  type ExpiredFileSweepInput,
  type FileStore,
  fileCursorAfter,
  fileIdFromCursor,
  InvalidFileCursorError,
  type ListFilesInput,
  type StoredStagedFile,
  validateFileListInput,
} from "../../staged-files.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { stagedFiles } from "./schema.js";

const metadataSelection = {
  fileId: stagedFiles.fileId,
  name: stagedFiles.name,
  mimeType: stagedFiles.mimeType,
  size: stagedFiles.size,
  expiresAt: stagedFiles.expiresAt,
} as const;

function fileWhere(projectId: string, fileId: string) {
  return and(
    eq(stagedFiles.projectId, projectId),
    eq(stagedFiles.fileId, fileId),
  );
}

/**
 * SEC-017 ownership predicate. Owner-less rows (legacy or project-scoped
 * uploads) are always visible; an owned row is visible only to its owner. A
 * missing requester identity resolves owner-less rows only — fail closed.
 */
function ownerWhere(requesterUserId: string | undefined): SQL {
  if (requesterUserId === undefined) {
    return isNull(stagedFiles.ownerUserId);
  }
  return or(
    isNull(stagedFiles.ownerUserId),
    eq(stagedFiles.ownerUserId, requesterUserId),
  ) as SQL;
}

function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function metadataFromRow(row: {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  expiresAt: string;
}): StagedFileMetadata {
  return {
    fileId: row.fileId as FileId,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    expiresAt: isoTimestamp(row.expiresAt),
  };
}

function validSweepInput(input: ExpiredFileSweepInput): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new RangeError("File sweep limit must be a positive safe integer.");
  }
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new TypeError("File sweep now must be a valid ISO timestamp.");
  }
}

export class PostgresFileStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements FileStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;

  constructor(database: EyeballPostgresDatabase<TQueryResult>) {
    this.#database = database;
  }

  async put(projectId: string, file: StoredStagedFile): Promise<void> {
    let inserted: { fileId: string }[];
    try {
      inserted = await this.#database
        .insert(stagedFiles)
        .values({
          projectId,
          fileId: file.meta.fileId,
          name: file.meta.name,
          mimeType: file.meta.mimeType,
          size: file.meta.size,
          content: Uint8Array.from(file.content),
          createdAt: file.createdAt,
          expiresAt: file.meta.expiresAt,
          ownerUserId: file.ownerUserId ?? null,
        })
        .onConflictDoNothing()
        .returning({ fileId: stagedFiles.fileId });
    } catch {
      // Drizzle includes bound bytea parameters in query errors. Do not retain the
      // original error, params, or cause at this content-bearing boundary.
      throw new Error("Staged-file persistence failed.");
    }
    if (inserted.length === 0) {
      throw new Error(`Duplicate staged-file ID: ${file.meta.fileId}`);
    }
  }

  async get(
    projectId: string,
    fileId: FileId,
    now: string,
    requesterUserId?: string,
  ): Promise<ResolvedFile | undefined> {
    const [row] = await this.#database
      .select({ ...metadataSelection, content: stagedFiles.content })
      .from(stagedFiles)
      .where(
        and(
          fileWhere(projectId, fileId),
          gt(stagedFiles.expiresAt, now),
          ownerWhere(requesterUserId),
        ),
      )
      .limit(1);
    if (row === undefined) {
      await this.#deleteExpired(projectId, fileId, now);
      return undefined;
    }
    return {
      meta: metadataFromRow(row),
      content: Uint8Array.from(row.content),
    };
  }

  async getMetadata(
    projectId: string,
    fileId: FileId,
    now: string,
    requesterUserId?: string,
  ): Promise<StagedFileMetadata | undefined> {
    const [row] = await this.#database
      .select(metadataSelection)
      .from(stagedFiles)
      .where(
        and(
          fileWhere(projectId, fileId),
          gt(stagedFiles.expiresAt, now),
          ownerWhere(requesterUserId),
        ),
      )
      .limit(1);
    if (row === undefined) {
      await this.#deleteExpired(projectId, fileId, now);
      return undefined;
    }
    return metadataFromRow(row);
  }

  async list(
    projectId: string,
    input: ListFilesInput,
  ): Promise<StagedFilePage> {
    validateFileListInput(input);
    const predicates: SQL[] = [
      eq(stagedFiles.projectId, projectId),
      gt(stagedFiles.expiresAt, input.now),
    ];
    if (input.cursor !== undefined) {
      const after = fileIdFromCursor(input.cursor);
      const [anchor] = await this.#database
        .select({
          createdAt: stagedFiles.createdAt,
          sequence: stagedFiles.sequence,
        })
        .from(stagedFiles)
        .where(fileWhere(projectId, after))
        .limit(1);
      if (anchor === undefined) throw new InvalidFileCursorError();
      predicates.push(
        or(
          lt(stagedFiles.createdAt, anchor.createdAt),
          and(
            eq(stagedFiles.createdAt, anchor.createdAt),
            lt(stagedFiles.sequence, anchor.sequence),
          ),
        ) as SQL,
      );
    }
    const rows = await this.#database
      .select(metadataSelection)
      .from(stagedFiles)
      .where(and(...predicates))
      .orderBy(desc(stagedFiles.createdAt), desc(stagedFiles.sequence))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const files = rows.slice(0, input.limit).map(metadataFromRow);
    const last = files.at(-1);
    return {
      files,
      ...(hasMore && last !== undefined
        ? { nextCursor: fileCursorAfter(last.fileId) }
        : {}),
    };
  }

  async sweepExpired(input: ExpiredFileSweepInput): Promise<number> {
    validSweepInput(input);
    return this.#database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          projectId: stagedFiles.projectId,
          fileId: stagedFiles.fileId,
        })
        .from(stagedFiles)
        .where(lte(stagedFiles.expiresAt, input.now))
        .orderBy(asc(stagedFiles.expiresAt), asc(stagedFiles.sequence))
        .limit(input.limit);
      if (rows.length === 0) return 0;
      const deleted = await transaction
        .delete(stagedFiles)
        .where(
          and(
            lte(stagedFiles.expiresAt, input.now),
            or(
              ...rows.map((row) => fileWhere(row.projectId, row.fileId)),
            ) as SQL,
          ),
        )
        .returning({ fileId: stagedFiles.fileId });
      return deleted.length;
    });
  }

  async #deleteExpired(
    projectId: string,
    fileId: FileId,
    now: string,
  ): Promise<void> {
    await this.#database
      .delete(stagedFiles)
      .where(
        and(fileWhere(projectId, fileId), lte(stagedFiles.expiresAt, now)),
      );
  }
}
