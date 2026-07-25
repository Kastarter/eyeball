import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MOCKS_PACKAGES_DIRECTORY = fileURLToPath(
  new URL("../../../mocks/packages/", import.meta.url),
);

export const MOCKS_CHECKOUT_SKIP_REASON = "mocks checkout absent";

/**
 * The OSS test harness only needs this stable structural slice of Mockhouse.
 * Keeping it local lets TypeScript check the public checkout without resolving
 * files that only exist in the optional nested mocks repository.
 */
export interface ProviderMock {
  readonly slug: string;
  readonly clock: { now(): Date };
  readonly stores: Readonly<Record<string, { snapshot(): unknown }>>;
  seed(data: unknown): Promise<void>;
  advanceClock(milliseconds: number): unknown;
}

export interface MockKitModule {
  readonly EXPIRED_TOKEN: string;
  createMockApp(options: { providers: readonly ProviderMock[] }): {
    request(
      request: Request | string,
      init?: RequestInit,
    ): Response | Promise<Response>;
  };
}

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
