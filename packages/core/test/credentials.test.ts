import { describe, expect, it } from "vitest";
import {
  CloudCredentialProviderStub,
  CredentialProviderError,
  credentialEnvPrefix,
  EnvCredentialProvider,
  MOCK_CREDENTIAL_TRIGGER_TOKENS,
  MockCredentialProvider,
  type MockCredentialTriggerToken,
} from "../src/index.js";

const baseContext = {
  projectId: "project-1",
  userId: "user-1",
  toolkitSlug: "gmail",
} as const;

describe("EnvCredentialProvider", () => {
  it("resolves a convention-named OAuth2 credential for its one allowed scope", async () => {
    const provider = new EnvCredentialProvider({
      allowedProjectId: "project-1",
      allowedUserId: "user-1",
      env: {
        EYEBALL_CRED_GMAIL_ACCESS_TOKEN: "access-token",
        EYEBALL_CRED_GMAIL_SCOPES: "mail.read,mail.send profile",
        EYEBALL_CRED_GMAIL_EXPIRES_AT: "2999-01-01T00:00:00.000Z",
      },
      mappings: {
        gmail: {
          type: "oauth2",
          accessTokenEnv: "EYEBALL_CRED_GMAIL_ACCESS_TOKEN",
          scopesEnv: "EYEBALL_CRED_GMAIL_SCOPES",
          expiresAtEnv: "EYEBALL_CRED_GMAIL_EXPIRES_AT",
        },
      },
    });

    await expect(provider.resolve(baseContext)).resolves.toEqual({
      type: "oauth2",
      accessToken: "access-token",
      scopes: ["mail.read", "mail.send", "profile"],
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
  });

  it.each([
    ["project", { ...baseContext, projectId: "another-project" }],
    ["user", { ...baseContext, userId: "another-user" }],
  ] as const)("refuses cross-%s resolution without disclosure", async (_scope, context) => {
    const provider = new EnvCredentialProvider({
      allowedProjectId: "project-1",
      allowedUserId: "user-1",
      env: { EYEBALL_CRED_GMAIL_ACCESS_TOKEN: "access-token" },
      mappings: {
        gmail: {
          type: "oauth2",
          accessTokenEnv: "EYEBALL_CRED_GMAIL_ACCESS_TOKEN",
        },
      },
    });

    await expect(provider.resolve(context)).rejects.toMatchObject({
      code: "auth_missing",
      retryable: false,
    });
  });

  it("refuses named connections it cannot verify", async () => {
    const provider = new EnvCredentialProvider({
      allowedProjectId: "project-1",
      allowedUserId: "user-1",
      env: {},
      mappings: { gmail: { type: "none" } },
    });

    await expect(
      provider.resolve({ ...baseContext, connectionId: "conn_other" }),
    ).rejects.toBeInstanceOf(CredentialProviderError);
  });

  it("resolves named API-key fields and reports missing fields as auth_missing", async () => {
    const options = {
      allowedProjectId: "project-1",
      allowedUserId: "user-1",
      mappings: {
        stripe: {
          type: "api_key" as const,
          valueEnvs: { apiKey: "EYEBALL_CRED_STRIPE_API_KEY" },
        },
      },
    };
    const provider = new EnvCredentialProvider({
      ...options,
      env: { EYEBALL_CRED_STRIPE_API_KEY: "sk_test" },
    });
    await expect(
      provider.resolve({ ...baseContext, toolkitSlug: "stripe" }),
    ).resolves.toEqual({ type: "api_key", values: { apiKey: "sk_test" } });

    const missing = new EnvCredentialProvider({ ...options, env: {} });
    await expect(
      missing.resolve({ ...baseContext, toolkitSlug: "stripe" }),
    ).rejects.toMatchObject({ code: "auth_missing" });
  });

  it("enforces EYEBALL_CRED_<TOOLKIT>_* variable names", () => {
    expect(credentialEnvPrefix("microsoft-outlook")).toBe(
      "EYEBALL_CRED_MICROSOFT_OUTLOOK_",
    );
    expect(
      () =>
        new EnvCredentialProvider({
          allowedProjectId: "project-1",
          allowedUserId: "user-1",
          env: {},
          mappings: {
            gmail: { type: "oauth2", accessTokenEnv: "GMAIL_TOKEN" },
          },
        }),
    ).toThrow("EYEBALL_CRED_GMAIL_*");
  });

  it("fails readiness when its local scope invariant is empty", async () => {
    const provider = new EnvCredentialProvider({
      allowedProjectId: "",
      allowedUserId: "user-1",
      env: {},
      mappings: { gmail: { type: "none" } },
    });

    await expect(provider.checkReadiness()).rejects.toThrow(
      "scope IDs must not be empty",
    );
  });
});

describe("MockCredentialProvider", () => {
  it.each(
    Object.values(MOCK_CREDENTIAL_TRIGGER_TOKENS).map(
      (token) => [token] as const,
    ),
  )("issues the reserved downstream trigger token %s", async (token) => {
    const provider = mockOAuthProvider(token);
    await expect(provider.resolve(baseContext)).resolves.toMatchObject({
      type: "oauth2",
      accessToken: token,
    });
  });

  it("selects an explicit fixture connection and returns its actual ID", async () => {
    const provider = new MockCredentialProvider([
      {
        match: { ...baseContext, connectionId: "conn_primary" },
        credential: { type: "api_key", values: { apiKey: "fixture:key" } },
      },
      {
        match: { ...baseContext, connectionId: "conn_secondary" },
        credential: { type: "api_key", values: { apiKey: "fixture:key-2" } },
      },
    ]);

    await expect(
      provider.resolve({ ...baseContext, connectionId: "conn_secondary" }),
    ).resolves.toEqual({
      type: "api_key",
      connectionId: "conn_secondary",
      values: { apiKey: "fixture:key-2" },
    });
    await expect(provider.resolve(baseContext)).rejects.toMatchObject({
      code: "auth_missing",
    });
  });

  it("refreshes only through the fixture's declared OAuth2 replacement", async () => {
    const provider = new MockCredentialProvider([
      {
        match: baseContext,
        credential: {
          type: "oauth2",
          accessToken: "fixture:expired",
        },
        refreshTo: {
          type: "oauth2",
          accessToken: "fixture:refreshed",
          scopes: ["mail.read"],
        },
      },
    ]);

    await expect(
      provider.refresh({
        ...baseContext,
        current: { type: "oauth2", accessToken: "fixture:expired" },
        reason: "expired",
      }),
    ).resolves.toEqual({
      type: "oauth2",
      accessToken: "fixture:refreshed",
      scopes: ["mail.read"],
    });
  });

  it("rejects non-fixture secrets at construction", () => {
    expect(
      () =>
        new MockCredentialProvider([
          {
            match: baseContext,
            credential: { type: "oauth2", accessToken: "real-secret" },
          },
        ]),
    ).toThrow("must start with fixture:");
  });
});

describe("CloudCredentialProviderStub", () => {
  it("clearly points callers to the executor implementation", async () => {
    await expect(
      new CloudCredentialProviderStub().resolve(baseContext),
    ).rejects.toThrow("executor RemoteCredentialProvider");
  });
});

function mockOAuthProvider(token: MockCredentialTriggerToken) {
  return new MockCredentialProvider([
    {
      match: baseContext,
      credential: { type: "oauth2", accessToken: token },
    },
  ]);
}
