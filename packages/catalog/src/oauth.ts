import type {
  OAuthClientAuthentication,
  OAuthTokenEndpointConfig,
  OAuthTokenRequestEncoding,
  ToolkitSlug,
} from "@eyeball/core";
import { deepFreeze } from "./immutable.js";

export type OAuthEndpointVerification = "grounded" | "todo-verify";
export type OAuthPkceMethod = "S256";
export type OAuthCallbackValidation = "shopify-hmac-sha256";

export interface OAuthEndpointVariable {
  placeholder: string;
  env: string;
  description: string;
}

export interface ToolkitOAuthConfig {
  toolkitSlug: ToolkitSlug;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  scopeSeparator?: "space" | "comma";
  authorizeParameters?: Readonly<Record<string, string>>;
  clientAuthentication?: OAuthClientAuthentication;
  tokenRequestEncoding?: OAuthTokenRequestEncoding;
  refreshParameters?: Readonly<Record<string, string>>;
  pkce?: OAuthPkceMethod;
  authorizationCodeParameters?: Readonly<Record<string, string>>;
  authorizationCodeIncludesGrantType?: boolean;
  authorizationCodeIncludesRedirectUri?: boolean;
  callbackValidation?: OAuthCallbackValidation;
  endpointVariables?: readonly OAuthEndpointVariable[];
  endpointVerification: OAuthEndpointVerification;
  documentationUrl: string;
  verificationNote: string;
}

export interface ResolvedToolkitOAuthConfig {
  toolkitSlug: ToolkitSlug;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  scopeSeparator: "space" | "comma";
  authorizeParameters: Readonly<Record<string, string>>;
  tokenEndpoint: OAuthTokenEndpointConfig;
  pkce?: OAuthPkceMethod;
  authorizationCodeParameters: Readonly<Record<string, string>>;
  authorizationCodeIncludesGrantType: boolean;
  authorizationCodeIncludesRedirectUri: boolean;
  callbackValidation?: OAuthCallbackValidation;
  endpointVerification: OAuthEndpointVerification;
  documentationUrl: string;
  verificationNote: string;
  clientIdEnv: string;
  clientSecretEnv: string;
}

const GOOGLE_DOCUMENTATION =
  "https://developers.google.com/identity/protocols/oauth2/web-server";

function googleConfig(
  toolkitSlug: ToolkitSlug,
  scopes: readonly string[],
): ToolkitOAuthConfig {
  return {
    toolkitSlug,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes,
    authorizeParameters: {
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
    },
    endpointVerification: "grounded",
    documentationUrl: GOOGLE_DOCUMENTATION,
    verificationNote:
      "Official Google OAuth 2.0 web-server endpoints, verified 2026-07-17.",
  };
}

export const oauthToolkitConfigs = deepFreeze({
  airtable: {
    toolkitSlug: "airtable",
    authorizeUrl: "https://airtable.com/oauth2/v1/authorize",
    tokenUrl: "https://airtable.com/oauth2/v1/token",
    scopes: ["data.records:read", "data.records:write"],
    clientAuthentication: "basic",
    pkce: "S256",
    endpointVerification: "todo-verify",
    documentationUrl: "https://airtable.com/developers/web/api/oauth-reference",
    verificationNote:
      "TODO-verify before production: Airtable's official OAuth reference is client-rendered and could not be independently captured in the no-egress test environment; the published OAuth example requires these tenant-independent endpoints and PKCE S256.",
  },
  github: {
    toolkitSlug: "github",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo"],
    endpointVerification: "grounded",
    documentationUrl:
      "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps",
    verificationNote:
      "Official GitHub OAuth app endpoints, verified 2026-07-17.",
  },
  gmail: googleConfig("gmail", [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
  ]),
  "google-calendar": googleConfig("google-calendar", [
    "https://www.googleapis.com/auth/calendar",
  ]),
  "google-drive": googleConfig("google-drive", [
    "https://www.googleapis.com/auth/drive",
  ]),
  "google-sheets": googleConfig("google-sheets", [
    "https://www.googleapis.com/auth/spreadsheets",
  ]),
  "microsoft-outlook": {
    toolkitSlug: "microsoft-outlook",
    authorizeUrl:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: [
      "offline_access",
      "https://graph.microsoft.com/Mail.Read",
      "https://graph.microsoft.com/Mail.ReadWrite",
      "https://graph.microsoft.com/Mail.Send",
    ],
    endpointVerification: "grounded",
    documentationUrl:
      "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow",
    verificationNote:
      "Official Microsoft identity-platform v2 common-authority endpoints, verified 2026-07-17.",
  },
  slack: {
    toolkitSlug: "slack",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: [
      "channels:history",
      "channels:manage",
      "channels:read",
      "chat:write",
      "groups:history",
      "groups:read",
      "im:history",
      "im:read",
      "mpim:history",
      "mpim:read",
      "reactions:write",
      "users:read",
      "users:read.email",
    ],
    scopeSeparator: "comma",
    endpointVerification: "grounded",
    documentationUrl: "https://api.slack.com/authentication/oauth-v2",
    verificationNote: "Official Slack OAuth v2 endpoints, verified 2026-07-17.",
  },
  hubspot: {
    toolkitSlug: "hubspot",
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubspot.com/oauth/2026-03/token",
    scopes: [
      "oauth",
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "crm.objects.companies.read",
      "crm.objects.companies.write",
      "crm.objects.deals.read",
      "crm.objects.deals.write",
    ],
    endpointVerification: "grounded",
    documentationUrl:
      "https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens",
    verificationNote:
      "Official HubSpot authorization and current date-versioned token endpoints, verified 2026-07-17.",
  },
  linear: {
    toolkitSlug: "linear",
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: ["read", "write"],
    scopeSeparator: "comma",
    endpointVerification: "grounded",
    documentationUrl: "https://linear.app/developers/oauth-2-0-authentication",
    verificationNote:
      "Official Linear OAuth endpoints and rotating refresh-token flow, verified 2026-07-17.",
  },
  quickbooks: {
    toolkitSlug: "quickbooks",
    authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    scopes: ["com.intuit.quickbooks.accounting"],
    clientAuthentication: "basic",
    endpointVerification: "grounded",
    documentationUrl:
      "https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0",
    verificationNote:
      "Official Intuit OAuth 2.0 endpoints, verified 2026-07-17.",
  },
  notion: {
    toolkitSlug: "notion",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    authorizeParameters: { owner: "user" },
    clientAuthentication: "basic",
    tokenRequestEncoding: "json",
    endpointVerification: "grounded",
    documentationUrl:
      "https://developers.notion.com/guides/get-started/authorization",
    verificationNote:
      "Official Notion public-connection endpoints and rotating refresh-token flow, verified 2026-07-17.",
  },
  shopify: {
    toolkitSlug: "shopify",
    authorizeUrl: "https://{shop}.myshopify.com/admin/oauth/authorize",
    tokenUrl: "https://{shop}.myshopify.com/admin/oauth/access_token",
    scopes: [
      "write_products",
      "write_inventory",
      "write_orders",
      "write_fulfillments",
      "read_customers",
    ],
    scopeSeparator: "comma",
    authorizationCodeParameters: { expiring: "1" },
    authorizationCodeIncludesGrantType: false,
    authorizationCodeIncludesRedirectUri: false,
    callbackValidation: "shopify-hmac-sha256",
    endpointVariables: [
      {
        placeholder: "shop",
        env: "EYEBALL_OAUTH_SHOPIFY_SHOP",
        description: "Shopify shop subdomain",
      },
    ],
    endpointVerification: "grounded",
    documentationUrl:
      "https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant",
    verificationNote:
      "Official tenant-scoped Shopify authorization/token endpoints, expiring offline tokens, and callback HMAC validation, verified 2026-07-17.",
  },
  zendesk: {
    toolkitSlug: "zendesk",
    authorizeUrl: "https://{subdomain}.zendesk.com/oauth/authorizations/new",
    tokenUrl: "https://{subdomain}.zendesk.com/oauth/tokens",
    scopes: ["read", "write"],
    tokenRequestEncoding: "json",
    endpointVariables: [
      {
        placeholder: "subdomain",
        env: "EYEBALL_OAUTH_ZENDESK_SUBDOMAIN",
        description: "Zendesk account subdomain",
      },
    ],
    endpointVerification: "grounded",
    documentationUrl:
      "https://developer.zendesk.com/documentation/api-basics/authentication/api-tokens-to-oauth/",
    verificationNote:
      "Official tenant-scoped Zendesk authorization/token endpoints, verified 2026-07-17.",
  },
} as const satisfies Readonly<Record<string, ToolkitOAuthConfig>>);

export function oauthClientEnvPrefix(toolkitSlug: ToolkitSlug): string {
  return `EYEBALL_OAUTH_${toolkitSlug.toUpperCase().replaceAll("-", "_")}_`;
}

function replaceEndpointVariables(
  template: string,
  variables: readonly OAuthEndpointVariable[],
  env: Readonly<Record<string, string | undefined>>,
): string {
  let result = template;
  for (const variable of variables) {
    const value = env[variable.env]?.trim();
    if (value === undefined || value.length === 0) {
      throw new Error(
        `${variable.env} is required for ${variable.description}.`,
      );
    }
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(value)) {
      throw new Error(
        `${variable.env} is not a valid ${variable.description}.`,
      );
    }
    result = result.replaceAll(`{${variable.placeholder}}`, value);
  }
  return result;
}

function assertEndpoint(
  value: string,
  toolkitSlug: string,
  kind: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`The ${toolkitSlug} OAuth ${kind} endpoint is invalid.`, {
      cause: error,
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `The ${toolkitSlug} OAuth ${kind} endpoint must use HTTP or HTTPS.`,
    );
  }
  return url.toString();
}

export function getToolkitOAuthConfig(
  toolkitSlug: ToolkitSlug,
): ToolkitOAuthConfig | undefined {
  return (oauthToolkitConfigs as Readonly<Record<string, ToolkitOAuthConfig>>)[
    toolkitSlug
  ];
}

export function resolveToolkitOAuthConfig(
  toolkitSlug: ToolkitSlug,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedToolkitOAuthConfig | undefined {
  const config = getToolkitOAuthConfig(toolkitSlug);
  if (config === undefined) {
    return undefined;
  }
  const variables = config.endpointVariables ?? [];
  const authorizeUrl = assertEndpoint(
    replaceEndpointVariables(config.authorizeUrl, variables, env),
    toolkitSlug,
    "authorization",
  );
  const tokenUrl = assertEndpoint(
    replaceEndpointVariables(config.tokenUrl, variables, env),
    toolkitSlug,
    "token",
  );
  const prefix = oauthClientEnvPrefix(toolkitSlug);
  return {
    toolkitSlug,
    authorizeUrl,
    tokenUrl,
    scopes: [...config.scopes],
    scopeSeparator: config.scopeSeparator ?? "space",
    authorizeParameters: { ...config.authorizeParameters },
    tokenEndpoint: {
      tokenUrl,
      ...(config.clientAuthentication === undefined
        ? {}
        : { clientAuthentication: config.clientAuthentication }),
      ...(config.tokenRequestEncoding === undefined
        ? {}
        : { requestEncoding: config.tokenRequestEncoding }),
      ...(config.refreshParameters === undefined
        ? {}
        : { refreshParameters: { ...config.refreshParameters } }),
    },
    ...(config.pkce === undefined ? {} : { pkce: config.pkce }),
    authorizationCodeParameters: { ...config.authorizationCodeParameters },
    authorizationCodeIncludesGrantType:
      config.authorizationCodeIncludesGrantType ?? true,
    authorizationCodeIncludesRedirectUri:
      config.authorizationCodeIncludesRedirectUri ?? true,
    ...(config.callbackValidation === undefined
      ? {}
      : { callbackValidation: config.callbackValidation }),
    endpointVerification: config.endpointVerification,
    documentationUrl: config.documentationUrl,
    verificationNote: config.verificationNote,
    clientIdEnv: `${prefix}CLIENT_ID`,
    clientSecretEnv: `${prefix}CLIENT_SECRET`,
  };
}

export function resolvedOAuthTokenEndpoints(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<ToolkitSlug, OAuthTokenEndpointConfig>> {
  return Object.fromEntries(
    Object.keys(oauthToolkitConfigs).flatMap((toolkitSlug) => {
      try {
        const resolved = resolveToolkitOAuthConfig(
          toolkitSlug as ToolkitSlug,
          env,
        );
        return resolved === undefined
          ? []
          : [[toolkitSlug, resolved.tokenEndpoint] as const];
      } catch {
        return [];
      }
    }),
  );
}
