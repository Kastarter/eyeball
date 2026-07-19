import type { Metadata } from "next";
import { ExecutorSettingsScreen } from "@/src/components/cloud/executor-settings-screen";
import { ScaffoldPage } from "@/src/components/pages/scaffold-page";
import { isExecutorKeyConfigured } from "@/src/lib/executor-key-server";
import { routeContent } from "@/src/lib/route-content";
import { isCloudMode } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Settings" };

export default async function Page({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = await params;
  if (isCloudMode()) {
    return (
      <ExecutorSettingsScreen
        configured={await isExecutorKeyConfigured(project)}
        project={project}
      />
    );
  }
  return <ScaffoldPage content={routeContent.settings} />;
}
