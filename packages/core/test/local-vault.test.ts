import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CredentialProviderError,
  generateLocalVaultKey,
  initializeLocalVaultFile,
  LocalVaultCredentialProvider,
  requestOAuthToken,
} from "../src/index.js";

const directories: string[] = [];
const baseContext = {
  projectId: "project-local",
  userId: "user-local",
  toolkitSlug: "gmail",
} as const;

async function vaultFixture() {
  const directory = await mkdtemp(join(tmpdir(), "eyeball-local-vault-"));
  directories.push(directory);
  const filePath = join(directory, "vault.json");
  const key = generateLocalVaultKey();
  await initializeLocalVaultFile(filePath);
  return { directory, filePath, key, env: { EYEBALL_VAULT_KEY: key } };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalVaultCredentialProvider", () => {
  it("requires a valid EYEBALL_VAULT_KEY at startup", async () => {
    const fixture = await vaultFixture();
    expect(
      () =>
        new LocalVaultCredentialProvider({
          filePath: fixture.filePath,
          allowedProjectId: baseContext.projectId,
          env: {},
        }),
    ).toThrow(/EYEBALL_VAULT_KEY.*32-byte/u);
    expect(
      () =>
        new LocalVaultCredentialProvider({
          filePath: fixture.filePath,
          allowedProjectId: baseContext.projectId,
          env: { EYEBALL_VAULT_KEY: Buffer.alloc(31).toString("base64") },
        }),
    ).toThrow(/EYEBALL_VAULT_KEY.*32-byte/u);
  });

  it("round-trips every auth class without plaintext secrets on disk", async () => {
    const fixture = await vaultFixture();
    const provider = new LocalVaultCredentialProvider({
      filePath: fixture.filePath,
      allowedProjectId: baseContext.projectId,
      env: fixture.env,
    });
    const secrets = {
      apiKey: "fixture:api-key-6af89573",
      username: "fixture:vault-user",
      password: "fixture:password-e8794ea7",
      parameter: "fixture:database-06389a9a",
      accessToken: "fixture:access-token-0d4ac921",
      refreshToken: "fixture:refresh-token-81df78e2",
      clientId: "fixture:client-a0c03451",
      clientSecret: "fixture:client-secret-c39db1ce",
    };

    await provider.put({
      userId: baseContext.userId,
      toolkitSlug: "stripe",
      credential: { type: "api_key", values: { apiKey: secrets.apiKey } },
    });
    await provider.put({
      userId: baseContext.userId,
      toolkitSlug: "odoo",
      credential: {
        type: "basic",
        username: secrets.username,
        password: secrets.password,
        parameters: { database: secrets.parameter },
      },
    });
    await provider.put({
      userId: baseContext.userId,
      toolkitSlug: "gmail",
      credential: {
        type: "oauth2",
        accessToken: secrets.accessToken,
        refreshToken: secrets.refreshToken,
        clientId: secrets.clientId,
        clientSecret: secrets.clientSecret,
        expiresAt: "2999-01-01T00:00:00.000Z",
        scopes: ["mail.read"],
        tokenType: "Bearer",
      },
    });
    await provider.put({
      userId: baseContext.userId,
      toolkitSlug: "voice-agents",
      credential: { type: "none" },
    });

    await expect(
      provider.resolve({ ...baseContext, toolkitSlug: "stripe" }),
    ).resolves.toEqual({
      type: "api_key",
      values: { apiKey: secrets.apiKey },
    });
    await expect(
      provider.resolve({ ...baseContext, toolkitSlug: "odoo" }),
    ).resolves.toEqual({
      type: "basic",
      username: secrets.username,
      password: secrets.password,
      parameters: { database: secrets.parameter },
    });
    await expect(provider.resolve(baseContext)).resolves.toEqual({
      type: "oauth2",
      accessToken: secrets.accessToken,
      expiresAt: "2999-01-01T00:00:00.000Z",
      scopes: ["mail.read"],
      tokenType: "Bearer",
    });
    await expect(
      provider.resolve({ ...baseContext, toolkitSlug: "voice-agents" }),
    ).resolves.toEqual({ type: "none" });

    const reopenedProvider = new LocalVaultCredentialProvider({
      filePath: fixture.filePath,
      allowedProjectId: baseContext.projectId,
      env: fixture.env,
    });
    await expect(reopenedProvider.resolve(baseContext)).resolves.toMatchObject({
      type: "oauth2",
      accessToken: secrets.accessToken,
    });

    const source = await readFile(fixture.filePath, "utf8");
    for (const secret of Object.values(secrets)) {
      expect(source).not.toContain(secret);
    }
    expect(JSON.parse(source)).toMatchObject({ version: 1 });
  });

  it("rejects authenticated ciphertext tampering", async () => {
    const fixture = await vaultFixture();
    const provider = new LocalVaultCredentialProvider({
      filePath: fixture.filePath,
      allowedProjectId: baseContext.projectId,
      env: fixture.env,
    });
    await provider.put({
      userId: baseContext.userId,
      toolkitSlug: "stripe",
      credential: {
        type: "api_key",
        values: { apiKey: "fixture:tamper-check" },
      },
    });

    const vault = JSON.parse(await readFile(fixture.filePath, "utf8")) as {
      records: Array<{ ciphertext: string }>;
    };
    const record = vault.records[0];
    const ciphertext = record?.ciphertext;
    expect(ciphertext).toBeTruthy();
    if (!record || !ciphertext) {
      throw new Error("Expected an encrypted vault record");
    }
    record.ciphertext = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
    await writeFile(fixture.filePath, JSON.stringify(vault), "utf8");

    const reopened = new LocalVaultCredentialProvider({
      filePath: fixture.filePath,
      allowedProjectId: baseContext.projectId,
      env: fixture.env,
    });
    await expect(
      reopened.resolve({ ...baseContext, toolkitSlug: "stripe" }),
    ).rejects.toThrow(/Unable to decrypt.*vault file integrity/u);
  });

  it("derives a fresh authenticated nonce after remove and recreate", async () => {
    const fixture = await vaultFixture();
    const provider = new LocalVaultCredentialProvider({
      filePath: fixture.filePath,
      allowedProjectId: baseContext.projectId,
      env: fixture.env,
    });
    const input = {
      userId: baseContext.userId,
      toolkitSlug: "stripe" as const,
      credential: {
        type: "api_key" as const,
        values: { apiKey: "same-secret" },
      },
    };

    await provider.put(input);
    const first = JSON.parse(await readFile(fixture.filePath, "utf8")) as {
      records: Array<{
        revision: number;
        nonceSeed: string;
        ciphertext: string;
      }>;
    };
    await provider.remove(input);
    await provider.put(input);
    const second = JSON.parse(await readFile(fixture.filePath, "utf8")) as {
      records: Array<{
        revision: number;
        nonceSeed: string;
        ciphertext: string;
      }>;
    };

    expect(first.records[0]?.revision).toBe(1);
    expect(second.records[0]?.revision).toBe(1);
    expect(second.records[0]?.nonceSeed).not.toBe(first.records[0]?.nonceSeed);
    expect(second.records[0]?.ciphertext).not.toBe(
      first.records[0]?.ciphertext,
    );
  });

  it("maps refresh rejection to auth_expired with a reconnect command", async () => {
    const fixture = await vaultFixture();
    const provider = new LocalVaultCredentialProvider({
      filePath: fixture.filePath,
      allowedProjectId: baseContext.projectId,
      env: fixture.env,
      oauth: { gmail: { tokenUrl: "https://oauth.example.test/token" } },
      fetchImpl: vi.fn(async () =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      ),
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    await provider.put({
      userId: baseContext.userId,
      toolkitSlug: "gmail",
      credential: {
        type: "oauth2",
        accessToken: "expired-access",
        refreshToken: "expired-refresh",
        clientId: "client-id",
        clientSecret: "client-secret",
        expiresAt: "2026-07-17T11:00:00.000Z",
      },
    });

    let thrown: unknown;
    try {
      await provider.resolve(baseContext);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CredentialProviderError);
    expect(thrown).toMatchObject({ code: "auth_expired", retryable: false });
    expect((thrown as Error).message).toContain(
      "pnpm eyeball-auth add gmail --user user-local",
    );
    expect((thrown as Error).message).not.toContain("invalid_grant");
  });

  it.each([
    [
      "HTTP 503",
      vi.fn(async () => Response.json({ error: "down" }, { status: 503 })),
    ],
    [
      "network failure",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    ],
  ])("maps transient refresh %s to retryable provider_unavailable", async (_label, fetchImpl) => {
    const fixture = await vaultFixture();
    const provider = new LocalVaultCredentialProvider({
      filePath: fixture.filePath,
      allowedProjectId: baseContext.projectId,
      env: fixture.env,
      oauth: { gmail: { tokenUrl: "https://oauth.example.test/token" } },
      fetchImpl,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    await provider.put({
      userId: baseContext.userId,
      toolkitSlug: "gmail",
      credential: {
        type: "oauth2",
        accessToken: "expired-access",
        refreshToken: "refresh-still-valid",
        clientId: "client-id",
        clientSecret: "client-secret",
        expiresAt: "2026-07-17T11:00:00.000Z",
      },
    });

    await expect(provider.resolve(baseContext)).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("refuses to post OAuth secrets over non-loopback HTTP", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ access_token: "unused" }),
    );

    await expect(
      requestOAuthToken({
        endpoint: { tokenUrl: "http://oauth.example.test/token" },
        clientId: "client-id",
        clientSecret: "client-secret",
        parameters: { refresh_token: "refresh-secret" },
        fetchImpl,
      }),
    ).rejects.toThrow("must use HTTPS");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("deduplicates simultaneous refreshes and persists rotated tokens", async () => {
    const fixture = await vaultFixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        const parameters = new URLSearchParams(String(init?.body ?? ""));
        expect(parameters.get("grant_type")).toBe("refresh_token");
        expect(parameters.get("refresh_token")).toBe("stale-refresh");
        expect(parameters.get("redirect_uri")).toBeNull();
        await gate;
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "mail.read mail.send",
        });
      },
    );
    const provider = new LocalVaultCredentialProvider({
      filePath: fixture.filePath,
      allowedProjectId: baseContext.projectId,
      env: fixture.env,
      oauth: { gmail: { tokenUrl: "https://oauth.example.test/token" } },
      fetchImpl,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    await provider.put({
      userId: baseContext.userId,
      toolkitSlug: "gmail",
      credential: {
        type: "oauth2",
        accessToken: "stale-access",
        refreshToken: "stale-refresh",
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1/callback",
        expiresAt: "2026-07-17T11:00:00.000Z",
      },
    });

    const first = provider.resolve(baseContext);
    const second = provider.resolve(baseContext);
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        type: "oauth2",
        accessToken: "rotated-access",
        refreshToken: undefined,
        tokenType: "Bearer",
        scopes: ["mail.read", "mail.send"],
        expiresAt: "2026-07-17T13:00:00.000Z",
      },
      {
        type: "oauth2",
        accessToken: "rotated-access",
        refreshToken: undefined,
        tokenType: "Bearer",
        scopes: ["mail.read", "mail.send"],
        expiresAt: "2026-07-17T13:00:00.000Z",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const source = await readFile(fixture.filePath, "utf8");
    expect(source).not.toContain("rotated-access");
    expect(source).not.toContain("rotated-refresh");
    await expect(provider.resolve(baseContext)).resolves.toMatchObject({
      accessToken: "rotated-access",
    });
  });

  it("enforces project scope and unambiguous connection selection", async () => {
    const fixture = await vaultFixture();
    const provider = new LocalVaultCredentialProvider({
      filePath: fixture.filePath,
      allowedProjectId: baseContext.projectId,
      env: fixture.env,
    });
    await provider.put({
      userId: baseContext.userId,
      toolkitSlug: "stripe",
      connectionId: "conn_primary",
      credential: { type: "api_key", values: { apiKey: "first" } },
    });
    await provider.put({
      userId: baseContext.userId,
      toolkitSlug: "stripe",
      connectionId: "conn_secondary",
      credential: { type: "api_key", values: { apiKey: "second" } },
    });
    await expect(
      provider.resolve({
        ...baseContext,
        toolkitSlug: "stripe",
        connectionId: "conn_secondary",
      }),
    ).resolves.toMatchObject({
      connectionId: "conn_secondary",
      values: { apiKey: "second" },
    });
    await expect(
      provider.resolve({ ...baseContext, toolkitSlug: "stripe" }),
    ).rejects.toMatchObject({ code: "auth_missing" });
    await expect(
      provider.resolve({
        ...baseContext,
        projectId: "another-project",
        toolkitSlug: "stripe",
      }),
    ).rejects.toMatchObject({ code: "auth_missing" });
  });
});
