import {
  isVoiceSessionExecutionIdForSession,
  type QualifiedToolName,
  voiceSessionExecutionId,
} from "@eyeball/core";
import { describe, expect, it, vi } from "vitest";
import { createPipecatMock } from "../../../../mocks/packages/mocks-voice/dist/index.js";
import {
  dispatchVoiceSessionToolCall,
  runVoiceSessionDriver,
  runVoiceSessionDriverTick,
  type VoiceSessionExecutionEngine,
  voiceSessionIdempotencyKey,
  voiceSessionToolNotAllowedError,
} from "../../src/voice/session-driver.js";

const PROJECT_ID = "proj_session_driver";
const USER_ID = "user_session_driver";
const AGENT_ID = "va_session_driver";
const DISALLOWED_TOOL = "stripe.create_refund" as QualifiedToolName;
const PIPECAT_HEADERS = {
  Authorization: "Bearer fixture:valid",
  "Content-Type": "application/json",
} as const;

function pipecatFetch(
  provider: ReturnType<typeof createPipecatMock>,
): typeof globalThis.fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    request.headers.set("Authorization", "Bearer fixture:valid");
    return provider.app.request(request);
  }) as typeof fetch;
}

async function createPendingToolCall(
  provider: ReturnType<typeof createPipecatMock>,
): Promise<{ sessionId: string; toolCallSequence: number }> {
  const created = await provider.app.request("/sessions", {
    method: "POST",
    headers: PIPECAT_HEADERS,
    body: JSON.stringify({
      agentConfig: {
        projectId: PROJECT_ID,
        userId: USER_ID,
        agentId: AGENT_ID,
        agentRevision: 3,
        transport: "pstn:twilio",
      },
      script: [
        { caller: "Please refund my last payment." },
        {
          expect_tool_call: DISALLOWED_TOOL,
          input: { paymentId: "payment_fixture" },
          error: voiceSessionToolNotAllowedError(DISALLOWED_TOOL),
        },
      ],
    }),
  });
  const session = (await created.json()) as { id: string };
  provider.advanceClock(2_000);
  const turn = await provider.app.request(
    `/sessions/${encodeURIComponent(session.id)}/turns`,
    {
      method: "POST",
      headers: PIPECAT_HEADERS,
      body: JSON.stringify({ text: "I will check that request." }),
    },
  );
  expect(turn.status).toBe(200);
  const eventsResponse = await provider.app.request(
    `/sessions/${encodeURIComponent(session.id)}/events?afterSequence=0&limit=200`,
    { headers: { Authorization: PIPECAT_HEADERS.Authorization } },
  );
  const page = (await eventsResponse.json()) as {
    events: Array<{
      sequence: number;
      data: Readonly<Record<string, unknown>>;
    }>;
  };
  const toolCallSequence = page.events.find(
    ({ data }) => data.type === "tool_call",
  )?.sequence;
  if (toolCallSequence === undefined) {
    throw new Error("The Pipecat fixture omitted its pending tool-call event.");
  }
  return { sessionId: session.id, toolCallSequence };
}

describe("voice session tool dispatch", () => {
  it("runs one bounded turn per development-driver tick", async () => {
    const provider = createPipecatMock();
    const created = await provider.app.request("/sessions", {
      method: "POST",
      headers: PIPECAT_HEADERS,
      body: JSON.stringify({
        agentConfig: {
          projectId: PROJECT_ID,
          userId: USER_ID,
          agentId: AGENT_ID,
          agentRevision: 3,
          transport: "chat",
        },
        script: [{ caller: "Hello from the dashboard." }],
      }),
    });
    const session = (await created.json()) as { id: string };
    provider.advanceClock(2_000);
    const execute = vi.fn();

    const first = await runVoiceSessionDriverTick({
      sessionRef: { sessionId: session.id },
      agentRevision: {
        id: AGENT_ID,
        revision: 3,
        projectId: PROJECT_ID,
        userId: USER_ID,
        tools: [],
      },
      executionEngine: { execute } as VoiceSessionExecutionEngine,
      pipecatBaseUrl: "http://pipecat.test",
      fetch: pipecatFetch(provider),
      turnHandler: {
        async respond({ humanTurn }) {
          return { text: `Reply to: ${humanTurn.text}` };
        },
      },
    });

    expect(first).toMatchObject({
      sessionId: session.id,
      state: "in-progress",
      terminal: false,
      agentTurns: [{ text: "Reply to: Hello from the dashboard." }],
    });
    expect(execute).not.toHaveBeenCalled();

    provider.advanceClock(2_000);
    const second = await runVoiceSessionDriverTick({
      sessionRef: {
        sessionId: session.id,
        afterSequence: first.lastSequence,
      },
      agentRevision: {
        id: AGENT_ID,
        revision: 3,
        projectId: PROJECT_ID,
        userId: USER_ID,
        tools: [],
      },
      executionEngine: { execute } as VoiceSessionExecutionEngine,
      pipecatBaseUrl: "http://pipecat.test",
      fetch: pipecatFetch(provider),
    });
    expect(second).toMatchObject({ state: "completed", terminal: true });
    expect(second.lastSequence).toBeGreaterThan(first.lastSequence);
  });

  it("resumes and rejects a disallowed durable tool call without executing it", async () => {
    const provider = createPipecatMock();
    const { sessionId, toolCallSequence } =
      await createPendingToolCall(provider);
    const execute = vi.fn(async () => {
      throw new Error("A disallowed tool must never reach the executor.");
    });

    const completed = await runVoiceSessionDriver({
      sessionRef: { sessionId, afterSequence: toolCallSequence },
      agentRevision: {
        id: AGENT_ID,
        revision: 3,
        projectId: PROJECT_ID,
        userId: USER_ID,
        tools: ["gmail.send_email"],
      },
      executionEngine: { execute } as VoiceSessionExecutionEngine,
      pipecatBaseUrl: "http://pipecat.test",
      fetch: pipecatFetch(provider),
      clock: {
        now: () => provider.clock.now(),
        advance(milliseconds) {
          provider.advanceClock(milliseconds);
        },
      },
      pollIntervalMs: 1_000,
      timeoutMs: 10_000,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(completed).toMatchObject({
      sessionId,
      state: "completed",
      dispatches: [
        {
          tool: DISALLOWED_TOOL,
          result: {
            status: "failed",
            error: voiceSessionToolNotAllowedError(DISALLOWED_TOOL),
          },
        },
      ],
    });

    const eventResponse = await provider.app.request(
      `/sessions/${encodeURIComponent(sessionId)}/events?afterSequence=0&limit=200`,
      { headers: { Authorization: PIPECAT_HEADERS.Authorization } },
    );
    const page = (await eventResponse.json()) as {
      events: Array<{ data: Readonly<Record<string, unknown>> }>;
    };
    expect(
      page.events.find(({ data }) => data.type === "tool_result")?.data,
    ).toMatchObject({
      type: "tool_result",
      tool: DISALLOWED_TOOL,
      error: voiceSessionToolNotAllowedError(DISALLOWED_TOOL),
    });
  });

  it("pins trusted scope and derives idempotency from session event identity", async () => {
    const eventExecutionId = voiceSessionExecutionId(
      "session_dispatch",
      "event:7",
    );
    const execute = vi.fn(async () => ({
      response: {
        executionId: eventExecutionId,
        tool: "gmail.send_email" as QualifiedToolName,
        status: "succeeded" as const,
        output: { messageId: "msg_voice_child" },
      },
    }));

    await expect(
      dispatchVoiceSessionToolCall({
        agentRevision: {
          id: AGENT_ID,
          revision: 3,
          projectId: PROJECT_ID,
          userId: USER_ID,
          tools: ["gmail.send_email"],
        },
        toolCall: {
          sessionId: "session_dispatch",
          sequence: 7,
          eventExecutionId,
          tool: "gmail.send_email",
          input: {
            to: ["guest@example.com"],
            subject: "Reservation confirmed",
            body: "Your table is booked.",
          },
        },
        executionEngine: { execute },
      }),
    ).resolves.toEqual({
      status: "succeeded",
      executionId: eventExecutionId,
      output: { messageId: "msg_voice_child" },
    });
    expect(execute).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      executionId: eventExecutionId,
      source: { kind: "voice_session", sessionId: "session_dispatch" },
      request: {
        tool: "gmail.send_email",
        userId: USER_ID,
        input: {
          to: ["guest@example.com"],
          subject: "Reservation confirmed",
          body: "Your table is booked.",
        },
        mode: "sync",
      },
      idempotencyKey: voiceSessionIdempotencyKey("session_dispatch", 7),
    });
    expect(
      isVoiceSessionExecutionIdForSession(eventExecutionId, "session_dispatch"),
    ).toBe(true);
  });
});
