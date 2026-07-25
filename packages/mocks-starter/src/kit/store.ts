import { createIdFactory, type DeterministicIdFactory } from "./id.js";
import type { SnapshotableState } from "./state.js";

export type StoredRecord<T extends object> = Readonly<T & { id: string }>;
export type SeedRecord<T extends object> = T & { id?: string };

export interface CreateStoreOptions {
  idPrefix: string;
  padLength?: number;
}

export interface InMemoryStore<T extends object> extends SnapshotableState {
  readonly ids: DeterministicIdFactory;
  create(value: T): StoredRecord<T>;
  get(id: string): StoredRecord<T> | undefined;
  list(): readonly StoredRecord<T>[];
  update(id: string, patch: Partial<T>): StoredRecord<T> | undefined;
  delete(id: string): boolean;
  seed(data: readonly SeedRecord<T>[]): readonly StoredRecord<T>[];
  readonly size: number;
}

type StoreSnapshot<T extends object> = {
  sequence: unknown;
  records: StoredRecord<T>[];
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createStore<T extends object>(
  input: string | CreateStoreOptions,
): InMemoryStore<T> {
  const options = typeof input === "string" ? { idPrefix: input } : input;
  const ids = createIdFactory({
    prefix: options.idPrefix,
    ...(options.padLength === undefined
      ? {}
      : { padLength: options.padLength }),
  });
  const records = new Map<string, StoredRecord<T>>();

  function allocateAvailableId(): string {
    let id = ids.next();
    while (records.has(id)) {
      id = ids.next();
    }
    return id;
  }

  function makeRecord(value: T, id: string): StoredRecord<T> {
    return { ...clone(value), id } as StoredRecord<T>;
  }

  const store: InMemoryStore<T> = {
    ids,
    create(value) {
      const record = makeRecord(value, allocateAvailableId());
      records.set(record.id, record);
      return clone(record);
    },
    get(id) {
      const record = records.get(id);
      return record === undefined ? undefined : clone(record);
    },
    list() {
      return [...records.values()].map((record) => clone(record));
    },
    update(id, patch) {
      const current = records.get(id);
      if (current === undefined) {
        return undefined;
      }
      const updated = { ...current, ...clone(patch), id } as StoredRecord<T>;
      records.set(id, updated);
      return clone(updated);
    },
    delete(id) {
      return records.delete(id);
    },
    seed(data) {
      const nextRecords = new Map<string, StoredRecord<T>>();
      const nextIds = createIdFactory({
        prefix: options.idPrefix,
        ...(options.padLength === undefined
          ? {}
          : { padLength: options.padLength }),
      });

      for (const item of data) {
        const cloned = clone(item) as T & { id?: string };
        const generatedId = nextIds.next();
        const explicitId = cloned.id;
        if (
          explicitId !== undefined &&
          (typeof explicitId !== "string" || explicitId.length === 0)
        ) {
          throw new Error("Seed IDs must be non-empty strings");
        }
        delete cloned.id;
        let id = explicitId ?? generatedId;
        while (nextRecords.has(id) && explicitId === undefined) {
          id = nextIds.next();
        }
        if (nextRecords.has(id)) {
          throw new Error(`Duplicate seed ID: ${id}`);
        }
        nextRecords.set(id, makeRecord(cloned as T, id));
      }

      records.clear();
      for (const [id, record] of nextRecords) {
        records.set(id, record);
      }
      ids.restore(nextIds.snapshot());
      return store.list();
    },
    reset() {
      records.clear();
      ids.reset();
    },
    snapshot(): StoreSnapshot<T> {
      return {
        sequence: ids.snapshot(),
        records: [...records.values()].map((record) => clone(record)),
      };
    },
    restore(snapshot) {
      const value = snapshot as StoreSnapshot<T>;
      if (!Array.isArray(value.records)) {
        throw new Error("Invalid store snapshot");
      }
      records.clear();
      for (const record of value.records) {
        records.set(record.id, clone(record));
      }
      ids.restore(value.sequence);
    },
    get size() {
      return records.size;
    },
  };

  return store;
}
