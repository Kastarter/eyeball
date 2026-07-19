import type { Metadata } from "next";
import { ApiKeysScreen } from "@/src/components/cloud/api-keys-screen";
import { ScaffoldPage } from "@/src/components/pages/scaffold-page";
import {
  loadCloudApiKeys,
  loadCloudShellContext,
} from "@/src/lib/cloud-server";
import { routeContent } from "@/src/lib/route-content";
import { dashboardDataSource } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "API Keys" };

export default async function Page({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = await params;
  if (dashboardDataSource("apiKeys") === "cloud-control") {
    const context = await loadCloudShellContext(project);
    if (context !== undefined) {
      return (
        <ApiKeysScreen
          currentUserId={context.session.user.id}
          initialApiKeys={await loadCloudApiKeys(project)}
          project={project}
        />
      );
    }
  }
  return <ScaffoldPage content={routeContent["api-keys"]} />;
}
