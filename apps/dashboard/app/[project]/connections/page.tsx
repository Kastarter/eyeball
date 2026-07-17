import type { Metadata } from "next";
import { ConnectionsScreen } from "@/src/components/connections/connections-screen";
import { getCatalogToolkitSummaries } from "@/src/lib/catalog";

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
  return (
    <ConnectionsScreen
      initialNewConnectionOpen={newValue === "true"}
      project={project}
      toolkits={getCatalogToolkitSummaries()}
    />
  );
}
