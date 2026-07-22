import { describe, expect, it, vi } from "vitest";
import type { ExecuteToolRequest, ExecuteToolResponse, JsonValue } from "./api";
import {
  hydrateVoiceSessionLink,
  parseVoiceSessionLink,
  voiceSessionHref,
} from "./voice-session-link";

function succeeded(
  sequence: number,
  tool: string,
  output: JsonValue,
): ExecuteToolResponse {
  return {
    catalogVersion: "2026.07.21",
    executionId: `exe_voice_link_${sequence}`,
    latencyMs: 1,
    output,
    status: "succeeded",
    tool,
    toolVersion: "1.0.0",
  };
}

describe("voice session deep links", () => {
  it("encodes project, session, and execution user values", () => {
    expect(
      voiceSessionHref("project / north", "session/+ one", "user & one"),
    ).toBe(
      "/project%20%2F%20north/voice-agents?session=session%2F%2B+one&userId=user+%26+one",
    );
  });

  it("requires session and userId as a complete non-empty pair", () => {
    expect(parseVoiceSessionLink("session_1", "user_1")).toEqual({
      sessionId: "session_1",
      userId: "user_1",
    });
    expect(parseVoiceSessionLink("session_1", undefined)).toBeUndefined();
    expect(parseVoiceSessionLink(undefined, "user_1")).toBeUndefined();
    expect(parseVoiceSessionLink(" ", "user_1")).toBeUndefined();
    expect(parseVoiceSessionLink("session_1", " ")).toBeUndefined();
  });

  it("hydrates the exact project/user session and trusts its agent provenance", async () => {
    const calls: ExecuteToolRequest[] = [];
    const projects: string[] = [];
    const client = {
      async execute(request: ExecuteToolRequest): Promise<ExecuteToolResponse> {
        calls.push(request);
        if (request.tool === "voice-agents.get_agent_session") {
          return succeeded(calls.length, request.tool, {
            events: [{ sequence: 1, type: "session.created" }],
            session: {
              id: "session_linked",
              projectId: "project linked",
              userId: "execution_user",
              agentId: "vag_from_session",
              agentRevision: 7,
            },
          });
        }
        if (request.tool === "voice-agents.get_session_transcript") {
          return succeeded(calls.length, request.tool, {
            artifact: { id: "transcript_linked", final: true, turns: [] },
          });
        }
        return succeeded(calls.length, request.tool, {
          agent: { id: "vag_from_session", revision: 7, name: "Linked agent" },
        });
      },
      async getExecution(): Promise<never> {
        throw new Error("sync fixture should not poll");
      },
    };

    await expect(
      hydrateVoiceSessionLink(
        {
          project: "project linked",
          sessionId: "session_linked",
          userId: "execution_user",
        },
        (project) => {
          projects.push(project);
          return client;
        },
      ),
    ).resolves.toMatchObject({
      agent: { id: "vag_from_session", revision: 7 },
      artifact: { id: "transcript_linked" },
      events: [{ sequence: 1 }],
      session: { id: "session_linked", userId: "execution_user" },
    });

    expect(projects).toEqual(["project linked"]);
    expect(
      calls.map(({ tool, userId, input }) => ({ tool, userId, input })),
    ).toEqual([
      {
        tool: "voice-agents.get_agent_session",
        userId: "execution_user",
        input: {
          afterSequence: 0,
          eventLimit: 200,
          sessionId: "session_linked",
        },
      },
      {
        tool: "voice-agents.get_session_transcript",
        userId: "execution_user",
        input: { sessionId: "session_linked" },
      },
      {
        tool: "voice-agents.get_voice_agent",
        userId: "execution_user",
        input: { agentId: "vag_from_session", revision: 7 },
      },
    ]);
  });

  it("surfaces project, user, and session mismatches without falling back", async () => {
    const calls: string[] = [];
    const client = {
      async execute(request: ExecuteToolRequest): Promise<ExecuteToolResponse> {
        calls.push(request.tool);
        if (request.tool === "voice-agents.get_agent_session") {
          return succeeded(calls.length, request.tool, {
            events: [],
            session: {
              id: "session_other",
              projectId: "project_other",
              userId: "user_other",
              agentId: "vag_other",
              agentRevision: 1,
            },
          });
        }
        return succeeded(calls.length, request.tool, { artifact: null });
      },
      async getExecution(): Promise<never> {
        throw new Error("sync fixture should not poll");
      },
    };

    await expect(
      hydrateVoiceSessionLink(
        {
          project: "project_expected",
          sessionId: "session_expected",
          userId: "user_expected",
        },
        () => client,
      ),
    ).rejects.toThrow("does not match the requested execution source");
    expect(calls).toEqual([
      "voice-agents.get_agent_session",
      "voice-agents.get_session_transcript",
    ]);
  });

  it("stops immediately and surfaces a structured cancelled execution", async () => {
    const getExecution = vi.fn(async () => {
      throw new Error("cancelled sync work must not be polled");
    });
    const client = {
      async execute(request: ExecuteToolRequest): Promise<ExecuteToolResponse> {
        return {
          catalogVersion: "2026.07.21",
          executionId: `exe_cancelled_${request.tool}`,
          latencyMs: 1,
          status: "cancelled",
          tool: request.tool,
          toolVersion: "1.0.0",
          error: {
            code: "execution_cancelled",
            message: "Execution was cancelled before provider dispatch.",
            retryable: false,
          },
          cancellation: { dispatchMayHaveBegun: false },
        };
      },
      getExecution,
    };

    await expect(
      hydrateVoiceSessionLink(
        {
          project: "project_cancelled",
          sessionId: "session_cancelled",
          userId: "user_cancelled",
        },
        () => client,
      ),
    ).rejects.toThrow(
      "execution_cancelled: Execution was cancelled before provider dispatch.",
    );
    expect(getExecution).not.toHaveBeenCalled();
  });
});
