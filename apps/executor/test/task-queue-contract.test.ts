import { afterAll } from "vitest";
import {
  createPgliteStoreBundle,
  InMemoryJobStore,
  type PgliteStoreBundle,
} from "../src/index.js";
import { registerTaskQueueContractSuite } from "./helpers/task-queue-contract-suite.js";

let bundlePromise: Promise<PgliteStoreBundle> | undefined;

function pglite(): Promise<PgliteStoreBundle> {
  bundlePromise ??= createPgliteStoreBundle();
  return bundlePromise;
}

afterAll(async () => {
  if (bundlePromise !== undefined) await (await bundlePromise).close();
});

registerTaskQueueContractSuite([
  {
    name: "memory",
    durable: false,
    jobStore: async () => new InMemoryJobStore(),
  },
  {
    name: "PGlite",
    durable: true,
    jobStore: async () => (await pglite()).jobStore,
  },
]);
