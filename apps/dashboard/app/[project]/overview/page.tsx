import type { Metadata } from "next";
import { OverviewPage } from "@/src/components/pages/overview-page";
import { getCatalogMetrics } from "@/src/lib/catalog";

export const metadata: Metadata = { title: "Overview" };

export default async function Page({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = await params;
  return <OverviewPage metrics={getCatalogMetrics()} project={project} />;
}
