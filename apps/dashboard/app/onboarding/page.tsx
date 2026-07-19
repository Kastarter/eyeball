import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingScreen } from "@/src/components/cloud/onboarding-screen";
import { CloudApiError } from "@/src/lib/cloud-api";
import { loadCloudOrganizations } from "@/src/lib/cloud-server";
import { isCloudMode } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Create workspace" };

export default async function OnboardingPage() {
  if (!isCloudMode()) redirect("/demo/overview");
  let context: Awaited<ReturnType<typeof loadCloudOrganizations>>;
  try {
    context = await loadCloudOrganizations();
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 401)
      redirect("/login");
    throw error;
  }
  if (context.organizations.some(({ projects }) => projects.length > 0)) {
    redirect("/");
  }
  const existingOrganization = context.organizations[0]?.organization;
  return (
    <OnboardingScreen
      {...(existingOrganization === undefined ? {} : { existingOrganization })}
    />
  );
}
