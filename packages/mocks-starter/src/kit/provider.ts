import { Hono } from "hono";
import { createAuthMiddleware, type FormatProviderError } from "./auth.js";
import {
  type ClockAdvanceResult,
  createMockClock,
  type MockClock,
} from "./clock.js";
import { createControlPlaneRoutes } from "./control.js";
import { createIdFactory } from "./id.js";
import {
  createOAuthSimulation,
  type OAuthSimulation,
  type OAuthSimulationOptions,
} from "./oauth.js";
import type { SnapshotableState } from "./state.js";

export interface ProviderMock {
  readonly slug: string;
  readonly app: Hono;
  readonly stores: Readonly<Record<string, SnapshotableState>>;
  readonly clock: MockClock;
  reset(): void;
  seed(data: unknown): Promise<void>;
  advanceClock(milliseconds: number): ClockAdvanceResult;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export interface DefineProviderMockOptions<
  TStores extends Readonly<Record<string, SnapshotableState>>,
> {
  slug: string;
  app: Hono;
  stores: TStores;
  seed: (data: unknown, stores: TStores) => void | Promise<void>;
  clock?: MockClock;
  apiKeyHeader?: string;
  reset?: () => void;
  formatErrors?: FormatProviderError;
  oauth?: false | Omit<OAuthSimulationOptions, "slug" | "clock">;
  seedBundles?: Readonly<Record<string, unknown>>;
}

type ProviderSnapshot = {
  stores: Record<string, unknown>;
  clock: unknown;
  oauth?: unknown;
  requestIds: unknown;
};

function assertSlug(slug: string): void {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw new Error("Provider slugs must use lowercase kebab-case");
  }
}

export function defineProviderMock<
  TStores extends Readonly<Record<string, SnapshotableState>>,
>(options: DefineProviderMockOptions<TStores>): ProviderMock {
  assertSlug(options.slug);
  const clock = options.clock ?? createMockClock();
  const requestIds = createIdFactory(`req_${options.slug}`);
  const oauth: OAuthSimulation | undefined =
    options.oauth === false || options.oauth === undefined
      ? undefined
      : createOAuthSimulation({
          ...options.oauth,
          slug: options.slug,
          clock,
        });
  const wrapper = new Hono();

  let provider: ProviderMock;

  provider = {
    slug: options.slug,
    app: wrapper,
    stores: options.stores,
    clock,
    reset() {
      const before = provider.snapshot();
      try {
        for (const store of Object.values(options.stores)) {
          store.reset();
        }
        oauth?.reset();
        requestIds.reset();
        clock.reset();
        options.reset?.();
      } catch (error) {
        provider.restore(before);
        throw error;
      }
    },
    async seed(data) {
      const before = provider.snapshot();
      try {
        await options.seed(data, options.stores);
      } catch (error) {
        provider.restore(before);
        throw error;
      }
    },
    advanceClock(milliseconds) {
      return clock.advance(milliseconds);
    },
    snapshot(): ProviderSnapshot {
      const stores: Record<string, unknown> = {};
      for (const [name, store] of Object.entries(options.stores)) {
        stores[name] = store.snapshot();
      }
      return {
        stores,
        clock: clock.snapshot(),
        ...(oauth === undefined ? {} : { oauth: oauth.snapshot() }),
        requestIds: requestIds.snapshot(),
      };
    },
    restore(snapshot) {
      const value = snapshot as ProviderSnapshot;
      if (
        typeof value !== "object" ||
        value === null ||
        typeof value.stores !== "object"
      ) {
        throw new Error("Invalid provider snapshot");
      }
      for (const [name, store] of Object.entries(options.stores)) {
        if (!(name in value.stores)) {
          throw new Error(`Provider snapshot is missing store: ${name}`);
        }
        store.restore(value.stores[name]);
      }
      clock.restore(value.clock);
      if (oauth !== undefined) {
        oauth.restore(value.oauth);
      }
      requestIds.restore(value.requestIds);
    },
  };

  if (oauth !== undefined) {
    wrapper.route("/_mock/oauth", oauth.app);
  }

  const localBundles =
    options.seedBundles === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(options.seedBundles).map(([name, data]) => [
            name,
            { [options.slug]: data },
          ]),
        );
  wrapper.route(
    "/_mock",
    createControlPlaneRoutes({
      providers: [provider],
      ...(localBundles === undefined ? {} : { bundles: localBundles }),
    }),
  );

  const auth = createAuthMiddleware({
    ...(options.apiKeyHeader === undefined
      ? {}
      : { apiKeyHeader: options.apiKeyHeader }),
    ...(options.formatErrors === undefined
      ? {}
      : { formatErrors: options.formatErrors }),
    requestIds,
    ...(oauth === undefined
      ? {}
      : { validateToken: (token: string) => oauth.validateAccessToken(token) }),
  });
  wrapper.use("*", async (context, next) => {
    if (context.req.path.split("/").includes("_mock")) {
      await next();
      return;
    }
    return auth(context, next);
  });
  wrapper.route("/", options.app);

  return provider;
}
