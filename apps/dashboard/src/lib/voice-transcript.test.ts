import { describe, expect, it } from "vitest";
import {
  projectTranscriptEvents,
  type VoiceSessionEvent,
} from "./voice-transcript";

function event(
  sequence: number,
  data: VoiceSessionEvent["data"],
): VoiceSessionEvent {
  return {
    id: `event_${sequence}`,
    sessionId: "session_demo",
    sequence,
    createdAt: `2026-07-17T09:00:0${sequence}.000Z`,
    data,
  };
}

describe("voice transcript projection", () => {
  it("orders turns and replaces interim text with the final turn", () => {
    const model = projectTranscriptEvents([
      event(3, {
        type: "turn.transcript",
        turnId: "turn_agent",
        speaker: "agent",
        text: "I can help.",
        final: true,
        startMs: 100,
        endMs: 220,
      }),
      event(1, {
        type: "turn.transcript",
        turnId: "turn_caller",
        speaker: "human",
        text: "Book a tab",
        final: false,
        startMs: 0,
        endMs: 60,
      }),
      event(2, {
        type: "turn.transcript",
        turnId: "turn_caller",
        speaker: "human",
        text: "Book a table for four.",
        final: true,
        startMs: 0,
        endMs: 90,
      }),
    ]);

    expect(model).toEqual([
      expect.objectContaining({
        kind: "turn",
        sequence: 1,
        speaker: "caller",
        text: "Book a table for four.",
        final: true,
      }),
      expect.objectContaining({
        kind: "turn",
        sequence: 3,
        speaker: "agent",
        text: "I can help.",
      }),
    ]);
  });

  it("pairs tool call and result chips by execution ID across poll pages", () => {
    const executionId = "exe_session_demo_0007";
    const model = projectTranscriptEvents([
      event(8, {
        type: "tool_result",
        turnId: "turn_agent",
        executionId,
        tool: "google-calendar.create_event",
        output: { event: { eventId: "evt_1" } },
      }),
      event(7, {
        type: "tool_call",
        turnId: "turn_agent",
        executionId,
        tool: "google-calendar.create_event",
        input: { calendarId: "primary" },
      }),
    ]);

    expect(model).toEqual([
      {
        key: `tool:${executionId}`,
        kind: "tool",
        sequence: 7,
        executionId,
        turnId: "turn_agent",
        tool: "google-calendar.create_event",
        input: { calendarId: "primary" },
        output: { event: { eventId: "evt_1" } },
      },
    ]);
  });
});
