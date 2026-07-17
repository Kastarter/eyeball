import type { JsonValue } from "./api";

export type VoiceSessionEventData =
  | {
      type: "session.lifecycle";
      from?: string;
      to: string;
    }
  | {
      type: "turn.transcript";
      turnId: string;
      speaker: "agent" | "human";
      text: string;
      final: boolean;
      startMs: number;
      endMs: number;
    }
  | {
      type: "tool_call";
      turnId: string;
      executionId: string;
      tool: string;
      input: Readonly<Record<string, JsonValue>>;
    }
  | {
      type: "tool_result";
      turnId: string;
      executionId: string;
      tool: string;
      output?: JsonValue;
      error?: Readonly<Record<string, JsonValue>>;
    }
  | { type: string; readonly [key: string]: unknown };

export interface VoiceSessionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  createdAt: string;
  data: VoiceSessionEventData;
}

export interface TranscriptTurnItem {
  key: string;
  kind: "turn";
  sequence: number;
  turnId: string;
  speaker: "agent" | "caller";
  text: string;
  final: boolean;
}

export interface TranscriptToolItem {
  key: string;
  kind: "tool";
  sequence: number;
  executionId: string;
  turnId: string;
  tool: string;
  input?: Readonly<Record<string, JsonValue>>;
  output?: JsonValue;
  error?: Readonly<Record<string, JsonValue>>;
}

export type TranscriptUiItem = TranscriptTurnItem | TranscriptToolItem;

/**
 * Projects the append-only event log into ordered UI items. Interim transcript
 * events collapse into one turn, while tool results join calls by execution ID
 * even when the result arrives in a later poll page.
 */
export function projectTranscriptEvents(
  events: readonly VoiceSessionEvent[],
): readonly TranscriptUiItem[] {
  const turns = new Map<string, TranscriptTurnItem>();
  const tools = new Map<string, TranscriptToolItem>();
  const ordered = [...events].sort(
    (left, right) =>
      left.sequence - right.sequence || left.id.localeCompare(right.id),
  );

  for (const event of ordered) {
    const data = event.data;
    if (data.type === "turn.transcript") {
      const turn = data as Extract<
        VoiceSessionEventData,
        { type: "turn.transcript" }
      >;
      const key = `${turn.speaker}:${turn.turnId}`;
      const previous = turns.get(key);
      if (previous?.final === true && turn.final === false) continue;
      turns.set(key, {
        key: `turn:${key}`,
        kind: "turn",
        sequence: previous?.sequence ?? event.sequence,
        turnId: turn.turnId,
        speaker: turn.speaker === "human" ? "caller" : "agent",
        text: turn.text,
        final: turn.final,
      });
      continue;
    }
    if (data.type === "tool_call") {
      const call = data as Extract<
        VoiceSessionEventData,
        { type: "tool_call" }
      >;
      const previous = tools.get(call.executionId);
      tools.set(call.executionId, {
        ...previous,
        key: `tool:${call.executionId}`,
        kind: "tool",
        sequence: Math.min(
          previous?.sequence ?? event.sequence,
          event.sequence,
        ),
        executionId: call.executionId,
        turnId: call.turnId,
        tool: call.tool,
        input: call.input,
      });
      continue;
    }
    if (data.type === "tool_result") {
      const result = data as Extract<
        VoiceSessionEventData,
        { type: "tool_result" }
      >;
      const previous = tools.get(result.executionId);
      tools.set(result.executionId, {
        ...previous,
        key: `tool:${result.executionId}`,
        kind: "tool",
        sequence: Math.min(
          previous?.sequence ?? event.sequence,
          event.sequence,
        ),
        executionId: result.executionId,
        turnId: previous?.turnId ?? result.turnId,
        tool: previous?.tool ?? result.tool,
        ...(Object.hasOwn(result, "output") ? { output: result.output } : {}),
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    }
  }

  return [...turns.values(), ...tools.values()].sort(
    (left, right) =>
      left.sequence - right.sequence || left.key.localeCompare(right.key),
  );
}
