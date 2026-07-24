import {
  type Clock,
  type FileId,
  isFileId,
  type ResolvedFile,
  type StagedFileMetadata,
  type StagedFilePage,
} from "@eyeball/core";

export const DEFAULT_FILE_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_MAX_FILE_SIZE_BYTES = 25 * 1_024 * 1_024;

export interface StoredStagedFile extends ResolvedFile {
  /** Private ordering timestamp; deliberately absent from public metadata. */
  createdAt: string;
  /**
   * SEC-017: effective user that staged the file. Deliberately absent from
   * public metadata. `undefined` marks a legacy or project-scoped upload with
   * no bound user, readable by the whole project; a set value scopes reads to
   * that user on metadata and content resolution.
   */
  ownerUserId?: string;
}

export interface ListFilesInput {
  cursor?: string;
  limit: number;
  now: string;
}

export interface ExpiredFileSweepInput {
  limit: number;
  now: string;
}

export class InvalidFileCursorError extends Error {
  constructor() {
    super("File cursor is invalid.");
    this.name = "InvalidFileCursorError";
  }
}

/**
 * Durable staged-file storage seam. The engine owns staging policy and tenant
 * authorization. Metadata routes use `getMetadata` and `list`; `get` is the
 * content-resolution path used by execution-bound `AdapterContext.files`.
 *
 * The stock Postgres implementation stores bytes in `bytea`. A future store may
 * keep metadata and indexes in one backend while placing content in an object
 * store without changing routes, the engine, or adapter resolution.
 */
export interface FileStore {
  put(projectId: string, file: StoredStagedFile): Promise<void>;
  /**
   * Resolve file content. `requesterUserId` is the effective execution
   * identity; an owned file is returned only when it matches. `undefined`
   * resolves owner-less (project-scoped) files only — fail closed.
   */
  get(
    projectId: string,
    fileId: FileId,
    now: string,
    requesterUserId?: string,
  ): Promise<ResolvedFile | undefined>;
  /**
   * Resolve public metadata under the same ownership rule as `get`.
   */
  getMetadata(
    projectId: string,
    fileId: FileId,
    now: string,
    requesterUserId?: string,
  ): Promise<StagedFileMetadata | undefined>;
  list(projectId: string, input: ListFilesInput): Promise<StagedFilePage>;
  sweepExpired(input: ExpiredFileSweepInput): Promise<number>;
}

export interface InMemoryFileStoreOptions {
  /** @deprecated Operation timestamps now come from the engine/runtime. */
  clock?: Clock;
}

function storageKey(projectId: string, fileId: FileId): string {
  return JSON.stringify([projectId, fileId]);
}

interface InMemoryStoredFile extends StoredStagedFile {
  projectId: string;
  sequence: number;
}

function cloneFile(file: ResolvedFile): ResolvedFile {
  return {
    meta: structuredClone(file.meta),
    content: Uint8Array.from(file.content),
  };
}

function validTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be a valid ISO timestamp.`);
  }
  return timestamp;
}

export function validateFileListInput(input: ListFilesInput): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new RangeError(
      "File list limit must be an integer from 1 through 100.",
    );
  }
  validTimestamp(input.now, "File list now");
}

function validateSweepInput(input: ExpiredFileSweepInput): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new RangeError("File sweep limit must be a positive safe integer.");
  }
  validTimestamp(input.now, "File sweep now");
}

export function fileCursorAfter(fileId: FileId): string {
  return Buffer.from(JSON.stringify({ after: fileId }), "utf8").toString(
    "base64url",
  );
}

export function fileIdFromCursor(cursor: string): FileId {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new InvalidFileCursorError();
    }
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) {
      throw new InvalidFileCursorError();
    }
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !("after" in parsed) ||
      typeof parsed.after !== "string" ||
      !isFileId(parsed.after)
    ) {
      throw new InvalidFileCursorError();
    }
    return parsed.after;
  } catch (error) {
    if (error instanceof InvalidFileCursorError) throw error;
    throw new InvalidFileCursorError();
  }
}

function cloneMetadata(metadata: StagedFileMetadata): StagedFileMetadata {
  return structuredClone(metadata);
}

/** Process-local, project-scoped file store with lazy TTL eviction. */
export class InMemoryFileStore implements FileStore {
  readonly #files = new Map<string, InMemoryStoredFile>();
  #sequence = 0;

  constructor(options: InMemoryFileStoreOptions = {}) {
    // Retained for source compatibility. The operation timestamp is authoritative.
    void options;
  }

  async put(projectId: string, file: StoredStagedFile): Promise<void> {
    const key = storageKey(projectId, file.meta.fileId);
    if (this.#files.has(key)) {
      throw new Error(`Duplicate staged-file ID: ${file.meta.fileId}`);
    }
    validTimestamp(file.createdAt, "Staged-file createdAt");
    validTimestamp(file.meta.expiresAt, "Staged-file expiresAt");
    this.#sequence += 1;
    this.#files.set(key, {
      projectId,
      sequence: this.#sequence,
      createdAt: file.createdAt,
      ...(file.ownerUserId !== undefined
        ? { ownerUserId: file.ownerUserId }
        : {}),
      ...cloneFile(file),
    });
  }

  async get(
    projectId: string,
    fileId: FileId,
    now: string,
    requesterUserId?: string,
  ): Promise<ResolvedFile | undefined> {
    const key = storageKey(projectId, fileId);
    const file = this.#files.get(key);
    if (file === undefined) {
      return undefined;
    }
    if (
      Date.parse(file.meta.expiresAt) <= validTimestamp(now, "File read now")
    ) {
      this.#files.delete(key);
      return undefined;
    }
    // SEC-017: owned files resolve only for their owner; owner-less files
    // stay project-scoped. Never surface the owner to callers.
    if (
      file.ownerUserId !== undefined &&
      file.ownerUserId !== requesterUserId
    ) {
      return undefined;
    }
    return cloneFile(file);
  }

  async getMetadata(
    projectId: string,
    fileId: FileId,
    now: string,
    requesterUserId?: string,
  ): Promise<StagedFileMetadata | undefined> {
    const key = storageKey(projectId, fileId);
    const file = this.#files.get(key);
    if (file === undefined) return undefined;
    if (
      Date.parse(file.meta.expiresAt) <=
      validTimestamp(now, "File metadata read now")
    ) {
      this.#files.delete(key);
      return undefined;
    }
    // SEC-017: same ownership rule as `get`.
    if (
      file.ownerUserId !== undefined &&
      file.ownerUserId !== requesterUserId
    ) {
      return undefined;
    }
    return cloneMetadata(file.meta);
  }

  async list(
    projectId: string,
    input: ListFilesInput,
  ): Promise<StagedFilePage> {
    validateFileListInput(input);
    const now = Date.parse(input.now);
    const ordered = [...this.#files.values()]
      .filter((file) => file.projectId === projectId)
      .sort((left, right) => {
        const time = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        return time === 0 ? right.sequence - left.sequence : time;
      });
    let offset = 0;
    if (input.cursor !== undefined) {
      const after = fileIdFromCursor(input.cursor);
      const anchor = ordered.findIndex((file) => file.meta.fileId === after);
      if (anchor === -1) throw new InvalidFileCursorError();
      offset = anchor + 1;
    }
    const live = ordered
      .slice(offset)
      .filter((file) => Date.parse(file.meta.expiresAt) > now);
    const files = live
      .slice(0, input.limit)
      .map((file) => cloneMetadata(file.meta));
    const last = files.at(-1);
    return {
      files,
      ...(live.length > input.limit && last !== undefined
        ? { nextCursor: fileCursorAfter(last.fileId) }
        : {}),
    };
  }

  async sweepExpired(input: ExpiredFileSweepInput): Promise<number> {
    validateSweepInput(input);
    const now = Date.parse(input.now);
    const expired = [...this.#files.entries()]
      .filter(([, file]) => Date.parse(file.meta.expiresAt) <= now)
      .sort(([, left], [, right]) => {
        const expiry =
          Date.parse(left.meta.expiresAt) - Date.parse(right.meta.expiresAt);
        return expiry === 0 ? left.sequence - right.sequence : expiry;
      })
      .slice(0, input.limit);
    for (const [key] of expired) this.#files.delete(key);
    return expired.length;
  }
}
