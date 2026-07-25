import { type Context, Hono } from "hono";
import type { ProviderMock } from "./provider.js";

export interface ControlPlaneOptions {
  providers: readonly ProviderMock[];
  bundles?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

type ProviderSelection = {
  providers?: unknown;
};

type SeedRequest = {
  bundle?: unknown;
  providers?: unknown;
};

type AdvanceRequest = {
  milliseconds?: unknown;
};

class ControlPlaneError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readObject(context: Context): Promise<Record<string, unknown>> {
  const text = await context.req.text();
  if (text.trim().length === 0) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ControlPlaneError(
      "Control-plane requests must contain valid JSON.",
    );
  }
  if (!isObject(value)) {
    throw new ControlPlaneError(
      "Control-plane request bodies must be JSON objects.",
    );
  }
  return value;
}

function errorResponse(context: Context, error: unknown): Response {
  const message =
    error instanceof ControlPlaneError || error instanceof Error
      ? error.message
      : "The control-plane operation failed.";
  return context.json(
    {
      error: {
        code:
          error instanceof ControlPlaneError
            ? "invalid_request"
            : "operation_failed",
        message,
      },
    },
    error instanceof ControlPlaneError ? 400 : 500,
  );
}

async function transaction(
  providers: readonly ProviderMock[],
  operation: (provider: ProviderMock) => void | Promise<void>,
): Promise<void> {
  const snapshots = providers.map((provider) => ({
    provider,
    snapshot: provider.snapshot(),
  }));
  try {
    for (const provider of providers) {
      await operation(provider);
    }
  } catch (error) {
    for (const item of [...snapshots].reverse()) {
      item.provider.restore(item.snapshot);
    }
    throw error;
  }
}

export function createControlPlaneRoutes(options: ControlPlaneOptions): Hono {
  const app = new Hono();
  const providersBySlug = new Map(
    options.providers.map((provider) => [provider.slug, provider] as const),
  );

  if (providersBySlug.size !== options.providers.length) {
    throw new Error("Control-plane provider slugs must be unique");
  }

  function resolveSelection(body: ProviderSelection): ProviderMock[] {
    if (body.providers === undefined) {
      return [...options.providers];
    }
    if (
      !Array.isArray(body.providers) ||
      body.providers.some((slug) => typeof slug !== "string")
    ) {
      throw new ControlPlaneError(
        "providers must be an array of provider slugs.",
      );
    }
    const selected: ProviderMock[] = [];
    for (const slug of new Set(body.providers as string[])) {
      const provider = providersBySlug.get(slug);
      if (provider === undefined) {
        throw new ControlPlaneError(`Unknown provider: ${slug}`);
      }
      selected.push(provider);
    }
    return selected;
  }

  app.post("/reset", async (context) => {
    try {
      const body = (await readObject(context)) as ProviderSelection;
      const selected = resolveSelection(body);
      await transaction(selected, (provider) => provider.reset());
      return context.json({ reset: selected.map((provider) => provider.slug) });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post("/seed", async (context) => {
    try {
      const body = (await readObject(context)) as SeedRequest;
      const hasBundle = Object.hasOwn(body, "bundle");
      const hasProviders = Object.hasOwn(body, "providers");
      if (hasBundle === hasProviders) {
        throw new ControlPlaneError(
          "Exactly one of bundle or providers must be supplied.",
        );
      }

      let providerData: Readonly<Record<string, unknown>>;
      if (hasBundle) {
        if (typeof body.bundle !== "string" || body.bundle.length === 0) {
          throw new ControlPlaneError("bundle must be a non-empty string.");
        }
        const bundle = options.bundles?.[body.bundle];
        if (bundle === undefined) {
          throw new ControlPlaneError(`Unknown fixture bundle: ${body.bundle}`);
        }
        providerData = bundle;
      } else {
        if (!isObject(body.providers)) {
          throw new ControlPlaneError(
            "providers must be an object keyed by provider slug.",
          );
        }
        providerData = body.providers;
      }

      const selected: Array<{ provider: ProviderMock; data: unknown }> = [];
      for (const [slug, data] of Object.entries(providerData)) {
        const provider = providersBySlug.get(slug);
        if (provider === undefined) {
          throw new ControlPlaneError(`Unknown provider: ${slug}`);
        }
        selected.push({ provider, data });
      }
      if (selected.length === 0) {
        throw new ControlPlaneError(
          "At least one provider seed must be supplied.",
        );
      }

      await transaction(
        selected.map((item) => item.provider),
        async (provider) => {
          const item = selected.find(
            (candidate) => candidate.provider === provider,
          );
          await provider.seed(item?.data);
        },
      );
      return context.json({
        seeded: selected.map((item) => item.provider.slug),
      });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post("/clock/advance", async (context) => {
    try {
      const body = (await readObject(context)) as AdvanceRequest;
      if (
        typeof body.milliseconds !== "number" ||
        !Number.isSafeInteger(body.milliseconds) ||
        body.milliseconds <= 0
      ) {
        throw new ControlPlaneError("milliseconds must be a positive integer.");
      }

      const results: Array<{ now: string; transitions: number }> = [];
      await transaction(options.providers, (provider) => {
        results.push(provider.advanceClock(body.milliseconds as number));
      });
      const now = results[0]?.now;
      if (now === undefined) {
        throw new ControlPlaneError("No providers are mounted.");
      }
      return context.json({
        now,
        transitions: results.reduce(
          (total, result) => total + result.transitions,
          0,
        ),
      });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  return app;
}
