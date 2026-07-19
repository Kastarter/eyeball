import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DesignGallery } from "@/src/components/pages/design-gallery";
import { loadCloudSession } from "@/src/lib/cloud-server";
import { isCloudMode } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Design system" };

export default async function Page() {
  if (isCloudMode() && (await loadCloudSession()) === undefined) {
    redirect("/login?next=/design");
  }
  return <DesignGallery />;
}
