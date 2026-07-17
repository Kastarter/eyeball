import { createConnectionId, TOOL_ERROR_CODES } from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  createMockApp,
  type ProviderMock,
} from "../../../mocks/packages/mock-kit/dist/index.js";
import { createGmailMock } from "../../../mocks/packages/mocks-email/dist/index.js";
import { Eyeball } from "../../../packages/sdk/src/index.js";
import {
  createExecutorApp,
  ExecutionEngine,
  InMemoryDevVault,
} from "../src/index.js";

const API_KEY_A = "ey_test_dev_vault_a";
const API_KEY_B = "ey_test_dev_vault_b";
const PROJECT_A = "proj_dev_vault_a";
const PROJECT_B = "proj_dev_vault_b";
const USER_ID = "user_dev_vault";
const PROVIDER_ORIGIN = "http://providers.local";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const CREATED_AT = "2026-07-17T09:30:00.000Z";

function providerFetch(provider: ProviderMock): typeof globalThis.fetch {
  const providerApp = createMockApp({ providers: [provider] });
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== PROVIDER_ORIGIN) {
      throw new Error(`Unexpected provider origin: ${request.url}`);
    }
    return providerApp.request(request);
  }) as typeof globalThis.fetch;
}

function createHarness() {
  const provider = createGmailMock();
  let connectionIndex = 0;
  const vault = new InMemoryDevVault({
    credentials: {
      gmail: {
        type: "oauth2",
        accessToken: "fixture:valid",
        scopes: [GMAIL_SCOPE],
      },
    },
    connectionIdFactory: () => {
      connectionIndex += 1;
      return createConnectionId(`dev_vault_${connectionIndex}`);
    },
    now: () => new Date(CREATED_AT),
  });
  const engine = new ExecutionEngine({
    credentialProvider: vault,
    fetchImpl: providerFetch(provider),
    env: { EYEBALL_GMAIL_BASE_URL: `${PROVIDER_ORIGIN}/gmail` },
  });
  const app = createExecutorApp({
    engine,
    devVault: vault,
    apiKeys: {
      [API_KEY_A]: PROJECT_A,
      [API_KEY_B]: PROJECT_B,
    },
    requestIdFactory: () => "req_dev_vault",
  });
  const executorFetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => app.request(new Request(input, init))) as typeof globalThis.fetch;

  return {
    app,
    clientA: new Eyeball({
      apiKey: API_KEY_A,
      baseUrl: "http://executor.local",
      fetch: executorFetch,
      userId: USER_ID,
    }),
    clientB: new Eyeball({
      apiKey: API_KEY_B,
      baseUrl: "http://executor.local",
      fetch: executorFetch,
      userId: USER_ID,
    }),
    vault,
  };
}

function postConnection(
  app: ReturnType<typeof createExecutorApp>,
  body: unknown,
): Promise<Response> {
  return app.request("/v1/connections", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY_A}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function deleteConnection(
  app: ReturnType<typeof createExecutorApp>,
  connectionId: string,
  apiKey = API_KEY_A,
): Promise<Response> {
  return app.request(`/v1/connections/${connectionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

describe("OSS executor dev vault", () => {
  it("creates a fixture connection that the SDK can execute immediately", async () => {
    const { clientA } = createHarness();

    const connection = await clientA.connections.create({ toolkit: "gmail" });
    expect(connection).toEqual({
      connectionId: "conn_dev_vault_1",
      redirectUrl: null,
      status: "connected",
    });
    await expect(
      clientA.tools.run(
        "gmail.list_emails",
        {},
        { connectionId: connection.connectionId },
      ),
    ).resolves.toEqual({ emails: [] });
  });

  it("keeps fixture connections scoped to the authenticated project and user", async () => {
    const { clientA, clientB } = createHarness();
    const connection = await clientA.connections.create({ toolkit: "gmail" });

    const crossProject = await clientB.tools.execute("gmail.list_emails", {
      input: {},
      connectionId: connection.connectionId,
    });
    const crossUser = await clientA.tools.execute("gmail.list_emails", {
      userId: "user_dev_vault_other",
      input: {},
      connectionId: connection.connectionId,
    });

    for (const result of [crossProject, crossUser]) {
      expect(result).toMatchObject({
        tool: "gmail.list_emails",
        status: "failed",
        error: {
          code: TOOL_ERROR_CODES.AUTH_MISSING,
          retryable: false,
        },
      });
    }
  });

  it("lists project connections and revokes them without exposing credentials", async () => {
    const { app, clientA, clientB } = createHarness();
    const connectionA = await clientA.connections.create({ toolkit: "gmail" });
    await clientB.connections.create({ toolkit: "gmail" });

    const list = await app.request("/v1/connections", {
      headers: { Authorization: `Bearer ${API_KEY_A}` },
    });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({
      connections: [
        {
          connectionId: connectionA.connectionId,
          createdAt: CREATED_AT,
          status: "connected",
          toolkit: "gmail",
          userId: USER_ID,
        },
      ],
    });

    const crossProject = await deleteConnection(
      app,
      connectionA.connectionId,
      API_KEY_B,
    );
    expect(crossProject.status).toBe(404);

    const revoked = await deleteConnection(app, connectionA.connectionId);
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({
      connectionId: connectionA.connectionId,
      status: "revoked",
    });

    const afterRevoke = await app.request("/v1/connections", {
      headers: { Authorization: `Bearer ${API_KEY_A}` },
    });
    await expect(afterRevoke.json()).resolves.toMatchObject({
      connections: [{ status: "revoked" }],
    });
    await expect(
      clientA.tools.execute("gmail.list_emails", {
        connectionId: connectionA.connectionId,
        input: {},
      }),
    ).resolves.toMatchObject({
      error: { code: TOOL_ERROR_CODES.AUTH_MISSING },
      status: "failed",
    });
  });

  it("validates connection bodies and unsupported fixture toolkits", async () => {
    const { app } = createHarness();

    const unknownField = await postConnection(app, {
      userId: USER_ID,
      toolkit: "gmail",
      extra: true,
    });
    expect(unknownField.status).toBe(422);
    await expect(unknownField.json()).resolves.toMatchObject({
      error: { code: TOOL_ERROR_CODES.INVALID_INPUT },
      requestId: "req_dev_vault",
    });

    const unsupported = await postConnection(app, {
      userId: USER_ID,
      toolkit: "slack",
    });
    expect(unsupported.status).toBe(422);
    await expect(unsupported.json()).resolves.toMatchObject({
      error: { code: TOOL_ERROR_CODES.NOT_SUPPORTED },
      requestId: "req_dev_vault",
    });
  });

  it("does not expose the connection route unless a dev vault is explicit", async () => {
    const app = createExecutorApp({
      apiKeys: { [API_KEY_A]: PROJECT_A },
      requestIdFactory: () => "req_no_dev_vault",
    });

    const response = await postConnection(app, {
      userId: USER_ID,
      toolkit: "gmail",
    });

    expect(response.status).toBe(404);
  });

  it("requires the route and engine to share one credential provider", () => {
    const vault = new InMemoryDevVault({
      credentials: {
        gmail: {
          type: "oauth2",
          accessToken: "fixture:valid",
          scopes: [GMAIL_SCOPE],
        },
      },
    });

    expect(() =>
      createExecutorApp({
        engine: new ExecutionEngine(),
        devVault: vault,
        apiKeys: { [API_KEY_A]: PROJECT_A },
      }),
    ).toThrow(
      "The executor engine and dev-vault route must use the same credential provider.",
    );
  });

  it("rejects non-fixture secrets at the dev-vault boundary", () => {
    expect(
      () =>
        new InMemoryDevVault({
          credentials: {
            gmail: {
              type: "oauth2",
              accessToken: "real-looking-secret",
              scopes: [GMAIL_SCOPE],
            },
          },
        }),
    ).toThrow("must start with fixture:");
  });
});
