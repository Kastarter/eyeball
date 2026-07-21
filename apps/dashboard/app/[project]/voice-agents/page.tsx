import type { Metadata } from "next";
import { VoiceAgentsScreen } from "@/src/components/voice-agents/voice-agents-screen";
import { getCatalogCommandIndex } from "@/src/lib/catalog";
import { parseVoiceSessionLink } from "@/src/lib/voice-session-link";

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
  const sessionLink = parseVoiceSessionLink(
    first(query.session),
    first(query.userId),
  );
  const revisionValue = Number(first(query.revision));
  const revision =
    Number.isSafeInteger(revisionValue) && revisionValue > 0
      ? revisionValue
      : undefined;
  return (
    <VoiceAgentsScreen
      {...(sessionLink === undefined && agent !== undefined
        ? { initialSelectedAgent: agent }
        : {})}
      {...(sessionLink === undefined && revision !== undefined
        ? { initialRevision: revision }
        : {})}
      {...(sessionLink === undefined
        ? {}
        : {
            initialSessionId: sessionLink.sessionId,
            initialSessionUserId: sessionLink.userId,
          })}
      project={project}
      tools={getCatalogCommandIndex().tools}
    />
  );
}
