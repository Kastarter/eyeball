import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BillingScreen } from "@/src/components/billing/billing-screen";
import { AppShell } from "@/src/components/shell/app-shell";
import { firstSearchParam } from "@/src/lib/billing-return";
import { CloudApiError } from "@/src/lib/cloud-api";
import {
  loadCloudBilling,
  loadCloudBillingPlans,
  loadCloudShellContextForOrganization,
  loadCloudUsage,
} from "@/src/lib/cloud-server";
import { isCloudMode } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Organization billing" };

interface BillingPageProps {
  searchParams: Promise<{ org?: string | string[] }>;
}

export default async function BillingPage({ searchParams }: BillingPageProps) {
  if (!isCloudMode()) redirect("/demo/overview");
  const organizationId = firstSearchParam((await searchParams).org);
  try {
    const cloudContext =
      await loadCloudShellContextForOrganization(organizationId);
    if (cloudContext === undefined) {
      redirect(organizationId === undefined ? "/onboarding" : "/");
    }
    const selectedOrganizationId = cloudContext.selectedOrganization.id;
    const [billing, usage, plans] = await Promise.all([
      loadCloudBilling(selectedOrganizationId),
      loadCloudUsage(selectedOrganizationId),
      loadCloudBillingPlans(selectedOrganizationId),
    ]);
    return (
      <AppShell
        cloudContext={cloudContext}
        project={cloudContext.selectedProject.id}
      >
        <BillingScreen
          billing={billing}
          now={new Date().toISOString()}
          organization={cloudContext.selectedOrganization}
          plans={plans}
          usage={usage}
        />
      </AppShell>
    );
  } catch (error) {
    if (!(error instanceof CloudApiError) || error.status !== 401) throw error;
    const suffix =
      organizationId === undefined
        ? ""
        : `?org=${encodeURIComponent(organizationId)}`;
    redirect(`/login?next=${encodeURIComponent(`/billing${suffix}`)}`);
  }
}
