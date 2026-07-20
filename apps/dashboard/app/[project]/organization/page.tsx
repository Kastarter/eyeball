import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OrganizationScreen } from "@/src/components/cloud/organization-screen";
import { getCatalogToolkitSummaries } from "@/src/lib/catalog";
import {
  loadCloudOAuthApps,
  loadCloudOrganizationMembers,
  loadCloudShellContext,
} from "@/src/lib/cloud-server";
import { isCloudMode } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Organization" };

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = await params;
  if (!isCloudMode()) redirect(`/${encodeURIComponent(project)}/settings`);
  const cloudContext = await loadCloudShellContext(project);
  if (cloudContext === undefined) redirect("/onboarding");
  const organizationId = cloudContext.selectedOrganization.id;
  const [members, oauthApps] = await Promise.all([
    loadCloudOrganizationMembers(organizationId),
    loadCloudOAuthApps(organizationId),
  ]);
  return (
    <OrganizationScreen
      initialMembers={members}
      initialOAuthApps={oauthApps}
      organization={cloudContext.selectedOrganization}
      project={cloudContext.selectedProject.id}
      toolkits={getCatalogToolkitSummaries()}
    />
  );
}
