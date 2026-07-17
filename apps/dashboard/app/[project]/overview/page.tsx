import type { Metadata } from "next";
import { OverviewPage } from "@/src/components/pages/overview-page";
import { getCatalogMetrics } from "@/src/lib/catalog";

export const metadata: Metadata = { title: "Overview" };

export default function Page() {
  return <OverviewPage metrics={getCatalogMetrics()} />;
}
