import { Hono } from "hono";
import {
  createMockClock,
  createStore,
  defineProviderMock,
  type MockClock,
  type ProviderMock,
} from "../kit/index.js";

export interface EchoMessage {
  text: string;
  createdAt: string;
}

export interface CreateEchoProviderOptions {
  clock?: MockClock;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Test-only provider proving the registration pattern; it is not a catalog provider. */
export function createEchoProvider(
  options: CreateEchoProviderOptions = {},
): ProviderMock {
  const clock = options.clock ?? createMockClock();
  const messages = createStore<EchoMessage>("echo");
  const app = new Hono();

  app.post("/send", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          error: {
            code: "invalid_payload",
            message: "A JSON body is required.",
          },
        },
        400,
      );
    }
    if (
      !isObject(body) ||
      typeof body.text !== "string" ||
      body.text.length === 0
    ) {
      return context.json(
        {
          error: {
            code: "invalid_payload",
            message: "text must be a non-empty string.",
          },
        },
        400,
      );
    }

    const message = messages.create({
      text: body.text,
      createdAt: clock.nowIso(),
    });
    return context.json(
      {
        message,
        state: {
          messages: messages.list(),
        },
      },
      201,
    );
  });

  app.get("/send", (context) =>
    context.json({
      state: {
        messages: messages.list(),
      },
    }),
  );

  return defineProviderMock({
    slug: "echo",
    app,
    clock,
    stores: { messages },
    formatErrors: (failure) => ({
      error: {
        code: `echo_${failure.providerCode}`,
        message: failure.message,
      },
      request_id: failure.requestId,
    }),
    oauth: {
      clients: [
        {
          clientId: "fixture-echo-client",
          clientSecret: "fixture:echo-client-secret",
          redirectUris: ["https://client.acme.example/oauth/callback"],
          scopes: ["echo.send"],
        },
      ],
      accessTokenExpiresInMs: 60_000,
      refreshTokenExpiresInMs: 120_000,
    },
    seed(data, stores) {
      if (!isObject(data) || !Array.isArray(data.messages)) {
        throw new Error("Echo seed data must contain a messages array");
      }
      const seeded = data.messages.map((item) => {
        if (
          !isObject(item) ||
          typeof item.text !== "string" ||
          item.text.length === 0 ||
          (item.id !== undefined &&
            (typeof item.id !== "string" || item.id.length === 0))
        ) {
          throw new Error(
            "Echo seed messages require text and an optional non-empty ID",
          );
        }
        return {
          text: item.text,
          createdAt: clock.nowIso(),
          ...(item.id === undefined ? {} : { id: item.id }),
        };
      });
      stores.messages.seed(seeded);
    },
    seedBundles: {
      default: {
        messages: [
          { id: "echo_default_000001", text: "Hello from Avery Example" },
        ],
      },
    },
  });
}
