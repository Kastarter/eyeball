import {
  type Clock,
  type FileId,
  type ResolvedFile,
  systemClock,
} from "@eyeball/core";

export const DEFAULT_FILE_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_MAX_FILE_SIZE_BYTES = 25 * 1_024 * 1_024;

/** Durable storage seam; staging policy and tenant authorization stay in the engine. */
export interface FileStore {
  put(projectId: string, file: ResolvedFile): Promise<void>;
  get(projectId: string, fileId: FileId): Promise<ResolvedFile | undefined>;
}

export interface InMemoryFileStoreOptions {
  clock?: Clock;
}

function storageKey(projectId: string, fileId: FileId): string {
  return JSON.stringify([projectId, fileId]);
}

function cloneFile(file: ResolvedFile): ResolvedFile {
  return {
    meta: structuredClone(file.meta),
    content: Uint8Array.from(file.content),
  };
}

/** Process-local, project-scoped file store with lazy TTL eviction. */
export class InMemoryFileStore implements FileStore {
  readonly #clock: Clock;
  readonly #files = new Map<string, ResolvedFile>();

  constructor(options: InMemoryFileStoreOptions = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  async put(projectId: string, file: ResolvedFile): Promise<void> {
    const key = storageKey(projectId, file.meta.fileId);
    if (this.#files.has(key)) {
      throw new Error(`Duplicate staged-file ID: ${file.meta.fileId}`);
    }
    this.#files.set(key, cloneFile(file));
  }

  async get(
    projectId: string,
    fileId: FileId,
  ): Promise<ResolvedFile | undefined> {
    const key = storageKey(projectId, fileId);
    const file = this.#files.get(key);
    if (file === undefined) {
      return undefined;
    }
    const now = this.#clock.now();
    if (Number.isNaN(now.valueOf())) {
      throw new Error("File-store clock returned an invalid date.");
    }
    if (Date.parse(file.meta.expiresAt) <= now.valueOf()) {
      this.#files.delete(key);
      return undefined;
    }
    return cloneFile(file);
  }
}
