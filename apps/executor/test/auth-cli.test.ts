import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMockClock,
  createOAuthSimulation,
} from "../../../mocks/packages/mock-kit/dist/index.js";
import { LocalVaultCredentialProvider } from "../../../packages/core/src/index.js";
import { runAuthCli } from "../../../scripts/eyeball-auth.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("eyeball-auth CLI", () => {
  it("initializes and connects OAuth through the mock simulation, then auto-refreshes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eyeball-auth-cli-"));
    directories.push(directory);
    const filePath = join(directory, "vault.json");
    const output: string[] = [];
    const clock = createMockClock("2026-07-17T12:00:00.000Z");
    const redirectUri = "http://127.0.0.1:53682/callback";
    const clientId = "mock-oauth-client";
    const clientSecret = "mock-oauth-client-secret";
    let codeChallenge: string | undefined;
    let sawCodeVerifier = false;
    const oauth = createOAuthSimulation({
      slug: "gmail",
      clock,
      accessTokenExpiresInMs: 2_000,
      clients: [
        {
          clientId,
          clientSecret,
          redirectUris: [redirectUri],
          scopes: ["mail.read", "mail.send"],
        },
      ],
    });
    const fetchImpl = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        if (!request.url.startsWith("https://oauth.mock.test/")) {
          throw new Error(`Unexpected URL: ${request.url}`);
        }
        if (request.url.endsWith("/token") && init?.body !== undefined) {
          const body = new URLSearchParams(String(init.body));
          if (body.get("grant_type") === "authorization_code") {
            const codeVerifier = body.get("code_verifier");
            expect(codeVerifier).toBeTruthy();
            expect(
              createHash("sha256")
                .update(codeVerifier ?? "")
                .digest("base64url"),
            ).toBe(codeChallenge);
            sawCodeVerifier = true;
          }
        }
        return oauth.app.fetch(request);
      },
    ) as typeof fetch;
    const oauthConfig = {
      toolkitSlug: "gmail",
      authorizeUrl: "https://oauth.mock.test/authorize",
      tokenUrl: "https://oauth.mock.test/token",
      scopes: ["mail.read", "mail.send"],
      scopeSeparator: "space" as const,
      authorizeParameters: {},
      tokenEndpoint: { tokenUrl: "https://oauth.mock.test/token" },
      pkce: "S256" as const,
      authorizationCodeParameters: {},
      authorizationCodeIncludesGrantType: true,
      authorizationCodeIncludesRedirectUri: true,
      endpointVerification: "grounded" as const,
      documentationUrl: "https://oauth.mock.test/docs",
      verificationNote: "Mock integration target.",
      clientIdEnv: "EYEBALL_OAUTH_GMAIL_CLIENT_ID",
      clientSecretEnv: "EYEBALL_OAUTH_GMAIL_CLIENT_SECRET",
    };

    await runAuthCli(["init", "--vault", filePath], {
      cwd: directory,
      env: {},
      write: (value) => output.push(value),
    });
    const key = output.join("").match(/EYEBALL_VAULT_KEY='(?<key>[^']+)'/u)
      ?.groups?.key;
    expect(key).toBeTruthy();
    const env = {
      EYEBALL_VAULT_KEY: key,
      EYEBALL_VAULT_PATH: filePath,
      EYEBALL_PROJECT_ID: "project-local",
    };

    await runAuthCli(
      [
        "add",
        "gmail",
        "--user",
        "user-local",
        "--client-id",
        clientId,
        "--client-secret",
        clientSecret,
        "--redirect-uri",
        redirectUri,
        "--manual",
        "--vault",
        filePath,
      ],
      {
        cwd: directory,
        env,
        fetchImpl,
        now: clock.now,
        write: (value) => output.push(value),
        resolveOAuthConfig: () => oauthConfig,
        prompt: async (question) => {
          expect(question).toBe("Paste the complete redirect URL: ");
          const authorizeUrl = output
            .flatMap((value) => value.split("\n"))
            .find((value) => value.startsWith(oauthConfig.authorizeUrl));
          if (authorizeUrl === undefined) {
            throw new Error("CLI output omitted the mock authorization URL.");
          }
          const parsedAuthorizeUrl = new URL(authorizeUrl);
          codeChallenge =
            parsedAuthorizeUrl.searchParams.get("code_challenge") ?? undefined;
          expect(codeChallenge).toBeTruthy();
          expect(
            parsedAuthorizeUrl.searchParams.get("code_challenge_method"),
          ).toBe("S256");
          const response = await oauth.app.request(authorizeUrl);
          expect(response.status).toBe(302);
          const location = response.headers.get("location");
          if (location === null) {
            throw new Error("Mock OAuth authorization omitted Location.");
          }
          return location;
        },
      },
    );

    const firstAccessToken = "access_gmail_000001";
    const firstRefreshToken = "refresh_gmail_000001";
    const source = await readFile(filePath, "utf8");
    for (const secret of [
      firstAccessToken,
      firstRefreshToken,
      clientId,
      clientSecret,
    ]) {
      expect(source).not.toContain(secret);
    }

    const provider = new LocalVaultCredentialProvider({
      filePath,
      allowedProjectId: "project-local",
      env,
      oauth: { gmail: oauthConfig.tokenEndpoint },
      fetchImpl,
      now: clock.now,
    });
    const context = {
      projectId: "project-local",
      userId: "user-local",
      toolkitSlug: "gmail",
    } as const;
    await expect(provider.resolve(context)).resolves.toMatchObject({
      type: "oauth2",
      accessToken: firstAccessToken,
    });

    clock.advance(2_001);
    await expect(provider.resolve(context)).resolves.toMatchObject({
      type: "oauth2",
      accessToken: "access_gmail_000002",
    });
    clock.advance(2_001);
    await expect(provider.resolve(context)).resolves.toMatchObject({
      type: "oauth2",
      accessToken: "access_gmail_000003",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sawCodeVerifier).toBe(true);
    expect(await readFile(filePath, "utf8")).not.toContain(
      "refresh_gmail_000003",
    );
  });

  it("validates Shopify callback HMAC and uses its non-standard code exchange", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eyeball-auth-shopify-"));
    directories.push(directory);
    const filePath = join(directory, "vault.json");
    const output: string[] = [];
    const clientId = "shopify-client-id";
    const clientSecret = "shopify-client-secret";
    const shop = "eyeball-test.myshopify.com";
    const config = {
      toolkitSlug: "shopify",
      authorizeUrl: `https://${shop}/admin/oauth/authorize`,
      tokenUrl: `https://${shop}/admin/oauth/access_token`,
      scopes: ["write_products"],
      scopeSeparator: "comma" as const,
      authorizeParameters: {},
      tokenEndpoint: {
        tokenUrl: `https://${shop}/admin/oauth/access_token`,
      },
      authorizationCodeParameters: { expiring: "1" },
      authorizationCodeIncludesGrantType: false,
      authorizationCodeIncludesRedirectUri: false,
      callbackValidation: "shopify-hmac-sha256" as const,
      endpointVerification: "grounded" as const,
      documentationUrl:
        "https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant",
      verificationNote: "Mocked Shopify callback-validation target.",
      clientIdEnv: "EYEBALL_OAUTH_SHOPIFY_CLIENT_ID",
      clientSecretEnv: "EYEBALL_OAUTH_SHOPIFY_CLIENT_SECRET",
    };

    await runAuthCli(["init", "--vault", filePath], {
      cwd: directory,
      env: {},
      write: (value) => output.push(value),
    });
    const key = output.join("").match(/EYEBALL_VAULT_KEY='(?<key>[^']+)'/u)
      ?.groups?.key;
    expect(key).toBeTruthy();
    const env = { EYEBALL_VAULT_KEY: key, EYEBALL_VAULT_PATH: filePath };
    const callback = (state: string, valid: boolean): string => {
      const redirect = new URL("http://127.0.0.1:53682/callback");
      redirect.searchParams.set("code", "shopify-code");
      redirect.searchParams.set("shop", shop);
      redirect.searchParams.set("state", state);
      redirect.searchParams.set("timestamp", "1784293200");
      const message = [...redirect.searchParams.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left === right ? 0 : 1))
        .map(([name, value]) => `${name}=${value}`)
        .join("&");
      redirect.searchParams.set(
        "hmac",
        valid
          ? createHmac("sha256", clientSecret).update(message).digest("hex")
          : "0".repeat(64),
      );
      return redirect.toString();
    };
    const args = [
      "add",
      "shopify",
      "--user",
      "user-local",
      "--client-id",
      clientId,
      "--client-secret",
      clientSecret,
      "--vault",
      filePath,
    ] as const;

    await expect(
      runAuthCli(args, {
        cwd: directory,
        env,
        write: (value) => output.push(value),
        resolveOAuthConfig: () => config,
        captureRedirect: async ({ state }) => callback(state, false),
      }),
    ).rejects.toThrow("Shopify OAuth callback HMAC verification failed");

    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body));
        expect(Object.fromEntries(body)).toEqual({
          expiring: "1",
          code: "shopify-code",
          client_id: clientId,
          client_secret: clientSecret,
        });
        return Response.json({
          access_token: "shopify-access-token",
          refresh_token: "shopify-refresh-token",
          expires_in: 3_600,
          scope: "write_products",
        });
      },
    ) as typeof fetch;
    await runAuthCli(args, {
      cwd: directory,
      env,
      fetchImpl,
      write: (value) => output.push(value),
      resolveOAuthConfig: () => config,
      captureRedirect: async ({ state }) => callback(state, true),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const source = await readFile(filePath, "utf8");
    for (const secret of [
      clientId,
      clientSecret,
      "shopify-access-token",
      "shopify-refresh-token",
    ]) {
      expect(source).not.toContain(secret);
    }
  });
});
