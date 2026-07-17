import type { Metadata } from "next";
import { VoiceAgentsScreen } from "@/src/components/voice-agents/voice-agents-screen";
import { getCatalogCommandIndex } from "@/src/lib/catalog";

export const metadata: Metadata = { title: "Voice Agents" };

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
  const agent = first(query.agent);
  const revisionValue = Number(first(query.revision));
  const revision =
    Number.isSafeInteger(revisionValue) && revisionValue > 0
      ? revisionValue
      : undefined;
  return (
    <VoiceAgentsScreen
      {...(agent === undefined ? {} : { initialSelectedAgent: agent })}
      {...(revision === undefined ? {} : { initialRevision: revision })}
      project={project}
      tools={getCatalogCommandIndex().tools}
    />
  );
}
