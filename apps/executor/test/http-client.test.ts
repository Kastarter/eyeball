import {
  JSON_SCHEMA_DRAFT_2020_12,
  type ResolvedCredential,
  type ToolDefinition,
} from "@eyeball/core";
import { describe, expect, it, vi } from "vitest";
import {
  type AdapterContext,
  createProviderHttpClient,
  noopLogger,
  systemClock,
} from "../src/index.js";

const tool: ToolDefinition = {
  name: "echo.run",
  toolkit: "echo",
  capability: "ai_media_utilities",
  description: "HTTP helper test tool.",
  inputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    type: "object",
  },
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: "1.0.0",
};

const unavailableFiles: AdapterContext["files"] = {
  resolve: async () => {
    throw new Error("No staged files are used by HTTP client tests.");
  },
};

async function authorizationFor(
  credential: ResolvedCredential,
): Promise<string | null> {
  let authorization: string | null = null;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("Authorization");
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const context: AdapterContext = {
    projectId: "project_test",
    userId: "user_test",
    tool,
    canonicalInput: {},
    credential,
    baseUrl: "https://provider.example.test/v1",
    fetchImpl,
    clock: systemClock,
    logger: noopLogger,
    files: unavailableFiles,
  };

  await createProviderHttpClient(context)("operation");
  return authorization;
}

describe("provider HTTP client", () => {
  it("injects Bearer auth for OAuth2 and API-key credentials", async () => {
    await expect(
      authorizationFor({ type: "oauth2", accessToken: "fixture:oauth" }),
    ).resolves.toBe("Bearer fixture:oauth");
    await expect(
      authorizationFor({
        type: "api_key",
        values: { apiKey: "fixture:api-key" },
      }),
    ).resolves.toBe("Bearer fixture:api-key");
  });

  it("injects Basic auth for username/password credentials", async () => {
    await expect(
      authorizationFor({
        type: "basic",
        username: "account",
        password: "fixture:password",
      }),
    ).resolves.toBe(
      `Basic ${Buffer.from("account:fixture:password").toString("base64")}`,
    );
  });

  it("does not send configured credentials to another origin", async () => {
    let calls = 0;
    const context: AdapterContext = {
      projectId: "project_test",
      userId: "user_test",
      tool,
      canonicalInput: {},
      credential: { type: "oauth2", accessToken: "fixture:secret" },
      baseUrl: "https://provider.example.test",
      fetchImpl: (async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      clock: systemClock,
      logger: noopLogger,
      files: unavailableFiles,
    };

    await expect(
      createProviderHttpClient(context)("https://attacker.example.test"),
    ).rejects.toMatchObject({ code: "not_supported" });
    expect(calls).toBe(0);
  });

  it("retains bounded provider diagnostics while redacting secret fields", async () => {
    const context: AdapterContext = {
      projectId: "project_test",
      userId: "user_test",
      tool,
      canonicalInput: {},
      credential: { type: "api_key", values: { apiKey: "fixture:secret" } },
      baseUrl: "https://provider.example.test",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "card_error",
              code: "card_declined",
              message: "The card was declined.",
              access_token: "must-not-escape",
            },
          }),
          {
            status: 402,
            headers: { "Content-Type": "application/json" },
          },
        )) as typeof fetch,
      clock: systemClock,
      logger: noopLogger,
      files: unavailableFiles,
    };

    await expect(
      createProviderHttpClient(context)("charge"),
    ).rejects.toMatchObject({
      code: "provider_error",
      providerDetail: {
        toolkit: "echo",
        status: 402,
        detail: {
          error: {
            type: "card_error",
            code: "card_declined",
            message: "The card was declined.",
            access_token: "[REDACTED]",
          },
        },
      },
    });
  });

  it("redacts credential values from the public provider error message", async () => {
    const secret = "sk_live_private_123";
    const context: AdapterContext = {
      projectId: "project_test",
      userId: "user_test",
      tool,
      canonicalInput: {},
      credential: { type: "api_key", values: { apiKey: secret } },
      baseUrl: "https://provider.example.test",
      fetchImpl: (async () =>
        Response.json(
          { error: { message: `invalid token ${secret}` } },
          { status: 401 },
        )) as typeof fetch,
      clock: systemClock,
      logger: noopLogger,
      files: unavailableFiles,
    };

    let thrown: unknown;
    try {
      await createProviderHttpClient(context)("charge");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      message: expect.stringContaining("[REDACTED]"),
      providerDetail: {
        detail: { error: { message: expect.stringContaining("[REDACTED]") } },
      },
    });
    expect(JSON.stringify(thrown)).not.toContain(secret);
  });

  it("classifies authentication failures before redacting credential signals", async () => {
    const secret = "fixture:EXPIRED_TOKEN";
    const context: AdapterContext = {
      projectId: "project_test",
      userId: "user_test",
      tool,
      canonicalInput: {},
      credential: { type: "api_key", values: { apiKey: secret } },
      baseUrl: "https://provider.example.test",
      fetchImpl: (async () =>
        Response.json({ error: secret }, { status: 401 })) as typeof fetch,
      clock: systemClock,
      logger: noopLogger,
      files: unavailableFiles,
    };

    let thrown: unknown;
    try {
      await createProviderHttpClient(context)("charge");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "auth_expired",
      message: "[REDACTED]",
      providerDetail: { detail: { error: "[REDACTED]" } },
    });
    expect(JSON.stringify(thrown)).not.toContain(secret);
  });

  it("does not automatically follow credentialed redirects", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 307,
          headers: { Location: "https://attacker.example.test/capture" },
        });
      },
    ) as typeof fetch;
    const context: AdapterContext = {
      projectId: "project_test",
      userId: "user_test",
      tool,
      canonicalInput: {},
      credential: { type: "api_key", values: { apiKey: "fixture:secret" } },
      baseUrl: "https://provider.example.test",
      fetchImpl,
      clock: systemClock,
      logger: noopLogger,
      files: unavailableFiles,
    };

    await expect(
      createProviderHttpClient(context)("redirect", {
        method: "POST",
        body: "sensitive body",
      }),
    ).rejects.toMatchObject({
      code: "provider_error",
      message: "The provider returned an unexpected redirect.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
