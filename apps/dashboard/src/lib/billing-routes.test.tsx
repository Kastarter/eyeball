import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudApiError,
  type CloudBillingView,
  type CloudOrganization,
  type CloudProject,
  type CloudUsageView,
} from "./cloud-api";

const cloudServer = vi.hoisted(() => ({
  loadCloudBilling: vi.fn(),
  loadCloudBillingPlans: vi.fn(),
  loadCloudOAuthApps: vi.fn(),
  loadCloudOrganizationMembers: vi.fn(),
  loadCloudSession: vi.fn(),
  loadCloudShellContext: vi.fn(),
  loadCloudShellContextForOrganization: vi.fn(),
  loadCloudUsage: vi.fn(),
}));

class RedirectSignal extends Error {
  readonly destination: string;

  constructor(destination: string) {
    super(`Redirect to ${destination}`);
    this.destination = destination;
  }
}

vi.mock("./cloud-server", () => cloudServer);
vi.mock("next/navigation", () => ({
  redirect(destination: string): never {
    throw new RedirectSignal(destination);
  },
  usePathname: () => "/billing",
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

import OrganizationPage from "../../app/[project]/organization/page";
import CheckoutCancelPage from "../../app/billing/checkout/cancel/page";
import CheckoutSuccessPage from "../../app/billing/checkout/success/page";
import BillingPage from "../../app/billing/page";

function billingView(
  overrides: Partial<CloudBillingView> = {},
): CloudBillingView {
  return {
    currentPeriod: {
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-08-01T00:00:00.000Z",
    },
    graceEndsAt: null,
    hasPaymentPortal: false,
    limits: { executions: 1_000, connections: 3, projects: 1 },
    pastDueSince: null,
    plan: {
      baseMonthlyCents: 0,
      hardLimits: true,
      included: { executions: 1_000, connections: 3, projects: 1 },
      key: "free",
      name: "Free",
      overage: { executions: null, connections: null },
      selfServe: false,
      version: 1,
    },
    restrictions: {
      credentialResolves: false,
      existingKeys: false,
      newApiKeys: false,
      newConnections: false,
    },
    status: "free",
    usage: {
      month: "2026-07",
      percentage: { executions: 1.2, connections: 0, projects: 100 },
      projected: {
        connectionsPeak: 0,
        executions: 12,
        overage: {
          connections: { cents: 0, quantity: 0, units: 0 },
          executions: { cents: 0, quantity: 0, units: 0 },
          totalCents: 0,
        },
      },
      totals: { executions: 12, connectionsPeak: 0, projects: 1 },
    },
    ...overrides,
  };
}

function organization(): CloudOrganization {
  return {
    createdAt: "2026-07-01T00:00:00.000Z",
    id: "org_fixture",
    name: "Fixture Organization",
    oauthRedirectOrigins: [],
    role: "owner",
    slug: "fixture",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function project(): CloudProject {
  return {
    createdAt: "2026-07-01T00:00:00.000Z",
    environment: "prod",
    id: "proj_fixture",
    name: "Production",
    organizationId: "org_fixture",
    slug: "production",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function usage(view = billingView()): CloudUsageView {
  return {
    limits: view.limits,
    month: view.usage.month,
    percentage: view.usage.percentage,
    plan: view.plan,
    projected: view.usage.projected,
    totals: view.usage.totals,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_EYEBALL_MODE", "cloud");
  cloudServer.loadCloudSession.mockResolvedValue({
    expiresAt: "2026-07-21T00:00:00.000Z",
    user: { id: "usr_fixture", email: "operator@example.test" },
  });
  const billing = billingView();
  const selectedOrganization = organization();
  const selectedProject = project();
  cloudServer.loadCloudBilling.mockResolvedValue(billing);
  cloudServer.loadCloudBillingPlans.mockResolvedValue([billing.plan]);
  cloudServer.loadCloudUsage.mockResolvedValue(usage(billing));
  cloudServer.loadCloudShellContextForOrganization.mockResolvedValue({
    organizations: [
      { organization: selectedOrganization, projects: [selectedProject] },
    ],
    selectedOrganization,
    selectedProject,
    session: {
      csrfCookie: "eyeball_cloud_csrf",
      csrfHeader: "X-CSRF-Token",
      expiresAt: "2026-07-21T00:00:00.000Z",
      user: { id: "usr_fixture", email: "operator@example.test" },
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("billing return routes", () => {
  it("renders a processing success state while the Stripe webhook catches up", async () => {
    cloudServer.loadCloudBilling.mockResolvedValue(billingView());

    const markup = renderToStaticMarkup(
      await CheckoutSuccessPage({
        searchParams: Promise.resolve({
          org: "org_fixture",
          session: "cs_test_do_not_render",
        }),
      }),
    );

    expect(markup).toContain("Your upgrade is processing.");
    expect(markup).toContain("waiting for the signed webhook");
    expect(markup).toContain("/billing?org=org_fixture");
    expect(markup).not.toContain("cs_test_do_not_render");
    expect(cloudServer.loadCloudBilling).toHaveBeenCalledWith("org_fixture");
  });

  it("renders the paid plan confirmation after webhook activation", async () => {
    const pro = billingView({
      hasPaymentPortal: true,
      plan: {
        ...billingView().plan,
        baseMonthlyCents: 4_900,
        hardLimits: false,
        key: "pro",
        name: "Pro",
        selfServe: true,
      },
      status: "active",
    });
    cloudServer.loadCloudBilling.mockResolvedValue(pro);

    const markup = renderToStaticMarkup(
      await CheckoutSuccessPage({
        searchParams: Promise.resolve({
          org: "org_fixture",
          session: "cs_test_active",
        }),
      }),
    );

    expect(markup).toContain("Your Pro plan is active.");
    expect(markup).toContain("Stripe confirmed the subscription");
    expect(markup).toContain("Active");
  });

  it("renders a no-charge cancel page with a membership-validated retry link", async () => {
    cloudServer.loadCloudBilling.mockResolvedValue(billingView());

    const markup = renderToStaticMarkup(
      await CheckoutCancelPage({
        searchParams: Promise.resolve({ org: "org_fixture" }),
      }),
    );

    expect(markup).toContain("No charge was made.");
    expect(markup).toContain("Retry from billing");
    expect(markup).toContain("/billing?org=org_fixture");
    expect(cloudServer.loadCloudBilling).toHaveBeenCalledWith("org_fixture");
  });

  it("renders the organization billing and current-month usage route", async () => {
    const markup = renderToStaticMarkup(
      await BillingPage({
        searchParams: Promise.resolve({ org: "org_fixture" }),
      }),
    );

    expect(markup).toContain("Billing &amp; usage");
    expect(markup).toContain("Current plan");
    expect(markup).toContain("Free");
    expect(markup).toContain("Dimension breakdown");
    expect(markup).toContain("July 2026");
    expect(
      cloudServer.loadCloudShellContextForOrganization,
    ).toHaveBeenCalledWith("org_fixture");
    expect(cloudServer.loadCloudUsage).toHaveBeenCalledWith("org_fixture");
    expect(cloudServer.loadCloudBillingPlans).toHaveBeenCalledWith(
      "org_fixture",
    );
  });

  it("requires a cloud session before rendering a Stripe return", async () => {
    cloudServer.loadCloudBilling.mockRejectedValue(
      new CloudApiError("Session required", 401, "authentication_required"),
    );

    await expect(
      CheckoutSuccessPage({
        searchParams: Promise.resolve({
          org: "org_fixture",
          session: "cs_fixture",
        }),
      }),
    ).rejects.toMatchObject({
      destination:
        "/login?next=%2Fbilling%2Fcheckout%2Fsuccess%3Forg%3Dorg_fixture%26session%3Dcs_fixture",
    });
  });

  it("does not trust an organization parameter outside the current membership", async () => {
    cloudServer.loadCloudBilling.mockRejectedValue(
      new CloudApiError(
        "Organization not found",
        404,
        "organization_not_found",
      ),
    );

    const markup = renderToStaticMarkup(
      await CheckoutSuccessPage({
        searchParams: Promise.resolve({
          org: "org_untrusted",
          session: "cs_fixture",
        }),
      }),
    );

    expect(markup).toContain("could not confirm this billing workspace");
    expect(markup).not.toContain("/billing?org=org_untrusted");
  });

  it("keeps billing and organization administration out of demo mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_EYEBALL_MODE", "demo");

    await expect(
      BillingPage({ searchParams: Promise.resolve({ org: "org_fixture" }) }),
    ).rejects.toMatchObject({ destination: "/demo/overview" });
    await expect(
      CheckoutCancelPage({
        searchParams: Promise.resolve({ org: "org_fixture" }),
      }),
    ).rejects.toMatchObject({ destination: "/demo/overview" });
    await expect(
      CheckoutSuccessPage({
        searchParams: Promise.resolve({
          org: "org_fixture",
          session: "cs_fixture",
        }),
      }),
    ).rejects.toMatchObject({ destination: "/demo/overview" });
    await expect(
      OrganizationPage({ params: Promise.resolve({ project: "demo" }) }),
    ).rejects.toMatchObject({ destination: "/demo/settings" });
    expect(cloudServer.loadCloudBilling).not.toHaveBeenCalled();
    expect(cloudServer.loadCloudOrganizationMembers).not.toHaveBeenCalled();
  });
});
