import { redirect } from "next/navigation";
import { CloudApiError } from "@/src/lib/cloud-api";
import { loadCloudShellContext } from "@/src/lib/cloud-server";
import { isCloudMode } from "@/src/lib/runtime-config";

export default async function HomePage() {
  if (!isCloudMode()) redirect("/demo/overview");
  let cloudContext: Awaited<ReturnType<typeof loadCloudShellContext>>;
  try {
    cloudContext = await loadCloudShellContext();
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 401)
      redirect("/login");
    throw error;
  }
  if (cloudContext === undefined) redirect("/onboarding");
  redirect(`/${encodeURIComponent(cloudContext.selectedProject.id)}/overview`);
}
