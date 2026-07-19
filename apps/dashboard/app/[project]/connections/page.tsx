import type { Metadata } from "next";
import { ConnectionsScreen } from "@/src/components/connections/connections-screen";
import { getCatalogToolkitSummaries } from "@/src/lib/catalog";
import { loadCloudConnections } from "@/src/lib/cloud-server";
import { dashboardDataSource } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Connections" };

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const [{ project }, query] = await Promise.all([params, searchParams]);
  const newValue = Array.isArray(query.new) ? query.new[0] : query.new;
  const dataSource = dashboardDataSource("connections");
  const initialCloudConnections =
    dataSource === "cloud-control" ? await loadCloudConnections(project) : [];
  return (
    <ConnectionsScreen
      dataSource={dataSource === "cloud-control" ? "cloud-control" : "executor"}
      initialCloudConnections={initialCloudConnections}
      initialNewConnectionOpen={newValue === "true"}
      project={project}
      toolkits={getCatalogToolkitSummaries()}
    />
  );
}
