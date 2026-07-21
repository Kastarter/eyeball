import { verifyWebhookSignature } from "@eyeball/core";
import { defaultToolkitAdapters, InMemoryAgentStore } from "@eyeball/toolkits";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createMockApp,
  createMockClock,
} from "../../../mocks/packages/mock-kit/dist/index.js";
import { createGmailMock } from "../../../mocks/packages/mocks-email/dist/index.js";
import { createPipecatMock } from "../../../mocks/packages/mocks-voice/dist/index.js";
import {
  AdapterRegistry,
  createExecutorApp,
  type DevVoiceSessionAdvancer,
  DevVoiceSessionRuntime,
  ExecutionEngine,
  InMemoryDevVault,
} from "../src/index.js";

const API_KEY = "ey_test_dev_voice";
const PROJECT_ID = "proj_dev_voice";
const USER_ID = "user_dev_voice";

function vault(): InMemoryDevVault {
  return new InMemoryDevVault({
    credentials: { "voice-agents": { type: "none" } },
  });
}

function post(
  app: ReturnType<typeof createExecutorApp>,
  body: unknown,
  sessionId = "session_demo",
): Promise<Response> {
  return app.request(`/v1/dev/voice-sessions/${sessionId}/advance`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("development voice-session route", () => {
  it("requires the development vault boundary", () => {
    const advancer: DevVoiceSessionAdvancer = {
      advance: vi.fn(),
    };
    expect(() =>
      createExecutorApp({
        apiKeys: { [API_KEY]: PROJECT_ID },
        devVoiceSessions: advancer,
      }),
    ).toThrow(
      "The development voice-session route requires the development vault.",
    );
  });

  it("is absent when no voice-session runtime is configured", async () => {
    const devVault = vault();
    const app = createExecutorApp({
      engine: new ExecutionEngine({ credentialProvider: devVault }),
      devVault,
      apiKeys: { [API_KEY]: PROJECT_ID },
    });

    expect((await post(app, { userId: USER_ID })).status).toBe(404);
  });

  it("validates input and advances one project-scoped driver tick", async () => {
    const devVault = vault();
    const advance = vi.fn(async () => ({
      sessionId: "session_demo",
      state: "in-progress" as const,
      lastSequence: 4,
      terminal: false,
      events: [],
      dispatches: [],
      agentTurns: [],
      advancedByMs: 1_500,
    }));
    const app = createExecutorApp({
      engine: new ExecutionEngine({ credentialProvider: devVault }),
      devVault,
      devVoiceSessions: { advance },
      apiKeys: { [API_KEY]: PROJECT_ID },
      requestIdFactory: () => "req_dev_voice",
    });

    const invalid = await post(app, { userId: USER_ID, milliseconds: 0 });
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "invalid_input" },
      requestId: "req_dev_voice",
    });

    const response = await post(app, {
      userId: USER_ID,
      milliseconds: 1_500,
      end: true,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: "session_demo",
      state: "in-progress",
      advancedByMs: 1_500,
    });
    expect(advance).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      userId: USER_ID,
      sessionId: "session_demo",
      milliseconds: 1_500,
      end: true,
    });
  });

  it("drives a Pipecat script through its tool call and terminal transcript", async () => {
    const origin = "http://mockhouse.dev-voice-route";
    const webhookOrigin = "https://voice-webhook.example.test";
    const clock = createMockClock();
    const pipecat = createPipecatMock({ clock });
    const gmail = createGmailMock({ clock });
    const mockhouse = createMockApp({ providers: [pipecat, gmail] });
    let webhookSecret = "";
    const webhookEvents: Array<{
      body: Readonly<Record<string, unknown>>;
      valid: boolean;
    }> = [];
    const receiver = new Hono();
    receiver.post("/events", async (context) => {
      const rawBody = await context.req.text();
      webhookEvents.push({
        body: JSON.parse(rawBody) as Readonly<Record<string, unknown>>,
        valid: verifyWebhookSignature({
          payload: rawBody,
          headers: context.req.raw.headers,
          secret: webhookSecret,
          now: clock.now(),
        }),
      });
      return context.body(null, 204);
    });
    const mockFetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === webhookOrigin) {
        return receiver.request(request);
      }
      if (new URL(request.url).origin !== origin) {
        throw new Error(`Unexpected mock provider origin: ${request.url}`);
      }
      if (!request.headers.has("Authorization")) {
        request.headers.set("Authorization", "Bearer fixture:valid");
      }
      return mockhouse.request(request);
    }) as typeof fetch;
    const devVault = new InMemoryDevVault({
      credentials: {
        gmail: {
          type: "oauth2",
          accessToken: "fixture:valid",
          scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        },
      },
    });
    await devVault.createConnection({
      projectId: PROJECT_ID,
      userId: USER_ID,
      toolkit: "gmail",
    });
    const engine = new ExecutionEngine({
      adapters: new AdapterRegistry(defaultToolkitAdapters),
      credentialProvider: devVault,
      fetchImpl: mockFetch,
      clock,
      env: { EYEBALL_GMAIL_BASE_URL: `${origin}/gmail` },
    });
    const webhookEndpoint = await engine.webhookDeliverer.endpointStore.create(
      PROJECT_ID,
      {
        url: `${webhookOrigin}/events`,
        events: ["voice.session.event"],
        active: true,
        createdAt: clock.now().toISOString(),
      },
    );
    webhookSecret = webhookEndpoint.secret;
    const agentStore = new InMemoryAgentStore();
    const agent = await agentStore.createAgent(
      PROJECT_ID,
      {
        name: "Table Host",
        systemPrompt: "Email the confirmed reservation details.",
        llm: { model: "model:fixture:restaurant-concierge" },
        voice: {
          tts: {
            provider: "elevenlabs",
            voiceId: "voice_fixture_warm_host",
          },
          stt: { provider: "deepgram", model: "nova-3" },
        },
        transport: "pstn:twilio",
        tools: ["gmail.send_email"],
        guardrails: {
          maxDurationSeconds: 300,
          handoffToHuman: { enabled: false },
        },
        webhooks: {
          endpointIds: [webhookEndpoint.endpointId],
          transcript: true,
          events: ["session.lifecycle"],
        },
        recordingPolicy: {
          mode: "audio_and_transcript",
          consent: "agent_announcement",
          retentionDays: 7,
          redactDtmf: true,
        },
      },
      clock.now().toISOString(),
    );
    const emailInput = {
      to: ["sam@example.com"],
      subject: "Your table is confirmed",
      body: "Your table for four is confirmed for tomorrow at 7:00 PM.",
    };
    const created = await mockFetch(`${origin}/pipecat/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentConfig: {
          projectId: PROJECT_ID,
          userId: USER_ID,
          agentId: agent.id,
          agentRevision: agent.revision,
          transport: "pstn:twilio",
        },
        script: [
          { caller: "Please send the confirmation to sam@example.com." },
          {
            expect_tool_call: "gmail.send_email",
            input: emailInput,
          },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string; createdAt: string };
    await agentStore.rememberSession({
      sessionId: session.id,
      projectId: PROJECT_ID,
      userId: USER_ID,
      agentId: agent.id,
      agentRevision: agent.revision,
      callId: `call_${session.id}`,
      createdAt: session.createdAt,
    });
    const runtime = new DevVoiceSessionRuntime({
      engine,
      agentStore,
      pipecatBaseUrl: `${origin}/pipecat`,
      clock: {
        now: () => clock.now(),
        advance: (milliseconds) => clock.advance(milliseconds),
      },
      fetch: mockFetch,
    });
    const app = createExecutorApp({
      engine,
      devVault,
      devVoiceSessions: runtime,
      apiKeys: { [API_KEY]: PROJECT_ID },
    });

    let terminal = false;
    for (let tick = 0; tick < 10 && !terminal; tick += 1) {
      const response = await post(
        app,
        { userId: USER_ID, milliseconds: 1_000 },
        session.id,
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as { terminal: boolean };
      terminal = result.terminal;
    }
    expect(terminal).toBe(true);
    await engine.webhookDeliverer.onIdle();

    const eventsResponse = await mockFetch(
      `${origin}/pipecat/sessions/${session.id}/events?afterSequence=0&limit=200`,
    );
    const eventsPage = (await eventsResponse.json()) as {
      events: Array<{ data: Readonly<Record<string, unknown>> }>;
    };
    expect(eventsPage.events.map(({ data }) => data.type)).toEqual(
      expect.arrayContaining(["turn.transcript", "tool_call", "tool_result"]),
    );
    const executions = await engine.listExecutions(PROJECT_ID, { limit: 20 });
    expect(executions.executions).toEqual([
      expect.objectContaining({
        tool: "gmail.send_email",
        status: "succeeded",
      }),
    ]);
    expect(webhookEvents.length).toBeGreaterThan(0);
    expect(webhookEvents.every(({ valid }) => valid)).toBe(true);
    expect(
      webhookEvents.some(({ body }) => {
        const event = body.data as
          | {
              data?: { type?: string; to?: string };
            }
          | undefined;
        return (
          body.type === "voice.session.event" &&
          event?.data?.type === "session.lifecycle" &&
          ["completed", "failed", "abandoned"].includes(event.data.to ?? "")
        );
      }),
    ).toBe(true);
  });
});
