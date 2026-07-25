import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MOCKS_PACKAGES_DIRECTORY = fileURLToPath(
  new URL("../../../mocks/packages/", import.meta.url),
);

export const MOCKS_CHECKOUT_SKIP_REASON = "mocks checkout absent";

export function hasMocksCheckout(): boolean {
  return existsSync(mocksModuleEntry("mock-kit"));
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
