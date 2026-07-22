import {
  dashboardExecutorClient,
  type ExecuteToolResponse,
  type ExecutorClient,
  type JsonValue,
} from "./api";

export interface VoiceSessionLink {
  readonly sessionId: string;
  readonly userId: string;
}

export interface HydratedVoiceSessionLink {
  readonly agent: unknown;
  readonly artifact: unknown;
  readonly events: readonly unknown[];
  readonly session: Readonly<Record<string, unknown>>;
}

type VoiceSessionLinkClient = Pick<ExecutorClient, "execute" | "getExecution">;

/** Builds the canonical dashboard route for a verified voice execution source. */
export function voiceSessionHref(
  project: string,
  sessionId: string,
  userId: string,
): string {
  const query = new URLSearchParams({ session: sessionId, userId });
  return `/${encodeURIComponent(project)}/voice-agents?${query.toString()}`;
}

/** Accepts a deep link only when its session and execution user are both present. */
export function parseVoiceSessionLink(
  session: string | null | undefined,
  userId: string | null | undefined,
): VoiceSessionLink | undefined {
  if (session === null || session === undefined || session.trim() === "") {
    return undefined;
  }
  if (userId === null || userId === undefined || userId.trim() === "") {
    return undefined;
  }
  return { sessionId: session, userId };
}

function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) =>
    globalThis.setTimeout(resolve, milliseconds),
  );
}

async function terminal(
  client: VoiceSessionLinkClient,
  execution: ExecuteToolResponse,
): Promise<ExecuteToolResponse> {
  if (
    execution.status === "succeeded" ||
    execution.status === "failed" ||
    execution.status === "cancelled"
  ) {
    return execution;
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(200);
    const detail = await client.getExecution(execution.executionId);
    if (
      detail.status === "succeeded" ||
      detail.status === "failed" ||
      detail.status === "cancelled"
    ) {
      return detail;
    }
  }
  throw new Error(`Execution ${execution.executionId} did not finish in time.`);
}

async function runRead(
  client: VoiceSessionLinkClient,
  userId: string,
  tool: string,
  input: Readonly<Record<string, JsonValue>>,
): Promise<Readonly<Record<string, unknown>>> {
  const execution = await terminal(
    client,
    await client.execute({ input, mode: "sync", tool, userId }),
  );
  if (execution.status === "failed" || execution.status === "cancelled") {
    throw new Error(`${execution.error.code}: ${execution.error.message}`);
  }
  if (execution.status !== "succeeded") {
    throw new Error("Execution did not reach a terminal state.");
  }
  return record(execution.output, `${tool} output`);
}

/** Hydrates an exact historical session under its selected project and execution user. */
export async function hydrateVoiceSessionLink(
  link: VoiceSessionLink & { readonly project: string },
  clientFactory: (
    project: string,
  ) => VoiceSessionLinkClient = dashboardExecutorClient,
): Promise<HydratedVoiceSessionLink> {
  const client = clientFactory(link.project);
  const [sessionOutput, transcriptOutput] = await Promise.all([
    runRead(client, link.userId, "voice-agents.get_agent_session", {
      afterSequence: 0,
      eventLimit: 200,
      sessionId: link.sessionId,
    }),
    runRead(client, link.userId, "voice-agents.get_session_transcript", {
      sessionId: link.sessionId,
    }),
  ]);
  const session = record(sessionOutput.session, "Voice session");
  if (session.id !== link.sessionId || session.userId !== link.userId) {
    throw new Error(
      "The voice session does not match the requested execution source.",
    );
  }
  if (
    typeof session.projectId === "string" &&
    session.projectId !== link.project
  ) {
    throw new Error("The voice session belongs to a different project.");
  }
  if (
    typeof session.agentId !== "string" ||
    typeof session.agentRevision !== "number" ||
    !Number.isSafeInteger(session.agentRevision) ||
    session.agentRevision <= 0
  ) {
    throw new Error("The voice session has invalid agent provenance.");
  }
  const agentOutput = await runRead(
    client,
    link.userId,
    "voice-agents.get_voice_agent",
    {
      agentId: session.agentId,
      revision: session.agentRevision,
    },
  );
  return {
    agent: agentOutput.agent,
    artifact: transcriptOutput.artifact,
    events: Array.isArray(sessionOutput.events) ? sessionOutput.events : [],
    session,
  };
}
