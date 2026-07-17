import { describe, expect, it } from "vitest";
import { runRestaurantVoiceDemo } from "../demo/restaurant.js";

describe("restaurant voice-agent E2E", () => {
  it("dispatches calendar and email tools through the ordinary executor", async () => {
    const result = await runRestaurantVoiceDemo();

    expect(result).toMatchObject({
      agent: { id: "va_000001", revision: 1 },
      session: { id: "session_000001", state: "completed" },
      calendarEventId: "gcal_event_000003",
      emailMessageId: "gmail_msg_000001",
    });
    expect(result.childExecutions).toEqual([
      {
        executionId: "exe_session_000001_0006",
        tool: "google-calendar.create_event",
        status: "succeeded",
      },
      {
        executionId: "exe_session_000001_0010",
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
      "exe_session_000001_0006",
      "exe_session_000001_0006",
      "exe_session_000001_0010",
      "exe_session_000001_0010",
    ]);
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
