import type { Metadata } from "next";
import { ExecutionsScreen } from "@/src/components/executions/executions-screen";
import { executionEmptySnippet } from "@/src/lib/catalog-examples";

export const metadata: Metadata = { title: "Executions" };

function first(
  value: string | readonly string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const [{ project }, query] = await Promise.all([params, searchParams]);
  const status = first(query.status);
  const execution = first(query.execution);
  const tool = first(query.tool);
  const userId = first(query.userId);
  return (
    <ExecutionsScreen
      emptySnippet={executionEmptySnippet}
      {...(execution === undefined ? {} : { initialExecution: execution })}
      initialFilters={{
        ...(status === "pending" ||
        status === "running" ||
        status === "succeeded" ||
        status === "failed" ||
        status === "cancelled"
          ? { status }
          : {}),
        ...(tool === undefined ? {} : { tool }),
        ...(userId === undefined ? {} : { userId }),
      }}
      project={project}
    />
  );
}
