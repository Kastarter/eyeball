import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MOCKS_CHECKOUT_DIRECTORY = fileURLToPath(
  new URL("../../../mocks/", import.meta.url),
);
const MOCKS_PACKAGES_DIRECTORY = join(MOCKS_CHECKOUT_DIRECTORY, "packages");

export const MOCKS_CHECKOUT_SKIP_REASON = "mocks checkout absent";

export function hasMocksCheckout(): boolean {
  const available = existsSync(mocksModuleEntry("mock-kit"));
  if (available) {
    process.env.EYEBALL_FULL_MOCKS_ROOT ??= MOCKS_CHECKOUT_DIRECTORY;
  }
  return available;
}

export function mocksModuleEntry(packageName: string): string {
  return join(MOCKS_PACKAGES_DIRECTORY, packageName, "dist", "index.js");
}

export function mocksSuiteTitle(
  title: string,
  available = hasMocksCheckout(),
): string {
  return available ? title : `${title} (${MOCKS_CHECKOUT_SKIP_REASON})`;
}

export async function loadMocksModule<T>(packageName: string): Promise<T> {
  return (await import(mocksModuleEntry(packageName))) as T;
}
