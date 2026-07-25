import { Hono } from "hono";
import { createControlPlaneRoutes } from "./control.js";
import type { ProviderMock } from "./provider.js";

export interface CreateMockAppOptions {
  providers: readonly ProviderMock[];
  bundles?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export function createMockApp(options: CreateMockAppOptions): Hono {
  const app = new Hono();
  const slugs = new Set<string>();

  for (const provider of options.providers) {
    if (slugs.has(provider.slug)) {
      throw new Error(`Duplicate provider slug: ${provider.slug}`);
    }
    slugs.add(provider.slug);
  }

  app.route(
    "/_mock",
    createControlPlaneRoutes({
      providers: options.providers,
      ...(options.bundles === undefined ? {} : { bundles: options.bundles }),
    }),
  );
  for (const provider of options.providers) {
    app.route(`/${provider.slug}`, provider.app);
  }

  return app;
}
