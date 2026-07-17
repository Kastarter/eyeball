import {
  createExecutionId,
  type ExecutionId,
  type ExecutionRecord,
  type ExecutionResult,
  type JsonValue,
  MockCredentialProvider,
  type QualifiedToolName,
} from "@eyeball/core";
import {
  createMockApp,
  createMockClock,
} from "../../../mocks/packages/mock-kit/dist/index.js";
import { createGmailMock } from "../../../mocks/packages/mocks-email/dist/index.js";
import {
  createGoogleCalendarMock,
  googleCalendarFixtures,
} from "../../../mocks/packages/mocks-productivity/dist/index.js";
import { createPipecatMock } from "../../../mocks/packages/mocks-voice/dist/index.js";
import {
  defaultToolkitAdapters,
  runVoiceSessionDriver,
  VoiceAgentsAdapter,
} from "../../../packages/toolkits/src/index.js";
import { AdapterRegistry, ExecutionEngine } from "../../executor/src/index.js";

const API_PROJECT_ID = "proj_restaurant_demo";
const DINER_USER_ID = "diner_restaurant_demo";
const MOCK_ORIGIN = "http://mockhouse.restaurant.demo";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const calendarInput = {
  calendarId: "primary",
  title: "Table for four — Sam",
  description: "Restaurant reservation created by the Table Host voice agent.",
  startTime: "2026-01-02T16:00:00.000Z",
  endTime: "2026-01-02T17:30:00.000Z",
  timeZone: "Asia/Riyadh",
  attendees: [{ email: "sam@example.com", displayName: "Sam" }],
} as const satisfies Readonly<Record<string, JsonValue>>;

const emailInput = {
  to: ["sam@example.com"],
  subject: "Your table is confirmed",
  body: "Your table for four is confirmed for tomorrow at 7:00 PM.",
} as const satisfies Readonly<Record<string, JsonValue>>;

const tableHostDraft = {
  name: "Table Host",
  systemPrompt:
    "Book restaurant tables only after confirming date, time, party size, name, and email. Create the calendar event, email a concise confirmation, and never invent availability.",
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
    maxDurationSeconds: 600,
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
} as const;

function object(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function terminalOutput(
  execution: ExecutionResult | ExecutionRecord,
): Readonly<Record<string, unknown>> {
  if (execution.status !== "succeeded") {
    throw new Error(
      `Demo execution ${execution.executionId} did not succeed: ${JSON.stringify(execution)}`,
    );
  }
  return object(execution.output, `Execution ${execution.executionId} output`);
}

export interface RestaurantVoiceDemoResult {
  agent: { id: string; revision: number };
  session: { id: string; state: "completed" };
  childExecutions: readonly {
    executionId: ExecutionId;
    tool: QualifiedToolName;
    status: "succeeded";
  }[];
  calendarEventId: string;
  emailMessageId: string;
  transcript: Readonly<Record<string, unknown>>;
}

/** Runs the RFC 002 restaurant scenario entirely in-process with deterministic mocks. */
export async function runRestaurantVoiceDemo(): Promise<RestaurantVoiceDemoResult> {
  const clock = createMockClock();
  const pipecat = createPipecatMock({ clock });
  const calendar = createGoogleCalendarMock({ clock });
  const gmail = createGmailMock({ clock });
  await calendar.seed(googleCalendarFixtures.default);
  const mockhouse = createMockApp({ providers: [pipecat, calendar, gmail] });
  const mockFetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== MOCK_ORIGIN) {
      throw new Error(`Unexpected demo provider origin: ${request.url}`);
    }
    if (!request.headers.has("Authorization")) {
      request.headers.set("Authorization", "Bearer fixture:valid");
    }
    return mockhouse.request(request);
  }) as typeof fetch;
  const voiceAgents = new VoiceAgentsAdapter();
  let executionSequence = 0;
  const engine = new ExecutionEngine({
    adapters: new AdapterRegistry([
      ...defaultToolkitAdapters.filter(
        ({ toolkitSlug }) => toolkitSlug !== "voice-agents",
      ),
      voiceAgents,
    ]),
    credentialProvider: new MockCredentialProvider([
      {
        match: {
          projectId: API_PROJECT_ID,
          userId: DINER_USER_ID,
          toolkitSlug: "voice-agents",
        },
        credential: { type: "none" },
      },
      {
        match: {
          projectId: API_PROJECT_ID,
          userId: DINER_USER_ID,
          toolkitSlug: "google-calendar",
        },
        credential: { type: "oauth2", accessToken: "fixture:valid" },
      },
      {
        match: {
          projectId: API_PROJECT_ID,
          userId: DINER_USER_ID,
          toolkitSlug: "gmail",
        },
        credential: {
          type: "oauth2",
          accessToken: "fixture:valid",
          scopes: [GMAIL_SCOPE],
        },
      },
    ]),
    fetchImpl: mockFetch,
    clock,
    env: {
      EYEBALL_VOICE_AGENTS_BASE_URL: `${MOCK_ORIGIN}/pipecat`,
      EYEBALL_GOOGLE_CALENDAR_BASE_URL: `${MOCK_ORIGIN}/google-calendar`,
      EYEBALL_GMAIL_BASE_URL: `${MOCK_ORIGIN}/gmail`,
    },
    executionIdFactory: () => {
      executionSequence += 1;
      return createExecutionId(`restaurant_demo_${executionSequence}`);
    },
  });

  async function execute(
    tool: QualifiedToolName,
    input: Readonly<Record<string, JsonValue>>,
    mode: "sync" | "async",
    idempotencyKey?: string,
  ): Promise<ExecutionResult | ExecutionRecord> {
    const outcome = await engine.execute({
      projectId: API_PROJECT_ID,
      request: { tool, userId: DINER_USER_ID, input, mode },
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    if (
      outcome.response.status !== "pending" &&
      outcome.response.status !== "running"
    ) {
      return outcome.response;
    }
    await engine.queue.onIdle();
    return engine.getExecution(API_PROJECT_ID, outcome.response.executionId);
  }

  const created = terminalOutput(
    await execute(
      "voice-agents.create_voice_agent",
      { agent: tableHostDraft },
      "sync",
      "restaurant-demo:create-agent",
    ),
  );
  const agent = object(created.agent, "Created voice agent");
  const agentId = String(agent.id);
  const agentRevision = Number(agent.revision);

  const started = terminalOutput(
    await execute(
      "voice-agents.start_agent_call",
      {
        agentId,
        revision: agentRevision,
        to: "+966500000111",
        from: "+966500000222",
        transportConnectionId: "conn_twilio_restaurant_demo",
        script: [
          {
            caller:
              "Tomorrow at 7, a table for four under Sam. Email sam@example.com.",
          },
          {
            expect_tool_call: "google-calendar.create_event",
            input: calendarInput,
          },
          {
            caller: "Please send the confirmation to sam@example.com.",
          },
          { expect_tool_call: "gmail.send_email", input: emailInput },
        ],
      },
      "async",
      "restaurant-demo:start-call",
    ),
  );
  const allocatedSession = object(started.session, "Allocated session");
  const sessionId = String(allocatedSession.id);
  let modelTurn = 0;

  const driven = await runVoiceSessionDriver({
    sessionRef: { sessionId },
    agentRevision: {
      id: agentId,
      revision: agentRevision,
      projectId: API_PROJECT_ID,
      userId: DINER_USER_ID,
      tools: tableHostDraft.tools,
    },
    executionEngine: engine,
    pipecatBaseUrl: `${MOCK_ORIGIN}/pipecat`,
    fetch: mockFetch,
    clock: {
      now: () => clock.now(),
      advance: (milliseconds) => {
        clock.advance(milliseconds);
      },
    },
    turnHandler: {
      async respond() {
        modelTurn += 1;
        if (modelTurn === 1) {
          return {
            text: "I’ll reserve the table and then send your confirmation.",
            toolCall: {
              tool: "google-calendar.create_event",
              input: calendarInput,
            },
          };
        }
        if (modelTurn === 2) {
          return {
            text: "The table is reserved. I’ll email the confirmation now.",
            toolCall: { tool: "gmail.send_email", input: emailInput },
          };
        }
        throw new Error(
          "The scripted restaurant model received an extra turn.",
        );
      },
    },
    pollIntervalMs: 1_000,
    timeoutMs: 20_000,
  });
  if (driven.state !== "completed") {
    throw new Error(`Restaurant session ended as ${driven.state}.`);
  }

  const successfulDispatches = driven.dispatches.map(({ tool, result }) => {
    if (result.status !== "succeeded") {
      throw new Error(
        `Restaurant child tool ${tool} failed: ${JSON.stringify(result.error)}`,
      );
    }
    return { tool, result };
  });
  const childExecutions = await Promise.all(
    successfulDispatches.map(async ({ tool, result }) => {
      const execution = await engine.getExecution(
        API_PROJECT_ID,
        result.executionId,
      );
      if (execution.status !== "succeeded" || execution.tool !== tool) {
        throw new Error(
          `Child execution ${result.executionId} did not retain its tool identity.`,
        );
      }
      return {
        executionId: execution.executionId,
        tool: execution.tool,
        status: execution.status,
      } as const;
    }),
  );

  const calendarResult = successfulDispatches.find(
    ({ tool }) => tool === "google-calendar.create_event",
  )?.result;
  const emailResult = successfulDispatches.find(
    ({ tool }) => tool === "gmail.send_email",
  )?.result;
  if (
    calendarResult?.status !== "succeeded" ||
    emailResult?.status !== "succeeded"
  ) {
    throw new Error("Restaurant demo omitted a required child execution.");
  }
  const calendarOutput = object(calendarResult.output, "Calendar output");
  const calendarEvent = object(calendarOutput.event, "Calendar event");
  const emailOutput = object(emailResult.output, "Email output");

  const transcriptOutput = terminalOutput(
    await execute("voice-agents.get_session_transcript", { sessionId }, "sync"),
  );
  const transcript = object(transcriptOutput.artifact, "Transcript artifact");

  return {
    agent: { id: agentId, revision: agentRevision },
    session: { id: sessionId, state: "completed" },
    childExecutions,
    calendarEventId: String(calendarEvent.eventId),
    emailMessageId: String(emailOutput.messageId),
    transcript,
  };
}
