import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/billing",
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
  });
});
