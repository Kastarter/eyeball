import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/billing" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { SidebarNav } from "./sidebar-nav";

describe("SidebarNav", () => {
  it("adds the organization administration group only in cloud mode", () => {
    const cloud = renderToStaticMarkup(
      <SidebarNav cloud organizationId="org_fixture" project="proj_fixture" />,
    );
    const demo = renderToStaticMarkup(<SidebarNav project="demo" />);

    expect(cloud).toContain("Organization");
    expect(cloud).toContain("Billing");
    expect(cloud).toContain("Audit");
    expect(cloud).toContain("/billing?org=org_fixture");
    expect(cloud).toContain('aria-current="page"');
    expect(demo).not.toContain("Billing");
    expect(demo).not.toContain("Organization");
    expect(demo).not.toContain("Audit");
    expect(demo).toContain("/demo/settings");
    expect(demo).toContain("/demo/webhooks");
    expect(demo).toContain("/demo/triggers");
    expect(demo).toContain("/demo/files");
    expect(cloud).toContain("/proj_fixture/webhooks");
    expect(cloud).toContain("/proj_fixture/triggers");
    expect(cloud).toContain("/proj_fixture/files");
  });

  it("marks the project Webhooks destination active", () => {
    navigation.pathname = "/proj_fixture/webhooks";
    const markup = renderToStaticMarkup(
      <SidebarNav cloud organizationId="org_fixture" project="proj_fixture" />,
    );
    navigation.pathname = "/billing";

    expect(markup).toContain('href="/proj_fixture/webhooks"');
    expect(markup).toMatch(
      /aria-current="page"[^>]*href="\/proj_fixture\/webhooks"|href="\/proj_fixture\/webhooks"[^>]*aria-current="page"/u,
    );
  });
});
