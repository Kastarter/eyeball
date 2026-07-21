import type {
  TranscriptArtifact,
  TranscriptTurn,
  VoiceAgentDefinition,
  VoiceAgentSession,
  VoiceAgentSessionEvent,
} from "@eyeball/core";

const TERMINAL_STATES = new Set(["completed", "failed", "abandoned"]);

function transcriptTurn(
  event: VoiceAgentSessionEvent,
  previousEndMs: number,
): TranscriptTurn | undefined {
  const data = event.data;
  if (data.type === "turn.transcript") {
    return {
      id: data.turnId,
      speaker: data.speaker,
      startMs: data.startMs,
      endMs: data.endMs,
      text: data.text,
    };
  }
  if (data.type === "tool_call") {
    return {
      id: `tool_${event.id}`,
      speaker: "tool",
      startMs: previousEndMs,
      endMs: previousEndMs,
      text: JSON.stringify({ type: "tool_call", input: data.input }),
      executionId: data.executionId,
      tool: data.tool,
    };
  }
  if (data.type === "tool_result") {
    return {
      id: `tool_result_${event.id}`,
      speaker: "tool",
      startMs: previousEndMs,
      endMs: previousEndMs,
      text: JSON.stringify({
        type: "tool_result",
        ...(data.error === undefined
          ? { output: data.output }
          : { error: data.error }),
      }),
      executionId: data.executionId,
      tool: data.tool,
    };
  }
  return undefined;
}

/** Builds the canonical transcript from authoritative session state and history. */
export function voiceTranscriptFromEvents(
  agent: VoiceAgentDefinition,
  session: VoiceAgentSession,
  events: readonly VoiceAgentSessionEvent[],
): TranscriptArtifact {
  const turns: TranscriptTurn[] = [];
  let previousEndMs = 0;
  for (const event of [...events].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    const turn = transcriptTurn(event, previousEndMs);
    if (turn !== undefined) {
      turns.push(turn);
      previousEndMs = Math.max(previousEndMs, turn.endMs);
    }
  }
  return {
    id: `transcript_${session.id}`,
    sessionId: session.id,
    agentId: session.agentId,
    agentRevision: session.agentRevision,
    transport: session.transport,
    final: TERMINAL_STATES.has(session.state),
    ...(agent.voice.stt.language === undefined
      ? {}
      : { language: agent.voice.stt.language }),
    startedAt: session.startedAt ?? session.createdAt,
    ...(session.completedAt === undefined
      ? {}
      : { endedAt: session.completedAt }),
    turns,
  };
}
