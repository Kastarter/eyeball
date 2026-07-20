import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CatalogToolkitSummary } from "@/src/lib/catalog";
import {
  CloudClient,
  type CloudMembershipRole,
  type CloudOAuthApp,
  type CloudOrganization,
  type CloudOrganizationMember,
} from "@/src/lib/cloud-api";
import {
  confirmOrganizationMemberRemoval,
  confirmOrganizationMemberRoleChange,
  normalizeOAuthRedirectOrigins,
  OrganizationScreen,
  oauthAppRequest,
  organizationMemberPolicy,
  requestOrganizationMemberAddition,
  requestOrganizationMemberRemoval,
  requestOrganizationMemberRoleChange,
} from "./organization-screen";

const oauthToolkit: CatalogToolkitSummary = {
  authClass: "oauth2",
  authFields: [],
  capabilities: [],
  displayName: "GitHub",
  slug: "github",
  sourceLabel: "native",
  tier: "stable",
  toolCount: 4,
};

const members: readonly CloudOrganizationMember[] = [
  {
    createdAt: "2026-01-01T00:00:00.000Z",
    email: "owner@example.test",
    organizationId: "org_fixture",
    role: "owner",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userId: "usr_owner",
  },
  {
    createdAt: "2026-02-01T00:00:00.000Z",
    email: "admin@example.test",
    organizationId: "org_fixture",
    role: "admin",
    updatedAt: "2026-02-01T00:00:00.000Z",
    userId: "usr_admin",
  },
  {
    createdAt: "2026-03-01T00:00:00.000Z",
    email: "member@example.test",
    organizationId: "org_fixture",
    role: "member",
    updatedAt: "2026-03-01T00:00:00.000Z",
    userId: "usr_member",
  },
];

function organization(role: CloudMembershipRole): CloudOrganization {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "org_fixture",
    name: "Fixture Organization",
    oauthRedirectOrigins: ["https://app.example.test"],
    role,
    slug: "fixture",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

const unsafeOAuthPayload: CloudOAuthApp & { clientSecret: string } = {
  clientId: "client-safe-metadata",
  clientSecret: "super-secret-must-never-render",
  createdAt: "2026-07-01T00:00:00.000Z",
  hasClientSecret: true,
  id: "oauth_fixture",
  kind: "byo",
  organizationId: "org_fixture",
  redirectBase: "https://control.example.test/oauth/callback",
  scopes: ["read:user"],
  toolkit: "github",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function renderOrganization(role: CloudMembershipRole): string {
  return renderToStaticMarkup(
    <OrganizationScreen
      initialMembers={members}
      initialOAuthApps={[unsafeOAuthPayload]}
      organization={organization(role)}
      project="proj_fixture"
      toolkits={[oauthToolkit]}
    />,
  );
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("OrganizationScreen", () => {
  it("shows owner-only role changes and removal without exposing OAuth secrets", () => {
    const html = renderOrganization("owner");

    expect(html).toContain("Owners may grant member or admin");
    expect(html).toContain('aria-label="Role for admin@example.test"');
    expect(html).toContain("Remove");
    expect(html).toContain("Protected owner");
    expect(html).toContain("Stored · never readable");
    expect(html).toContain("client-safe-metadata");
    expect(html).not.toContain("super-secret-must-never-render");
    expect(html).toContain("View audit log");
  });

  it("lets admins add members but hides owner-only affordances", () => {
    const html = renderOrganization("admin");

    expect(html).toContain("Admins may add members only");
    expect(html).toContain("Add member");
    expect(html).toContain("Owner action required");
    expect(html).not.toContain('aria-label="Role for admin@example.test"');
    expect(html).not.toContain("button--danger");
  });

  it("renders members and safe OAuth metadata read-only for members", () => {
    const html = renderOrganization("member");

    expect(html).toContain("member@example.test");
    expect(html).toContain("client-safe-metadata");
    expect(html).not.toContain("Add member");
    expect(html).not.toContain("Save name");
    expect(html).not.toContain("Save or replace app");
    expect(html).not.toContain("Save origins");
  });

  it("mirrors the owner/admin member-role matrix", () => {
    expect(organizationMemberPolicy("owner", "member")).toEqual({
      canAdd: true,
      canGrantAdmin: true,
      canManageTarget: true,
    });
    expect(organizationMemberPolicy("owner", "owner").canManageTarget).toBe(
      false,
    );
    expect(organizationMemberPolicy("admin", "member")).toEqual({
      canAdd: true,
      canGrantAdmin: false,
      canManageTarget: false,
    });
    expect(organizationMemberPolicy("member", "member").canAdd).toBe(false);
  });

  it("requires confirmation and protects the owner membership", () => {
    expect(
      confirmOrganizationMemberRoleChange(
        members[2] as CloudOrganizationMember,
        "admin",
        () => false,
      ),
    ).toBe(false);
    expect(
      confirmOrganizationMemberRoleChange(
        members[2] as CloudOrganizationMember,
        "admin",
        () => true,
      ),
    ).toBe(true);
    expect(
      confirmOrganizationMemberRemoval(
        members[1] as CloudOrganizationMember,
        () => true,
      ),
    ).toBe(true);
    expect(
      confirmOrganizationMemberRemoval(
        members[0] as CloudOrganizationMember,
        () => true,
      ),
    ).toBe(false);
  });

  it("validates exact redirect origins and builds write-only OAuth payloads", () => {
    expect(
      normalizeOAuthRedirectOrigins(
        "https://app.example.test\nhttp://localhost:3000\nhttps://app.example.test",
      ),
    ).toEqual({
      origins: ["https://app.example.test", "http://localhost:3000"],
    });
    expect(
      normalizeOAuthRedirectOrigins("http://public.example.test"),
    ).toMatchObject({ error: expect.stringContaining("exact HTTPS origin") });
    expect(
      oauthAppRequest({
        clientId: " client-id ",
        clientSecret: "write-only-secret",
        redirectBase: " https://control.example.test/oauth/callback ",
        scopes: "read:user,repo\nrepo",
        toolkit: "github",
      }),
    ).toEqual({
      clientId: "client-id",
      clientSecret: "write-only-secret",
      redirectBase: "https://control.example.test/oauth/callback",
      scopes: ["read:user", "repo"],
      toolkit: "github",
    });
  });

  it("issues exact organization, member, and OAuth app requests", async () => {
    const requests: Array<{ body: unknown; method: string; path: string }> = [];
    const client = new CloudClient({
      baseUrl: "https://dashboard.example.test/api/cloud",
      csrfToken: () => "csrf_fixture",
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname.replace(
          /^\/api\/cloud/u,
          "",
        );
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        requests.push({ body, method, path });
        if (method === "DELETE") return new Response(null, { status: 204 });
        if (path.endsWith("/oauth-apps")) {
          return json({ oauthApp: unsafeOAuthPayload });
        }
        if (method === "POST") {
          return json({
            membership: members[2],
            user: { email: members[2]?.email, id: members[2]?.userId },
          });
        }
        return json({ membership: { ...members[2], role: "admin" } });
      },
    });

    await client.updateOrganization("org_fixture", {
      name: "Renamed Organization",
    });
    await client.updateOrganization("org_fixture", {
      oauthRedirectOrigins: ["https://app.example.test"],
    });
    await requestOrganizationMemberAddition(
      "org_fixture",
      { email: "member@example.test", role: "member" },
      client,
    );
    await requestOrganizationMemberRoleChange(
      "org_fixture",
      "usr_member",
      "admin",
      client,
    );
    await requestOrganizationMemberRemoval("org_fixture", "usr_member", client);
    await client.putOAuthApp(
      "org_fixture",
      oauthAppRequest({
        clientId: "client-id",
        clientSecret: "write-only-secret",
        redirectBase: "https://control.example.test/oauth/callback",
        scopes: "read:user",
        toolkit: "github",
      }),
    );

    expect(requests).toEqual([
      {
        body: { name: "Renamed Organization" },
        method: "PATCH",
        path: "/v1/orgs/org_fixture",
      },
      {
        body: { oauthRedirectOrigins: ["https://app.example.test"] },
        method: "PATCH",
        path: "/v1/orgs/org_fixture",
      },
      {
        body: { email: "member@example.test", role: "member" },
        method: "POST",
        path: "/v1/orgs/org_fixture/members",
      },
      {
        body: { role: "admin" },
        method: "PATCH",
        path: "/v1/orgs/org_fixture/members/usr_member",
      },
      {
        body: undefined,
        method: "DELETE",
        path: "/v1/orgs/org_fixture/members/usr_member",
      },
      {
        body: {
          clientId: "client-id",
          clientSecret: "write-only-secret",
          redirectBase: "https://control.example.test/oauth/callback",
          scopes: ["read:user"],
          toolkit: "github",
        },
        method: "POST",
        path: "/v1/orgs/org_fixture/oauth-apps",
      },
    ]);
  });
});
