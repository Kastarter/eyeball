import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { safeDashboardNextPath } from "../components/auth/auth-screen";
import { confirmApiKeyRevocation } from "../components/cloud/api-keys-screen";
import { SecretRevealDialog } from "../components/cloud/secret-reveal-dialog";
import {
  cloudConnectionRequest,
  confirmCloudConnectionRevocation,
  HostedConnectLinkDialog,
} from "../components/connections/cloud-connections-screen";
import type { CatalogToolkitSummary } from "./catalog";
import {
  type CloudApiKey,
  CloudClient,
  type CloudConnection,
  type CloudOrganization,
  type CloudProject,
} from "./cloud-api";

const CSRF_TOKEN = "csrf_fixture_token";
const FULL_PROJECT_KEY = "eyb_live_reveal_once_fixture_key";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

class FakeCloudControlPlane {
  readonly organizations: CloudOrganization[] = [];
  readonly projects: CloudProject[] = [];
  readonly apiKeys: CloudApiKey[] = [];
  readonly connections: CloudConnection[] = [];
  readonly requests: { headers: Headers; method: string; path: string }[] = [];

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/cloud/u, "");
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    this.requests.push({ headers, method, path });
    const value =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (method !== "GET") {
      expect(headers.get("X-CSRF-Token")).toBe(CSRF_TOKEN);
    }

    if (path === "/v1/auth/login" && method === "POST") {
      expect(value).toEqual({
        email: "operator@example.test",
        password: "correct horse battery staple",
      });
      return json({
        csrfToken: CSRF_TOKEN,
        user: { id: "usr_operator", email: "operator@example.test" },
      });
    }
    if (path === "/v1/orgs" && method === "POST") {
      const organization: CloudOrganization = {
        id: "org_fixture",
        name: value.name,
        slug: value.slug,
        role: "owner",
        oauthRedirectOrigins: [],
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
      };
      this.organizations.push(organization);
      const { role, ...storedOrganization } = organization;
      return json({ organization: storedOrganization, role }, 201);
    }
    if (path === "/v1/orgs" && method === "GET") {
      return json({ organizations: this.organizations });
    }
    if (path === "/v1/orgs/org_fixture/billing" && method === "GET") {
      return json({
        billing: {
          plan: { key: "pro", name: "Pro", version: 1 },
          status: "active",
          hasPaymentPortal: true,
        },
      });
    }
    if (path === "/v1/orgs/org_fixture/projects" && method === "POST") {
      const project: CloudProject = {
        id: "proj_fixture",
        organizationId: "org_fixture",
        name: value.name,
        slug: value.slug,
        environment: value.environment,
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
      };
      this.projects.push(project);
      return json({ project }, 201);
    }
    if (path === "/v1/projects/proj_fixture/api-keys" && method === "POST") {
      const apiKey: CloudApiKey = {
        id: "key_fixture",
        projectId: "proj_fixture",
        name: value.name,
        prefix: "eyb_live_fixture",
        pinnedUserId: value.pinnedUserId ?? null,
        createdByUserId: "usr_operator",
        createdAt: "2026-07-19T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      };
      this.apiKeys.push(apiKey);
      return json({ apiKey, key: FULL_PROJECT_KEY }, 201);
    }
    if (path === "/v1/projects/proj_fixture/api-keys" && method === "GET") {
      return json({ apiKeys: this.apiKeys });
    }
    const apiKeyMatch = path.match(
      /^\/v1\/projects\/proj_fixture\/api-keys\/(key_[A-Za-z0-9_-]+)$/u,
    );
    if (apiKeyMatch !== null && method === "DELETE") {
      const apiKey = this.apiKeys.find(({ id }) => id === apiKeyMatch[1]);
      if (apiKey === undefined) return json({ error: "missing" }, 404);
      const revoked: CloudApiKey = {
        ...apiKey,
        revokedAt: "2026-07-19T00:01:00.000Z",
      };
      this.apiKeys.splice(this.apiKeys.indexOf(apiKey), 1, revoked);
      return json({ apiKey: revoked });
    }
    if (path === "/v1/projects/proj_fixture/connections" && method === "POST") {
      const connection: CloudConnection = {
        id: `conn_${this.connections.length + 1}`,
        organizationId: "org_fixture",
        projectId: "proj_fixture",
        externalUserId: value.externalUserId,
        toolkit: value.toolkit,
        authType: value.authType,
        status: value.authType === "oauth2" ? "pending" : "active",
        providerAccountLabel: value.providerAccountLabel ?? null,
        oauthAppId: value.authType === "oauth2" ? "oauth_shared" : null,
        revokedAt: null,
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
      };
      this.connections.push(connection);
      return value.authType === "oauth2"
        ? json(
            {
              connection,
              redirectUrl:
                "https://control.example.test/oauth/start?intent=fixture",
              expiresAt: "2026-07-19T00:10:00.000Z",
            },
            201,
          )
        : json({ connection }, 201);
    }
    if (path === "/v1/projects/proj_fixture/connections" && method === "GET") {
      return json({ connections: this.connections });
    }
    const connectionMatch = path.match(
      /^\/v1\/projects\/proj_fixture\/connections\/(conn_[0-9]+)$/u,
    );
    if (connectionMatch !== null && method === "DELETE") {
      const connection = this.connections.find(
        ({ id }) => id === connectionMatch[1],
      );
      if (connection === undefined) return json({ error: "missing" }, 404);
      const revoked: CloudConnection = {
        ...connection,
        status: "revoked",
        revokedAt: "2026-07-19T00:01:00.000Z",
        updatedAt: "2026-07-19T00:01:00.000Z",
      };
      this.connections.splice(this.connections.indexOf(connection), 1, revoked);
      return json({ connection: revoked });
    }
    const reauthorizeMatch = path.match(
      /^\/v1\/projects\/proj_fixture\/connections\/(conn_[0-9]+)\/reauthorize$/u,
    );
    if (reauthorizeMatch !== null && method === "POST") {
      const connection = this.connections.find(
        ({ id }) => id === reauthorizeMatch[1],
      );
      if (connection === undefined) return json({ error: "missing" }, 404);
      const pending: CloudConnection = {
        ...connection,
        status: "pending",
        updatedAt: "2026-07-19T00:02:00.000Z",
      };
      this.connections.splice(this.connections.indexOf(connection), 1, pending);
      return json({
        connection: pending,
        redirectUrl:
          "https://control.example.test/oauth/start?intent=reauthorize",
        expiresAt: "2026-07-19T00:12:00.000Z",
      });
    }
    return json(
      { error: { code: "not_found", message: `${method} ${path}` } },
      404,
    );
  };
}

const apiKeyToolkit: CatalogToolkitSummary = {
  authClass: "api_key",
  authFields: ["apiKey"],
  capabilities: [],
  displayName: "Resend",
  slug: "resend",
  sourceLabel: "native",
  tier: "stable",
  toolCount: 1,
};

const oauthToolkit: CatalogToolkitSummary = {
  ...apiKeyToolkit,
  authClass: "oauth2",
  authFields: [],
  displayName: "GitHub",
  slug: "github",
};

describe("dashboard cloud mode data flow", () => {
  it("reads organization billing through the same-origin cloud proxy", async () => {
    const fake = new FakeCloudControlPlane();
    const client = new CloudClient({
      baseUrl: "https://dashboard.example.test/api/cloud",
      csrfToken: () => CSRF_TOKEN,
      fetch: fake.fetch,
    });

    const response = await client.billing("org_fixture");

    expect(response.billing).toMatchObject({
      plan: { key: "pro", name: "Pro" },
      status: "active",
      hasPaymentPortal: true,
    });
    expect(fake.requests.at(-1)).toMatchObject({
      method: "GET",
      path: "/v1/orgs/org_fixture/billing",
    });
  });

  it("logs in and creates the first organization, project, and pinned reveal-once key", async () => {
    const fake = new FakeCloudControlPlane();
    const client = new CloudClient({
      baseUrl: "https://dashboard.example.test/api/cloud",
      csrfToken: () => CSRF_TOKEN,
      fetch: fake.fetch,
    });

    const login = await client.login({
      email: "operator@example.test",
      password: "correct horse battery staple",
    });
    expect(login.user.id).toBe("usr_operator");
    const organization = await client.createOrganization({
      name: "Acme Agents",
      slug: "acme-agents",
    });
    const project = await client.createProject(organization.organization.id, {
      name: "Production",
      slug: "production",
      environment: "prod",
    });
    const createdKey = await client.createApiKey(project.project.id, {
      name: "Initial project key",
      pinnedUserId: login.user.id,
    });

    expect(createdKey.key).toBe(FULL_PROJECT_KEY);
    expect(createdKey.apiKey.pinnedUserId).toBe("usr_operator");
    expect(
      JSON.stringify((await client.listApiKeys(project.project.id)).apiKeys),
    ).not.toContain(FULL_PROJECT_KEY);
    expect(confirmApiKeyRevocation(createdKey.apiKey, () => false)).toBe(false);
    expect(confirmApiKeyRevocation(createdKey.apiKey, () => true)).toBe(true);
    expect(
      (await client.revokeApiKey(project.project.id, createdKey.apiKey.id))
        .apiKey.revokedAt,
    ).not.toBeNull();
    expect(
      fake.requests.every(
        ({ headers }) => headers.get("Authorization") === null,
      ),
    ).toBe(true);
  });

  it("creates API-key and OAuth connections, renders the hosted link, and revokes after confirmation", async () => {
    const fake = new FakeCloudControlPlane();
    const client = new CloudClient({
      baseUrl: "https://dashboard.example.test/api/cloud",
      csrfToken: () => CSRF_TOKEN,
      fetch: fake.fetch,
    });

    const apiKeyResult = await client.createConnection(
      "proj_fixture",
      cloudConnectionRequest({
        externalUserId: "user_api",
        fields: { apiKey: "provider-secret" },
        providerAccountLabel: "Billing email",
        toolkit: apiKeyToolkit,
      }),
    );
    expect(apiKeyResult.connection.status).toBe("active");
    expect(JSON.stringify(apiKeyResult)).not.toContain("provider-secret");

    const oauthResult = await client.createConnection(
      "proj_fixture",
      cloudConnectionRequest({
        externalUserId: "user_oauth",
        fields: {},
        providerAccountLabel: "Primary GitHub",
        toolkit: oauthToolkit,
      }),
    );
    expect("redirectUrl" in oauthResult).toBe(true);
    if (!("redirectUrl" in oauthResult)) throw new Error("Missing OAuth link");
    const html = renderToStaticMarkup(
      <HostedConnectLinkDialog
        link={{
          expiresAt: oauthResult.expiresAt,
          redirectUrl: oauthResult.redirectUrl,
          toolkit: "GitHub",
        }}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain(oauthResult.redirectUrl.replaceAll("&", "&amp;"));
    expect(html).toContain("Open in new tab");

    const reauthorized = await client.reauthorizeConnection(
      "proj_fixture",
      oauthResult.connection.id,
    );
    expect(reauthorized.connection.id).toBe(oauthResult.connection.id);
    expect(reauthorized.connection.status).toBe("pending");
    expect(reauthorized.redirectUrl).toContain("intent=reauthorize");

    expect(
      confirmCloudConnectionRevocation(oauthResult.connection, () => false),
    ).toBe(false);
    expect(
      confirmCloudConnectionRevocation(oauthResult.connection, () => true),
    ).toBe(true);
    const revoked = await client.revokeConnection(
      "proj_fixture",
      oauthResult.connection.id,
    );
    expect(revoked.connection.status).toBe("revoked");
    expect(
      (await client.listConnections("proj_fixture")).connections,
    ).toHaveLength(2);
  });

  it("renders the first project key with a reveal-once storage warning", () => {
    const html = renderToStaticMarkup(
      <SecretRevealDialog
        onClose={() => undefined}
        secret={FULL_PROJECT_KEY}
      />,
    );
    expect(html).toContain(FULL_PROJECT_KEY);
    expect(html).toContain("only time");
    expect(html).toContain("Store this now");
  });

  it("allows only same-origin dashboard paths as post-login destinations", () => {
    expect(safeDashboardNextPath("/proj_fixture/connections")).toBe(
      "/proj_fixture/connections",
    );
    expect(safeDashboardNextPath("//attacker.example.test")).toBe("/");
    expect(safeDashboardNextPath("https://attacker.example.test")).toBe("/");
    expect(safeDashboardNextPath("/safe\\attacker")).toBe("/");
  });
});
