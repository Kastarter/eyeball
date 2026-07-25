import { describe, expect, it } from "vitest";
import { createInProcessDevStack } from "./dev-stack.js";

describe("development stack", () => {
  it("runs the public starter Mockhouse, executor, and MCP gateway together", async () => {
    const stack = await createInProcessDevStack({ mockhouse: "starter" });
    const authorization = { Authorization: `Bearer ${stack.apiKey}` };

    const executorHealth = await stack.executorApp.request("/health");
    expect(executorHealth.status).toBe(200);
    await expect(executorHealth.json()).resolves.toEqual({
      status: "ok",
      service: "executor",
    });

    const gatewayHealth = await stack.mcpGatewayApp.request("/health");
    expect(gatewayHealth.status).toBe(200);
    await expect(gatewayHealth.json()).resolves.toEqual({
      status: "ok",
      service: "mcp-gateway",
    });

    const mockStatus = await stack.mockhouseApp.request("/_mock/status");
    const statusBody = (await mockStatus.json()) as { providers: string[] };
    expect(mockStatus.status).toBe(200);
    expect(statusBody.providers).toHaveLength(4);
    expect(statusBody.providers).toEqual(
      expect.arrayContaining(["echo", "github", "gmail", "slack"]),
    );
    expect(stack.providerCount).toBe(4);

    const execution = await stack.executorApp.request("/v1/execute", {
      method: "POST",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
        "Idempotency-Key": "dev-stack:gmail:send-email",
      },
      body: JSON.stringify({
        tool: "gmail.send_email",
        userId: stack.userId,
        input: {
          to: ["founder@example.com"],
          subject: "Eyeball dev stack",
          body: "Mockhouse, executor, and MCP are running together.",
        },
        mode: "sync",
      }),
    });
    const executionBody = (await execution.json()) as {
      status?: string;
      output?: { messageId?: string };
    };
    expect(execution.status).toBe(200);
    expect(executionBody).toMatchObject({
      status: "succeeded",
      output: { messageId: expect.stringMatching(/^gmail_msg_/) },
    });

    const listed = await stack.mcpGatewayApp.request("/mcp", {
      method: "POST",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "dev-stack-tools-list",
        method: "tools/list",
        params: {},
      }),
    });
    const listedBody = (await listed.json()) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    expect(listed.status).toBe(200);
    expect(listedBody.result?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "gmail.send_email" }),
      ]),
    );
  });

  it("runs the dashboard voice test call when the full Mockhouse is available", async () => {
    const stack = await createInProcessDevStack();
    if (!stack.mockhouseProviders.some(({ slug }) => slug === "pipecat")) {
      expect(stack.providerCount).toBe(4);
      return;
    }
    const authorization = { Authorization: `Bearer ${stack.apiKey}` };
    const execute = async (
      tool: string,
      input: Readonly<Record<string, unknown>>,
      mode: "sync" | "async",
      idempotencyKey: string,
    ) => {
      const response = await stack.executorApp.request("/v1/execute", {
        method: "POST",
        headers: {
          ...authorization,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          tool,
          userId: stack.userId,
          input,
          mode,
        }),
      });
      return {
        response,
        body: (await response.json()) as Readonly<Record<string, unknown>>,
      };
    };

    const connections = await stack.executorApp.request("/v1/connections", {
      headers: authorization,
    });
    const connectionBody = (await connections.json()) as {
      connections: Array<{
        connectionId: string;
        status: string;
        toolkit: string;
        userId: string;
      }>;
    };
    const twilioConnection = connectionBody.connections.find(
      (connection) =>
        connection.toolkit === "twilio" &&
        connection.userId === stack.userId &&
        connection.status === "connected",
    );
    expect(twilioConnection).toBeDefined();
    if (twilioConnection === undefined) {
      throw new Error(
        "Dev stack did not seed the demo user's Twilio connection.",
      );
    }

    const calendarInput = {
      calendarId: "primary",
      title: "Table for four — Sam",
      description:
        "Restaurant reservation created by the Table Host voice agent.",
      startTime: "2026-01-02T16:00:00.000Z",
      endTime: "2026-01-02T17:30:00.000Z",
      timeZone: "Asia/Riyadh",
      attendees: [{ email: "sam@example.com", displayName: "Sam" }],
    };
    const emailInput = {
      to: ["sam@example.com"],
      subject: "Your table is confirmed",
      body: "Your table for four is confirmed for tomorrow at 7:00 PM.",
    };
    const created = await execute(
      "voice-agents.create_voice_agent",
      {
        agent: {
          name: "Table Host",
          systemPrompt: "Reserve tables and email confirmed details.",
          llm: {
            model: "model:fixture:restaurant-concierge",
            temperature: 0.2,
            maxOutputTokens: 600,
          },
          voice: {
            tts: {
              provider: "elevenlabs",
              voiceId: "voice_fixture_warm_host",
              stability: 0.55,
            },
            stt: {
              provider: "deepgram",
              model: "nova-3",
              language: "en",
              smartFormat: true,
            },
          },
          transport: "pstn:twilio",
          tools: ["google-calendar.create_event", "gmail.send_email"],
          guardrails: {
            maxDurationSeconds: 300,
            handoffToHuman: { enabled: false },
          },
          webhooks: {
            endpointIds: [],
            transcript: true,
            events: [
              "session.lifecycle",
              "turn.transcript",
              "tool_call",
              "tool_result",
            ],
          },
          recordingPolicy: {
            mode: "audio_and_transcript",
            consent: "agent_announcement",
            retentionDays: 30,
            redactDtmf: true,
          },
        },
      },
      "sync",
      "dev-stack:voice:create-agent",
    );
    expect(created.response.status).toBe(200);
    expect(created.body.status).toBe("succeeded");
    const agent = (
      created.body.output as { agent: { id: string; revision: number } }
    ).agent;

    const started = await execute(
      "voice-agents.start_agent_call",
      {
        agentId: agent.id,
        revision: agent.revision,
        to: "+966500000111",
        from: "+966500000222",
        transportConnectionId: twilioConnection.connectionId,
        script: [
          {
            caller:
              "Tomorrow at 7, a table for four under Sam. Email sam@example.com.",
          },
          {
            expect_tool_call: "google-calendar.create_event",
            input: calendarInput,
          },
          { caller: "Please send the confirmation to sam@example.com." },
          { expect_tool_call: "gmail.send_email", input: emailInput },
        ],
      },
      "async",
      "dev-stack:voice:start-agent-call",
    );
    expect(started.response.status).toBe(202);
    expect(started.body.status).toBe("pending");
    await stack.executorEngine.queue.onIdle();

    const execution = await stack.executorApp.request(
      `/v1/executions/${String(started.body.executionId)}`,
      { headers: authorization },
    );
    const executionBody = (await execution.json()) as Readonly<
      Record<string, unknown>
    >;
    expect(executionBody.error).toBeUndefined();
    expect(executionBody).toMatchObject({
      status: "succeeded",
      output: {
        session: {
          state: "created",
          agentId: agent.id,
          agentRevision: agent.revision,
        },
      },
    });
    const sessionId = String(
      (
        executionBody.output as {
          session: { id: string };
        }
      ).session.id,
    );

    let terminal:
      | {
          state: string;
          terminal: boolean;
        }
      | undefined;
    for (let tick = 0; tick < 12 && terminal?.terminal !== true; tick += 1) {
      const advanced = await stack.executorApp.request(
        `/v1/dev/voice-sessions/${encodeURIComponent(sessionId)}/advance`,
        {
          method: "POST",
          headers: {
            ...authorization,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: stack.userId,
            milliseconds: 1_000,
          }),
        },
      );
      expect(advanced.status).toBe(200);
      terminal = (await advanced.json()) as {
        state: string;
        terminal: boolean;
      };
    }
    expect(terminal).toMatchObject({ state: "completed", terminal: true });

    const session = await execute(
      "voice-agents.get_agent_session",
      { sessionId, afterSequence: 0, eventLimit: 200 },
      "sync",
      "dev-stack:voice:get-session",
    );
    expect(session.body.status).toBe("succeeded");
    const sessionOutput = session.body.output as {
      session: { state: string };
      events: Array<{ data: { type: string } }>;
    };
    expect(sessionOutput.session.state).toBe("completed");
    expect(sessionOutput.events.map(({ data }) => data.type)).toEqual(
      expect.arrayContaining(["turn.transcript", "tool_call", "tool_result"]),
    );
    expect(JSON.stringify(sessionOutput.events)).not.toContain("auth_missing");

    const transcript = await execute(
      "voice-agents.get_session_transcript",
      { sessionId },
      "sync",
      "dev-stack:voice:get-transcript",
    );
    expect(transcript.body.status).toBe("succeeded");
    expect(transcript.body.output).toMatchObject({
      artifact: {
        final: true,
        turns: expect.arrayContaining([
          expect.objectContaining({ speaker: "human" }),
          expect.objectContaining({ speaker: "agent" }),
          expect.objectContaining({ speaker: "tool" }),
        ]),
      },
    });
  });
});
