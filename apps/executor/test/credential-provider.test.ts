import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialProviderError,
  generateLocalVaultKey,
  initializeLocalVaultFile,
  LocalVaultCredentialProvider,
} from "@eyeball/core";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConfiguredCredentialProvider,
  credentialProviderMode,
} from "../src/credential-provider.js";
import {
  parseRemoteResolvedCredential,
  RemoteCredentialProvider,
} from "../src/remote-credential-provider.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("configured credential provider", () => {
  it("defaults to mock and rejects unknown selectors", () => {
    expect(credentialProviderMode({})).toBe("mock");
    expect(createConfiguredCredentialProvider({ env: {} }).kind).toBe("mock");
    expect(credentialProviderMode({ EYEBALL_CREDENTIALS: "cloud" })).toBe(
      "cloud",
    );
    expect(() =>
      credentialProviderMode({ EYEBALL_CREDENTIALS: "unknown" }),
    ).toThrow(/mock, env, local-vault, or cloud/u);
  });

  it("builds the single-user environment provider from shared mappings", async () => {
    const provider = createConfiguredCredentialProvider({
      env: {
        EYEBALL_CREDENTIALS: "env",
        EYEBALL_PROJECT_ID: "project-real",
        EYEBALL_USER_ID: "user-real",
        EYEBALL_CRED_STRIPE_API_KEY: "stripe-real-key",
      },
    });

    expect(provider.kind).toBe("env");
    await expect(
      provider.resolve({
        projectId: "project-real",
        userId: "user-real",
        toolkitSlug: "stripe",
      }),
    ).resolves.toEqual({
      type: "api_key",
      values: { apiKey: "stripe-real-key" },
    });
  });

  it("builds the encrypted local-vault provider from environment config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eyeball-executor-vault-"));
    directories.push(directory);
    const filePath = join(directory, "vault.json");
    const key = generateLocalVaultKey();
    await initializeLocalVaultFile(filePath);

    const provider = createConfiguredCredentialProvider({
      env: {
        EYEBALL_CREDENTIALS: "local-vault",
        EYEBALL_PROJECT_ID: "project-local",
        EYEBALL_VAULT_KEY: key,
        EYEBALL_VAULT_PATH: filePath,
      },
    });

    expect(provider).toBeInstanceOf(LocalVaultCredentialProvider);
    expect(provider.kind).toBe("local-vault");
  });

  it("reports missing mode-specific environment clearly", () => {
    expect(() =>
      createConfiguredCredentialProvider({
        env: { EYEBALL_CREDENTIALS: "local-vault" },
      }),
    ).toThrow(
      "EYEBALL_VAULT_PATH is required when EYEBALL_CREDENTIALS=local-vault.",
    );
  });

  it("builds the executor-owned remote cloud provider", async () => {
    const requests: Array<{
      authorization?: string;
      cacheControl?: string;
      body: unknown;
    }> = [];
    const cloud = new Hono();
    cloud.post("/internal/credentials/resolve", async (context) => {
      requests.push({
        body: await context.req.json(),
        ...(context.req.header("Authorization") === undefined
          ? {}
          : { authorization: context.req.header("Authorization") }),
        ...(context.req.header("Cache-Control") === undefined
          ? {}
          : { cacheControl: context.req.header("Cache-Control") }),
      });
      return context.json({
        type: "oauth2",
        accessToken: "fresh-cloud-token",
        connectionId: "conn_cloud",
        expiresAt: "2026-07-20T13:00:00.000Z",
        scopes: ["mail.read"],
        tokenType: "Bearer",
      });
    });
    const provider = createConfiguredCredentialProvider({
      env: {
        EYEBALL_CREDENTIALS: "cloud",
        EYEBALL_CREDENTIALS_URL:
          "https://cloud.example.test/internal/credentials/resolve",
        EYEBALL_INTERNAL_API_SECRET:
          "credential-provider-test-secret-at-least-32-characters",
      },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
        cloud.request(new Request(input, init))) as typeof fetch,
    });

    expect(provider).toBeInstanceOf(RemoteCredentialProvider);
    await expect(
      provider.resolve({
        projectId: "project_cloud",
        userId: "user_cloud",
        toolkitSlug: "gmail",
        connectionId: "conn_cloud",
      }),
    ).resolves.toEqual({
      type: "oauth2",
      accessToken: "fresh-cloud-token",
      connectionId: "conn_cloud",
      expiresAt: "2026-07-20T13:00:00.000Z",
      scopes: ["mail.read"],
      tokenType: "Bearer",
    });
    expect(requests).toEqual([
      {
        authorization:
          "Bearer credential-provider-test-secret-at-least-32-characters",
        cacheControl: "no-store",
        body: {
          projectId: "project_cloud",
          userId: "user_cloud",
          toolkit: "gmail",
          connectionId: "conn_cloud",
        },
      },
    ]);
  });

  it("reports missing cloud companion environment clearly", () => {
    expect(() =>
      createConfiguredCredentialProvider({
        env: { EYEBALL_CREDENTIALS: "cloud" },
      }),
    ).toThrow(
      "EYEBALL_CREDENTIALS_URL is required when EYEBALL_CREDENTIALS=cloud.",
    );
    expect(() =>
      createConfiguredCredentialProvider({
        env: {
          EYEBALL_CREDENTIALS: "cloud",
          EYEBALL_CREDENTIALS_URL:
            "https://cloud.example.test/internal/credentials/resolve",
        },
      }),
    ).toThrow(
      "EYEBALL_INTERNAL_API_SECRET is required when EYEBALL_CREDENTIALS=cloud.",
    );
  });

  it("strictly parses every remote credential variant", () => {
    expect(
      parseRemoteResolvedCredential({
        type: "api_key",
        values: { apiKey: "secret" },
        connectionId: "conn_api",
      }),
    ).toEqual({
      type: "api_key",
      values: { apiKey: "secret" },
      connectionId: "conn_api",
    });
    expect(
      parseRemoteResolvedCredential({
        type: "basic",
        username: "operator",
        password: "secret",
        parameters: { database: "production" },
      }),
    ).toEqual({
      type: "basic",
      username: "operator",
      password: "secret",
      parameters: { database: "production" },
    });
    expect(parseRemoteResolvedCredential({ type: "none" })).toEqual({
      type: "none",
    });

    const leakedMaterial = "must-never-appear-in-provider-errors";
    expect(() =>
      parseRemoteResolvedCredential({
        type: "oauth2",
        accessToken: leakedMaterial,
        expiresAt: "not-a-date",
      }),
    ).toThrow("The cloud credential service returned an invalid response.");
    try {
      parseRemoteResolvedCredential({
        type: "oauth2",
        accessToken: leakedMaterial,
        expiresAt: "not-a-date",
      });
    } catch (error) {
      expect(String(error)).not.toContain(leakedMaterial);
      expect(error).toBeInstanceOf(CredentialProviderError);
    }
  });

  it("redacts transport failures from the remote credential boundary", async () => {
    const leakedMaterial = "upstream-error-contained-a-secret-token";
    const provider = new RemoteCredentialProvider({
      endpoint: "https://cloud.example.test/internal/credentials/resolve",
      internalApiSecret:
        "credential-provider-test-secret-at-least-32-characters",
      fetchImpl: async () => {
        throw new Error(leakedMaterial);
      },
    });

    try {
      await provider.resolve({
        projectId: "project_cloud",
        userId: "user_cloud",
        toolkitSlug: "gmail",
      });
      throw new Error("Expected remote credential resolution to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialProviderError);
      expect(error).toMatchObject({
        code: "provider_unavailable",
        retryable: true,
        message: "The cloud credential service could not be reached.",
      });
      expect(String(error)).not.toContain(leakedMaterial);
    }
  });
});
