import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateLocalVaultKey,
  initializeLocalVaultFile,
  LocalVaultCredentialProvider,
} from "@eyeball/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConfiguredCredentialProvider,
  credentialProviderMode,
} from "../src/credential-provider.js";

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
    expect(() =>
      credentialProviderMode({ EYEBALL_CREDENTIALS: "cloud" }),
    ).toThrow(/mock, env, or local-vault/u);
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
});
