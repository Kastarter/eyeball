import type { Metadata } from "next";
import { ToolkitCatalogBrowser } from "@/src/components/toolkits/toolkit-catalog-browser";
import { getCatalogToolkitSummaries } from "@/src/lib/catalog";

export const metadata: Metadata = { title: "Toolkits" };

interface PageProps {
  params: Promise<{ project: string }>;
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}

function first(
  value: string | readonly string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

export default async function Page({ params, searchParams }: PageProps) {
  const [{ project }, query] = await Promise.all([params, searchParams]);
  const initialCapability = first(query.capability);
  const initialQuery = first(query.q);
  const initialToolkit = first(query.toolkit);
  const initialTool = first(query.tool);
  return (
    <ToolkitCatalogBrowser
      {...(initialCapability === undefined ? {} : { initialCapability })}
      {...(initialQuery === undefined ? {} : { initialQuery })}
      {...(initialToolkit === undefined ? {} : { initialToolkit })}
      {...(initialTool === undefined ? {} : { initialTool })}
      project={project}
      toolkits={getCatalogToolkitSummaries()}
    />
  );
}
