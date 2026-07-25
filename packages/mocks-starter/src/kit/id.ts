import type { SnapshotableState } from "./state.js";

export interface DeterministicIdFactory extends SnapshotableState {
  readonly prefix: string;
  next(): string;
}

export interface IdFactoryOptions {
  prefix: string;
  padLength?: number;
}

export function createIdFactory(
  input: string | IdFactoryOptions,
): DeterministicIdFactory {
  const options = typeof input === "string" ? { prefix: input } : input;
  const padLength = options.padLength ?? 6;

  if (!/^[a-z][a-z0-9_-]*$/u.test(options.prefix)) {
    throw new Error(
      "ID prefixes must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens",
    );
  }
  if (!Number.isInteger(padLength) || padLength < 1) {
    throw new Error("ID padLength must be a positive integer");
  }

  let sequence = 0;

  return {
    prefix: options.prefix,
    next() {
      sequence += 1;
      return `${options.prefix}_${String(sequence).padStart(padLength, "0")}`;
    },
    reset() {
      sequence = 0;
    },
    snapshot() {
      return sequence;
    },
    restore(snapshot) {
      if (!Number.isSafeInteger(snapshot) || (snapshot as number) < 0) {
        throw new Error("Invalid deterministic ID snapshot");
      }
      sequence = snapshot as number;
    },
  };
}
