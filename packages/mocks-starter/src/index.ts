import type { Hono } from "hono";
import type { ProviderMock } from "./kit/index.js";
import { createMockApp } from "./kit/index.js";
import {
  createEchoProvider,
  providers as registeredProviders,
} from "./providers/index.js";

export type { ProviderMock } from "./kit/index.js";
export { createMockApp } from "./kit/index.js";

export interface StarterMockhouseRuntime {
  readonly app: Hono;
  readonly providers: readonly ProviderMock[];
}

/**
 * Creates the small, public Mockhouse starter app.
 *
 * The echo provider proves the registration pattern. Provider ports append
 * their implementations to `src/providers/index.ts`.
 */
export function createStarterMockhouse(): StarterMockhouseRuntime {
  const providers: readonly ProviderMock[] = [
    createEchoProvider(),
    ...registeredProviders,
  ];
  const app = createMockApp({
    providers,
    bundles: {
      "echo-default": {
        echo: {
          messages: [
            {
              id: "echo_default_000001",
              text: "Hello from Avery Example",
            },
          ],
        },
      },
    },
  });

  app.get("/_mock/status", (context) =>
    context.json({
      providers: providers.map((provider) => provider.slug),
    }),
  );

  return { app, providers };
}
