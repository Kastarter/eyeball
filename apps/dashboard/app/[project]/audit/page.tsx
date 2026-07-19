import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuditScreen } from "@/src/components/cloud/audit-screen";
import {
  loadCloudAuditEvents,
  loadCloudShellContext,
} from "@/src/lib/cloud-server";
import { dashboardDataSource } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Audit log" };

export default async function Page({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = await params;
  if (dashboardDataSource("audit") !== "cloud-control") {
    redirect(`/${encodeURIComponent(project)}/overview`);
  }
  const context = await loadCloudShellContext(project);
  if (context === undefined) redirect("/onboarding");
  return (
    <AuditScreen
      initialEvents={
        await loadCloudAuditEvents(context.selectedOrganization.id)
      }
      organizationId={context.selectedOrganization.id}
      organizationName={context.selectedOrganization.name}
    />
  );
}
