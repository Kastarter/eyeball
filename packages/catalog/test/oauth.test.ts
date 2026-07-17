import { describe, expect, it } from "vitest";
import {
  defaultCatalog,
  getToolkitOAuthConfig,
  oauthClientEnvPrefix,
  oauthToolkitConfigs,
  resolveToolkitOAuthConfig,
} from "../src/index.js";

describe("OAuth toolkit configuration", () => {
  it("covers every shipped OAuth toolkit", () => {
    const oauthToolkits = defaultCatalog
      .listManifests()
      .filter((manifest) => manifest.auth.class === "oauth2")
      .map((manifest) => manifest.toolkit.slug)
      .sort();

    expect(Object.keys(oauthToolkitConfigs).sort()).toEqual(oauthToolkits);
  });

  it.each([
    [
      "github",
      "https://github.com/login/oauth/authorize",
      "https://github.com/login/oauth/access_token",
    ],
    [
      "gmail",
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://oauth2.googleapis.com/token",
    ],
    [
      "google-calendar",
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://oauth2.googleapis.com/token",
    ],
    [
      "google-drive",
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://oauth2.googleapis.com/token",
    ],
    [
      "google-sheets",
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://oauth2.googleapis.com/token",
    ],
    [
      "linear",
      "https://linear.app/oauth/authorize",
      "https://api.linear.app/oauth/token",
    ],
    [
      "microsoft-outlook",
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    ],
    [
      "notion",
      "https://api.notion.com/v1/oauth/authorize",
      "https://api.notion.com/v1/oauth/token",
    ],
    [
      "slack",
      "https://slack.com/oauth/v2/authorize",
      "https://slack.com/api/oauth.v2.access",
    ],
    [
      "hubspot",
      "https://app.hubspot.com/oauth/authorize",
      "https://api.hubspot.com/oauth/2026-03/token",
    ],
    [
      "quickbooks",
      "https://appcenter.intuit.com/connect/oauth2",
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    ],
  ] as const)("resolves grounded %s endpoints", (slug, authorizeUrl, tokenUrl) => {
    const config = resolveToolkitOAuthConfig(slug, {});
    expect(config).toMatchObject({
      authorizeUrl,
      tokenUrl,
      endpointVerification: "grounded",
    });
    expect(config?.documentationUrl).toMatch(/^https:\/\//u);
  });

  it("resolves tenant-scoped Zendesk endpoints without accepting URL injection", () => {
    expect(
      resolveToolkitOAuthConfig("zendesk", {
        EYEBALL_OAUTH_ZENDESK_SUBDOMAIN: "acme-support",
      }),
    ).toMatchObject({
      authorizeUrl: "https://acme-support.zendesk.com/oauth/authorizations/new",
      tokenUrl: "https://acme-support.zendesk.com/oauth/tokens",
      endpointVerification: "grounded",
      tokenEndpoint: { requestEncoding: "json" },
    });
    expect(() =>
      resolveToolkitOAuthConfig("zendesk", {
        EYEBALL_OAUTH_ZENDESK_SUBDOMAIN: "evil.example/path",
      }),
    ).toThrow("not a valid Zendesk account subdomain");
  });

  it("resolves Shopify's tenant endpoints and non-standard code exchange", () => {
    expect(
      resolveToolkitOAuthConfig("shopify", {
        EYEBALL_OAUTH_SHOPIFY_SHOP: "acme-store",
      }),
    ).toMatchObject({
      authorizeUrl: "https://acme-store.myshopify.com/admin/oauth/authorize",
      tokenUrl: "https://acme-store.myshopify.com/admin/oauth/access_token",
      scopeSeparator: "comma",
      endpointVerification: "grounded",
      authorizationCodeParameters: { expiring: "1" },
      authorizationCodeIncludesGrantType: false,
      authorizationCodeIncludesRedirectUri: false,
      callbackValidation: "shopify-hmac-sha256",
    });
    expect(() =>
      resolveToolkitOAuthConfig("shopify", {
        EYEBALL_OAUTH_SHOPIFY_SHOP: "evil.example/path",
      }),
    ).toThrow("not a valid Shopify shop subdomain");
  });

  it("keeps Airtable's PKCE metadata explicitly TODO-verify", () => {
    expect(resolveToolkitOAuthConfig("airtable", {})).toMatchObject({
      authorizeUrl: "https://airtable.com/oauth2/v1/authorize",
      tokenUrl: "https://airtable.com/oauth2/v1/token",
      pkce: "S256",
      endpointVerification: "todo-verify",
      tokenEndpoint: { clientAuthentication: "basic" },
    });
  });

  it("uses convention-named OAuth app credential variables", () => {
    expect(oauthClientEnvPrefix("microsoft-outlook")).toBe(
      "EYEBALL_OAUTH_MICROSOFT_OUTLOOK_",
    );
    expect(resolveToolkitOAuthConfig("slack", {})).toMatchObject({
      clientIdEnv: "EYEBALL_OAUTH_SLACK_CLIENT_ID",
      clientSecretEnv: "EYEBALL_OAUTH_SLACK_CLIENT_SECRET",
      scopeSeparator: "comma",
      authorizationCodeIncludesGrantType: true,
      authorizationCodeIncludesRedirectUri: true,
    });
  });

  it("keeps every endpoint status and primary-source link explicit", () => {
    for (const config of Object.values(oauthToolkitConfigs)) {
      expect(["grounded", "todo-verify"]).toContain(
        config.endpointVerification,
      );
      expect(config.documentationUrl).toMatch(/^https:\/\//u);
      expect(config.verificationNote.length).toBeGreaterThan(20);
    }
    expect(getToolkitOAuthConfig("github")).toBeDefined();
  });
});
