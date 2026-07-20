import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  CloudBillingPlan,
  CloudBillingView,
  CloudOrganization,
  CloudUsageView,
} from "@/src/lib/cloud-api";
import { CloudClient } from "@/src/lib/cloud-api";
import {
  BillingScreen,
  billingGraceLabel,
  startBillingCheckout,
  startBillingPortal,
} from "./billing-screen";

const freePlan: CloudBillingPlan = {
  baseMonthlyCents: 0,
  hardLimits: true,
  included: { connections: 3, executions: 1_000, projects: 1 },
  key: "free",
  name: "Free",
  overage: { connections: null, executions: null },
  selfServe: false,
  version: 1,
};

const proPlan: CloudBillingPlan = {
  baseMonthlyCents: 4_900,
  hardLimits: false,
  included: { connections: 20, executions: 50_000, projects: 5 },
  key: "pro",
  name: "Pro",
  overage: {
    connections: { unitCents: 500, unitSize: 1 },
    executions: { unitCents: 75, unitSize: 1_000 },
  },
  selfServe: true,
  version: 3,
};

const scalePlan: CloudBillingPlan = {
  ...proPlan,
  baseMonthlyCents: 19_900,
  included: { connections: 100, executions: 500_000, projects: 20 },
  key: "scale",
  name: "Scale",
  version: 2,
};

const enterprisePlan: CloudBillingPlan = {
  ...scalePlan,
  baseMonthlyCents: null,
  included: { connections: null, executions: null, projects: null },
  key: "enterprise",
  name: "Enterprise",
  selfServe: false,
  version: 4,
};

const ownerOrganization: CloudOrganization = {
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "org_fixture",
  name: "Fixture Organization",
  oauthRedirectOrigins: ["https://app.example.test"],
  role: "owner",
  slug: "fixture",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function billing(overrides: Partial<CloudBillingView> = {}): CloudBillingView {
  return {
    currentPeriod: {
      end: "2026-08-01T00:00:00.000Z",
      start: "2026-07-01T00:00:00.000Z",
    },
    graceEndsAt: null,
    hasPaymentPortal: false,
    limits: freePlan.included,
    pastDueSince: null,
    plan: freePlan,
    restrictions: {
      credentialResolves: false,
      existingKeys: false,
      newApiKeys: false,
      newConnections: false,
    },
    status: "free",
    usage: {
      month: "2026-07",
      percentage: { connections: 66.7, executions: 80, projects: 100 },
      projected: {
        connectionsPeak: 2,
        executions: 1_200,
        overage: {
          connections: { cents: 0, quantity: 0, units: 0 },
          executions: { cents: 0, quantity: 200, units: 0 },
          totalCents: 0,
        },
      },
      totals: { connectionsPeak: 2, executions: 800, projects: 1 },
    },
    ...overrides,
  };
}

function usage(view: CloudBillingView): CloudUsageView {
  return {
    limits: view.limits,
    month: view.usage.month,
    percentage: view.usage.percentage,
    plan: view.plan,
    projected: view.usage.projected,
    totals: view.usage.totals,
  };
}

function renderBilling(view: CloudBillingView): string {
  return renderToStaticMarkup(
    <BillingScreen
      billing={view}
      now="2026-07-20T00:00:00.000Z"
      organization={ownerOrganization}
      plans={[freePlan, proPlan, scalePlan, enterprisePlan]}
      usage={usage(view)}
    />,
  );
}

describe("BillingScreen", () => {
  it("covers the free plan caps and upgrade state", () => {
    const html = renderBilling(billing());

    expect(html).toContain("Current plan");
    expect(html).toContain("Upgrade from Free");
    expect(html).toContain("Hard usage caps");
    expect(html).toContain("July 2026 only");
    expect(html).toContain("highest active connected-account snapshot");
    expect(html).not.toContain("Manage billing");
  });

  it("covers an active paid plan with portal and metered projection", () => {
    const view = billing({
      hasPaymentPortal: true,
      limits: proPlan.included,
      plan: proPlan,
      status: "active",
      usage: {
        ...billing().usage,
        projected: {
          connectionsPeak: 23,
          executions: 54_000,
          overage: {
            connections: { cents: 1_500, quantity: 3, units: 3 },
            executions: { cents: 300, quantity: 4_000, units: 4 },
            totalCents: 1_800,
          },
        },
      },
    });
    const html = renderBilling(view);

    expect(html).toContain("Manage billing");
    expect(html).toContain("Active");
    expect(html).toContain("Projected executions");
    expect(html).toContain("Projected peak: 23");
    expect(html).toContain("3 projected overage connected accounts");
    expect(html).toContain("$18");
    expect(html).not.toContain("Payment requires attention");
  });

  it("covers past due while the grace period is active", () => {
    const html = renderBilling(
      billing({
        graceEndsAt: "2026-07-25T00:00:00.000Z",
        pastDueSince: "2026-07-11T00:00:00.000Z",
        plan: proPlan,
        status: "past_due",
      }),
    );

    expect(html).toContain("Payment requires attention");
    expect(html).toContain("5 days left in grace period");
    expect(html).toContain("Past due");
    expect(html).toContain("billing-status--warning");
  });

  it("covers the post-grace restricted state", () => {
    const html = renderBilling(
      billing({
        graceEndsAt: "2026-07-19T00:00:00.000Z",
        pastDueSince: "2026-07-05T00:00:00.000Z",
        plan: proPlan,
        restrictions: {
          credentialResolves: false,
          existingKeys: false,
          newApiKeys: true,
          newConnections: true,
        },
        status: "past_due",
      }),
    );

    expect(html).toContain("Payment grace period expired");
    expect(html).toContain(
      "New API keys, connections, executions, and credential resolves are restricted",
    );
    expect(html).toContain("Existing keys keep their identity");
    expect(html).toContain("billing-status--restricted");
    expect(
      billingGraceLabel("2026-07-19T00:00:00.000Z", "2026-07-20T00:00:00.000Z"),
    ).toBe("Grace period ended");
  });

  it("starts checkout and portal mutations before redirecting", async () => {
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
        return path.endsWith("/checkout")
          ? Response.json({
              checkout: {
                id: "cs_fixture",
                url: "https://checkout.stripe.test/session",
              },
            })
          : Response.json({ url: "https://billing.stripe.test/session" });
      },
    });
    const redirect = vi.fn();

    await startBillingCheckout("org_fixture", "scale", redirect, client);
    await startBillingPortal("org_fixture", redirect, client);

    expect(requests).toEqual([
      {
        body: { plan: "scale" },
        method: "POST",
        path: "/v1/orgs/org_fixture/billing/checkout",
      },
      {
        body: {},
        method: "POST",
        path: "/v1/orgs/org_fixture/billing/portal",
      },
    ]);
    expect(redirect).toHaveBeenNthCalledWith(
      1,
      "https://checkout.stripe.test/session",
    );
    expect(redirect).toHaveBeenNthCalledWith(
      2,
      "https://billing.stripe.test/session",
    );
  });
});
