import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/src/components/shell/app-shell";
import { CloudApiError } from "@/src/lib/cloud-api";
import { loadCloudShellContext } from "@/src/lib/cloud-server";
import { isCloudMode } from "@/src/lib/runtime-config";

export default async function ProjectLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ project: string }>;
}>) {
  const { project } = await params;
  if (!isCloudMode()) {
    return <AppShell project={project}>{children}</AppShell>;
  }
  let cloudContext: Awaited<ReturnType<typeof loadCloudShellContext>>;
  try {
    cloudContext = await loadCloudShellContext(project);
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 401) {
      redirect(`/login?next=/${encodeURIComponent(project)}/overview`);
    }
    throw error;
  }
  if (cloudContext === undefined) redirect("/onboarding");
  if (cloudContext.selectedProject.id !== project) {
    redirect(
      `/${encodeURIComponent(cloudContext.selectedProject.id)}/overview`,
    );
  }
  return (
    <AppShell
      cloudContext={cloudContext}
      project={cloudContext.selectedProject.id}
    >
      {children}
    </AppShell>
  );
}
