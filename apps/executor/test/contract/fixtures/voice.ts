import { defineCapabilityFixtures } from "../fixtures.js";

const agentDraft = {
  name: "Contract reservation host",
  systemPrompt: "Help callers reserve a table and confirm every detail.",
  llm: { model: "model:fixture:concierge", temperature: 0.2 },
  voice: {
    tts: {
      provider: "elevenlabs",
      voiceId: "voice_fixture_aria",
      stability: 0.6,
    },
    stt: {
      provider: "deepgram",
      model: "nova-3",
      language: "en",
      smartFormat: true,
    },
  },
  transport: "pstn:twilio",
  tools: ["crm.search_contacts"],
  guardrails: { maxDurationSeconds: 300, handoffToHuman: { enabled: false } },
  webhooks: {
    endpointIds: [],
    transcript: true,
    events: ["session.lifecycle", "turn.transcript", "tool_call"],
  },
  recordingPolicy: {
    mode: "audio_and_transcript",
    consent: "agent_announcement",
    retentionDays: 30,
    redactDtmf: true,
  },
} as const;

export const voiceFixtures = defineCapabilityFixtures("voice_telephony", {
  attach_agent_to_number: {
    dependencies: ["create_voice_agent", "buy_number"],
    input: (context) => ({
      agentId: context.field("create_voice_agent", "agent", "id"),
      revision: 1,
      phoneNumber: context.field("buy_number", "number", "phoneNumber"),
      transportConnectionId: "conn_twilio_fixture",
    }),
  },
  buy_number: {
    input: {
      phoneNumber: "+15550002222",
      friendlyName: "Contract fixture line",
      transportConnectionId: "conn_twilio_fixture",
    },
  },
  create_room: { input: { roomName: "contract-fixture-room" } },
  create_web_session: {
    dependencies: ["update_voice_agent"],
    mode: "async",
    input: (context) => ({
      agentId: context.field("update_voice_agent", "agent", "id"),
      revision: 2,
      transportConnectionId: "conn_livekit_fixture",
      participantIdentity: "contract-web-participant",
      participantName: "Contract Web Participant",
      script: [{ caller: "Hello from the browser client." }],
    }),
    after: (context) => context.advanceClock(2_000),
  },
  create_voice_agent: { input: { agent: agentDraft } },
  delete_voice_agent: {
    dependencies: ["create_voice_agent"],
    input: (context) => ({
      agentId: context.field("create_voice_agent", "agent", "id"),
      expectedRevision: 1,
    }),
  },
  detach_number: {
    dependencies: ["attach_agent_to_number"],
    input: { phoneNumber: "+15550002222" },
  },
  end_call: {
    dependencies: ["start_call"],
    input: (context) => ({ callId: context.field("start_call", "callId") }),
  },
  get_agent_session: {
    dependencies: ["start_agent_call"],
    input: (context) => ({
      sessionId: context.field("start_agent_call", "session", "id"),
    }),
  },
  get_call: {
    dependencies: ["start_call"],
    input: (context) => ({ callId: context.field("start_call", "callId") }),
  },
  get_session_transcript: {
    dependencies: ["start_agent_call"],
    input: (context) => ({
      sessionId: context.field("start_agent_call", "session", "id"),
      includePartial: true,
    }),
  },
  get_voice_agent: {
    dependencies: ["create_voice_agent"],
    input: (context) => ({
      agentId: context.field("create_voice_agent", "agent", "id"),
      revision: 1,
    }),
  },
  get_voice_pipeline: {
    dependencies: ["start_voice_pipeline"],
    input: (context) => ({
      pipelineId: context.field(
        "start_voice_pipeline",
        "pipeline",
        "pipelineId",
      ),
    }),
  },
  join_room: {
    dependencies: ["create_room"],
    input: {
      roomName: "contract-fixture-room",
      participantIdentity: "contract-participant",
      participantName: "Contract Participant",
    },
  },
  list_agent_sessions: {
    dependencies: ["start_agent_call"],
    input: (context) => ({
      agentId: context.field("create_voice_agent", "agent", "id"),
      limit: 10,
    }),
  },
  list_calls: { input: { pageSize: 10 } },
  list_numbers: {
    dependencies: ["buy_number"],
    input: {
      transportConnectionId: "conn_twilio_fixture",
      pageSize: 10,
    },
  },
  list_voice_agents: { input: { limit: 10 } },
  send_dtmf: {
    dependencies: ["start_call"],
    input: (context) => ({
      callId: context.field("start_call", "callId"),
      digits: "12#",
    }),
  },
  send_session_message: {
    dependencies: ["start_agent_call"],
    input: (context) => ({
      agentId: context.field("create_voice_agent", "agent", "id"),
      revision: 1,
      sessionId: context.field("start_agent_call", "session", "id"),
      message: "Canonical contract session message.",
      clientMessageId: "contract-client-message-1",
    }),
  },
  release_number: {
    dependencies: ["buy_number"],
    input: {
      phoneNumber: "+15550002222",
      transportConnectionId: "conn_twilio_fixture",
    },
  },
  start_agent_call: {
    dependencies: ["attach_agent_to_number"],
    mode: "async",
    input: (context) => ({
      agentId: context.field("create_voice_agent", "agent", "id"),
      revision: 1,
      to: "+15550001111",
      from: "+15550002222",
      transportConnectionId: "conn_twilio_fixture",
      script: [{ caller: "I need a table for two tonight." }],
    }),
    after: (context) => context.advanceClock(2_000),
  },
  start_call: {
    mode: "async",
    input: { to: "+15550001111", from: "+15550002222" },
    after: (context) => context.advanceClock(1_100),
  },
  start_voice_pipeline: {
    mode: "async",
    input: {
      agentConfig: {
        agentId: "agent_contract_host",
        agentRevision: 1,
        transport: "pstn:twilio",
      },
    },
    after: (context) => context.advanceClock(2_000),
  },
  stop_agent_session: {
    dependencies: ["create_web_session"],
    input: (context) => ({
      sessionId: context.field("create_web_session", "session", "id"),
      reason: "Contract fixture complete.",
    }),
  },
  synthesize_speech: {
    input: {
      text: "Hello from the contract fixture.",
      voiceId: "voice_fixture_aria",
    },
  },
  transcribe_audio: {
    input: {
      audioRef: "fixture:audio:hello",
      language: "en",
      smartFormat: true,
    },
  },
  transfer_call: {
    dependencies: ["start_call"],
    input: (context) => ({
      callId: context.field("start_call", "callId"),
      to: "+15550003333",
    }),
  },
  update_voice_agent: {
    dependencies: ["create_voice_agent"],
    input: (context) => ({
      agentId: context.field("create_voice_agent", "agent", "id"),
      expectedRevision: 1,
      agent: {
        ...agentDraft,
        systemPrompt: "Help callers reserve a table and verify every detail.",
        transport: "webrtc:livekit",
      },
    }),
  },
});
