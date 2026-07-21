import { voiceSessionExecutionId } from "@eyeball/core";
import { describe, expect, it } from "vitest";
import { runRestaurantVoiceDemo } from "../demo/restaurant.js";

describe("restaurant voice-agent E2E", () => {
  it("dispatches calendar and email tools through the ordinary executor", async () => {
    const result = await runRestaurantVoiceDemo();
    const calendarExecutionId = voiceSessionExecutionId(
      result.session.id,
      "event:6",
    );
    const emailExecutionId = voiceSessionExecutionId(
      result.session.id,
      "event:10",
    );

    expect(result).toMatchObject({
      agent: { id: "va_000001", revision: 1 },
      session: { id: "session_000001", state: "completed" },
      calendarEventId: "gcal_event_000003",
      emailMessageId: "gmail_msg_000001",
    });
    expect(result.childExecutions).toEqual([
      {
        executionId: calendarExecutionId,
        tool: "google-calendar.create_event",
        status: "succeeded",
      },
      {
        executionId: emailExecutionId,
        tool: "gmail.send_email",
        status: "succeeded",
      },
    ]);
    expect(result.transcript).toMatchObject({
      id: "transcript_session_000001",
      final: true,
      agentId: "va_000001",
      agentRevision: 1,
    });

    const turns = result.transcript.turns;
    expect(Array.isArray(turns)).toBe(true);
    const toolTurns = (turns as Array<Record<string, unknown>>).filter(
      ({ speaker }) => speaker === "tool",
    );
    expect(toolTurns.map(({ executionId }) => executionId)).toEqual([
      calendarExecutionId,
      calendarExecutionId,
      emailExecutionId,
      emailExecutionId,
    ]);
    const storedExecutionIds = new Set<string>(
      result.childExecutions.map(({ executionId }) => executionId),
    );
    expect(
      toolTurns.every(({ executionId }) =>
        storedExecutionIds.has(String(executionId)),
      ),
    ).toBe(true);
    expect(toolTurns.map(({ tool }) => tool)).toEqual([
      "google-calendar.create_event",
      "google-calendar.create_event",
      "gmail.send_email",
      "gmail.send_email",
    ]);
    expect(
      toolTurns.map(
        ({ text }) =>
          JSON.parse(String(text)) as Readonly<Record<string, unknown>>,
      ),
    ).toEqual([
      expect.objectContaining({ type: "tool_call" }),
      expect.objectContaining({ type: "tool_result" }),
      expect.objectContaining({ type: "tool_call" }),
      expect.objectContaining({ type: "tool_result" }),
    ]);
  });
});
