import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_MOCKS_ROOT_ENV = "EYEBALL_FULL_MOCKS_ROOT";

/**
 * Loads a module from an explicitly supplied optional Mockhouse checkout.
 *
 * Demo source intentionally has no static dependency on that private checkout,
 * so public builds and test discovery work without it.
 */
export async function loadFullMocksModule<T>(packageName: string): Promise<T> {
  const suppliedRoot = process.env[FULL_MOCKS_ROOT_ENV];
  if (suppliedRoot === undefined || suppliedRoot.trim().length === 0) {
    throw new Error(
      "This demo requires the full Mockhouse checkout. Run it through its pnpm demo command.",
    );
  }
  const entry = join(
    resolve(suppliedRoot),
    "packages",
    packageName,
    "dist",
    "index.js",
  );
  return (await import(pathToFileURL(entry).href)) as T;
}
