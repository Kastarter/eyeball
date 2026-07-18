import type {
  CapabilityToolContract,
  JSONSchema202012,
  JSONSchemaObject202012,
  ObjectSchema202012,
} from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "voice_telephony" as const;
const VERSION = "1.0.0" as const;

function identifier(description: string): JSONSchema202012 {
  return { type: "string", description, minLength: 1 };
}

function e164(description: string): JSONSchema202012 {
  return {
    type: "string",
    description,
    pattern: "^\\+[1-9][0-9]{7,14}$",
  };
}

function timestamp(description: string): JSONSchema202012 {
  return { type: "string", description, format: "date-time" };
}

function callState(): JSONSchema202012 {
  return {
    type: "string",
    description: "Normalized provider call lifecycle state.",
    enum: [
      "queued",
      "ringing",
      "in-progress",
      "completed",
      "busy",
      "no-answer",
      "failed",
      "canceled",
    ],
  };
}

function callRecord(): JSONSchemaObject202012 {
  return {
    type: "object",
    description: "Normalized state and timing for one provider call.",
    additionalProperties: false,
    required: [
      "callId",
      "state",
      "to",
      "from",
      "direction",
      "createdAt",
      "updatedAt",
      "durationSeconds",
    ],
    properties: {
      callId: identifier("Provider-stable call identifier."),
      state: callState(),
      to: e164("Current destination phone number."),
      from: e164("Originating phone number."),
      direction: {
        type: "string",
        description: "Direction in which the call was established.",
        enum: ["inbound", "outbound"],
      },
      createdAt: timestamp("Time the provider created the call."),
      updatedAt: timestamp("Time the provider last changed the call."),
      startedAt: timestamp("Time a participant answered the call."),
      endedAt: timestamp("Time the call reached a terminal state."),
      durationSeconds: {
        type: "integer",
        description: "Connected call duration in whole seconds.",
        minimum: 0,
      },
      transfers: {
        type: "array",
        description: "Destinations to which the call has been transferred.",
        items: e164("A transfer destination."),
      },
    },
  };
}

function phoneNumberRecord(): JSONSchemaObject202012 {
  return {
    type: "object",
    description:
      "One provider-owned telephone number with its Eyeball agent-binding state.",
    additionalProperties: false,
    required: [
      "numberId",
      "phoneNumber",
      "friendlyName",
      "provider",
      "bindingStatus",
      "createdAt",
    ],
    properties: {
      numberId: identifier("Provider-stable owned-number identifier."),
      phoneNumber: e164("Owned telephone number in E.164 form."),
      friendlyName: identifier("Human-readable provider label."),
      provider: identifier("Provider toolkit that owns the number."),
      bindingStatus: {
        type: "string",
        description:
          "Whether the number is currently attached to an Eyeball voice agent.",
        enum: ["unbound", "bound"],
      },
      binding: {
        type: "object",
        description: "Pinned agent binding when bindingStatus is bound.",
        additionalProperties: false,
        required: ["bindingId", "agentId", "revision", "transportConnectionId"],
        properties: {
          bindingId: identifier("Stable binding identifier."),
          agentId: identifier("Bound voice-agent identifier."),
          revision: {
            type: "integer",
            description: "Immutable agent revision pinned by the binding.",
            minimum: 1,
          },
          transportConnectionId: identifier(
            "Twilio connection selected by the binding.",
          ),
        },
      },
      createdAt: timestamp("Time the provider acquired the number."),
    },
  };
}

function publishedCallOutput(
  tool: string,
  description: string,
): ObjectSchema202012 {
  const record = callRecord();
  return publishedObjectSchema({
    capability: CAPABILITY,
    tool,
    direction: "output",
    description,
    required: record.required ?? [],
    properties: record.properties ?? {},
  });
}

function roomState(): JSONSchema202012 {
  return {
    type: "string",
    description: "Normalized realtime-room lifecycle state.",
    enum: ["created", "active", "closed"],
  };
}

function pipelineState(): JSONSchema202012 {
  return {
    type: "string",
    description: "Normalized voice-pipeline lifecycle state.",
    enum: [
      "created",
      "connecting",
      "in-progress",
      "wrap-up",
      "completed",
      "failed",
      "abandoned",
    ],
  };
}

function pipelineRecord(): JSONSchemaObject202012 {
  return {
    type: "object",
    description: "State and pinned scope for one composed voice pipeline.",
    additionalProperties: false,
    required: [
      "pipelineId",
      "projectId",
      "userId",
      "agentId",
      "agentRevision",
      "transport",
      "state",
      "createdAt",
      "lastEventSequence",
    ],
    properties: {
      pipelineId: identifier("Stable pipeline/session identifier."),
      projectId: identifier("Project scope pinned to the pipeline."),
      userId: identifier("External user scope pinned to the pipeline."),
      agentId: identifier("Voice-agent identifier pinned to the pipeline."),
      agentRevision: {
        type: "integer",
        description: "Immutable voice-agent revision pinned to the pipeline.",
        minimum: 1,
      },
      transport: {
        type: "string",
        description: "Transport selected for the pipeline.",
        enum: ["pstn:twilio", "webrtc:livekit", "chat"],
      },
      state: pipelineState(),
      createdAt: timestamp("Time the pipeline was allocated."),
      startedAt: timestamp("Time the pipeline became active."),
      completedAt: timestamp("Time the pipeline became terminal."),
      lastEventSequence: {
        type: "integer",
        description: "Latest durable event sequence.",
        minimum: 0,
      },
    },
  };
}

function scriptProperty(): JSONSchema202012 {
  return {
    type: "array",
    description:
      "Deterministic scripted-caller steps accepted by the mock voice runtime.",
    items: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["caller"],
          properties: {
            caller: { type: "string", minLength: 1 },
            delayMs: { type: "integer", minimum: 0 },
            durationMs: { type: "integer", minimum: 0 },
            dtmf: { type: "string", pattern: "^[0-9A-D*#wW]+$" },
            hangup: { type: "boolean" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["expect_tool_call"],
          properties: {
            expect_tool_call: { type: "string", minLength: 3 },
            input: { type: "object", additionalProperties: true },
            result: true,
            error: { type: "object", additionalProperties: true },
          },
          not: {
            required: ["result", "error"],
            properties: { result: true, error: true },
          },
        },
      ],
    },
  };
}

const startCall = defineContract({
  capability: CAPABILITY,
  name: "start_call",
  description:
    "Start an outbound PSTN call. This is asynchronous by nature; poll the execution for allocation, then use get_call for carrier lifecycle state.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "start_call",
    direction: "input",
    description: "Origin, destination, and optional voice-agent reference.",
    required: ["to", "from"],
    properties: {
      to: e164("Destination phone number in E.164 form."),
      from: e164("Owned originating phone number in E.164 form."),
      voiceAgentId: identifier(
        "Optional low-level voice-agent identifier interpreted by the provider integration.",
      ),
      statusCallbackUrl: {
        type: "string",
        format: "uri",
        description:
          "Optional provider callback URL for low-level call status.",
      },
    },
  }),
  outputSchema: publishedCallOutput(
    "start_call",
    "The newly allocated provider call in its initial state.",
  ),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: true,
  },
  version: VERSION,
});

const getCall = defineContract({
  capability: CAPABILITY,
  name: "get_call",
  description:
    "Retrieve normalized lifecycle, participant phone numbers, timing, and provider-derived state for one call.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_call",
    direction: "input",
    description: "Identifier of the call to retrieve.",
    required: ["callId"],
    properties: { callId: identifier("Provider-stable call identifier.") },
  }),
  outputSchema: publishedCallOutput(
    "get_call",
    "Current normalized call state.",
  ),
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

const listCalls = defineContract({
  capability: CAPABILITY,
  name: "list_calls",
  description:
    "List calls with portable state, participant, and time filters. Provider ordering is preserved.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_calls",
    direction: "input",
    description: "Portable filters and pagination for provider calls.",
    properties: {
      state: callState(),
      to: e164("Return only calls to this phone number."),
      from: e164("Return only calls from this phone number."),
      createdAfter: timestamp("Return calls created at or after this time."),
      createdBefore: timestamp("Return calls created before this time."),
      pageSize: pageSizeProperty("calls"),
      pageToken: pageTokenProperty("call"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_calls",
    direction: "output",
    description: "One page of normalized calls.",
    required: ["calls"],
    properties: {
      calls: { type: "array", items: callRecord() },
      nextPageToken: nextPageTokenProperty("calls"),
    },
  }),
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

function callMutationContract(
  name: "end_call" | "transfer_call",
  description: string,
  properties: Readonly<Record<string, JSONSchema202012>>,
  required: readonly string[],
  destructive: boolean,
): CapabilityToolContract {
  return defineContract({
    capability: CAPABILITY,
    name,
    description,
    inputSchema: publishedObjectSchema({
      capability: CAPABILITY,
      tool: name,
      direction: "input",
      description,
      required,
      properties,
    }),
    outputSchema: publishedCallOutput(
      name,
      "Call state after the requested control operation.",
    ),
    annotations: {
      readOnly: false,
      destructive,
      idempotent: name === "end_call",
      async: false,
    },
    version: VERSION,
  });
}

const endCall = callMutationContract(
  "end_call",
  "End an active call. Repeating the request leaves the call terminal.",
  { callId: identifier("Provider-stable call identifier.") },
  ["callId"],
  true,
);

const transferCall = callMutationContract(
  "transfer_call",
  "Transfer or bridge an active call to another E.164 destination.",
  {
    callId: identifier("Provider-stable call identifier."),
    to: e164("New destination phone number."),
  },
  ["callId", "to"],
  false,
);

const sendDtmf = defineContract({
  capability: CAPABILITY,
  name: "send_dtmf",
  description:
    "Send DTMF digits to an active call leg. Digits may trigger irreversible behavior in an external IVR.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "send_dtmf",
    direction: "input",
    description: "Target call and DTMF digit sequence.",
    required: ["callId", "digits"],
    properties: {
      callId: identifier("Provider-stable call identifier."),
      digits: {
        type: "string",
        description: "DTMF digits, pauses, or waits to send.",
        pattern: "^[0-9A-D*#wW]+$",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "send_dtmf",
    direction: "output",
    description: "Confirmation that the provider accepted the DTMF sequence.",
    required: ["callId", "state", "digitsSent"],
    properties: {
      callId: identifier("Provider-stable call identifier."),
      state: callState(),
      digitsSent: { type: "string", pattern: "^[0-9A-D*#wW]+$" },
    },
  }),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  version: VERSION,
});

const buyNumber = defineContract({
  capability: CAPABILITY,
  name: "buy_number",
  description:
    "Acquire a provider telephone number into owned inventory. The new number is initially unbound.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "buy_number",
    direction: "input",
    description: "Telephone number to acquire and its optional provider label.",
    required: ["phoneNumber"],
    properties: {
      phoneNumber: e164("Telephone number to acquire in E.164 form."),
      friendlyName: identifier("Optional human-readable provider label."),
      transportConnectionId: identifier(
        "Provider connection used by composed voice-agent inventory tools; direct provider tools use the execution connection.",
      ),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "buy_number",
    direction: "output",
    description: "The newly acquired unbound number.",
    required: ["number"],
    properties: { number: phoneNumberRecord() },
  }),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  version: VERSION,
});

const listNumbers = defineContract({
  capability: CAPABILITY,
  name: "list_numbers",
  description:
    "List provider-owned telephone numbers with their current Eyeball agent-binding status.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_numbers",
    direction: "input",
    description: "Optional number filter and pagination controls.",
    properties: {
      phoneNumber: e164("Optional exact E.164 telephone-number filter."),
      transportConnectionId: identifier(
        "Provider connection used by composed voice-agent inventory tools; direct provider tools use the execution connection.",
      ),
      pageSize: pageSizeProperty("numbers"),
      pageToken: pageTokenProperty("numbers"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_numbers",
    direction: "output",
    description: "Owned telephone-number inventory and binding status.",
    required: ["numbers"],
    properties: {
      numbers: { type: "array", items: phoneNumberRecord() },
      nextPageToken: nextPageTokenProperty("numbers"),
    },
  }),
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

const releaseNumber = defineContract({
  capability: CAPABILITY,
  name: "release_number",
  description:
    "Permanently return an unbound telephone number to its provider. Bound numbers must be detached first.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "release_number",
    direction: "input",
    description: "Owned telephone number to return to the provider.",
    required: ["phoneNumber"],
    properties: {
      phoneNumber: e164("Owned telephone number to release in E.164 form."),
      transportConnectionId: identifier(
        "Provider connection used by composed voice-agent inventory tools; direct provider tools use the execution connection.",
      ),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "release_number",
    direction: "output",
    description: "Provider identifier and time of the completed release.",
    required: ["numberId", "phoneNumber", "releasedAt"],
    properties: {
      numberId: identifier(
        "Provider-stable identifier of the released number.",
      ),
      phoneNumber: e164("Released telephone number in E.164 form."),
      releasedAt: timestamp("Time the number was returned to the provider."),
    },
  }),
  annotations: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

const createRoom = defineContract({
  capability: CAPABILITY,
  name: "create_room",
  description:
    "Create a realtime audio/video room and return normalized access metadata.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_room",
    direction: "input",
    description: "Realtime room name, limits, and opaque metadata.",
    required: ["roomName"],
    properties: {
      roomName: identifier("Unique provider room name."),
      emptyTimeoutSeconds: {
        type: "integer",
        description: "Seconds an empty room may remain allocated.",
        minimum: 1,
        default: 300,
      },
      maxParticipants: {
        type: "integer",
        description: "Maximum simultaneous participants.",
        minimum: 1,
        default: 20,
      },
      metadata: { type: "string", description: "Opaque room metadata." },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_room",
    direction: "output",
    description: "The newly allocated realtime room.",
    required: ["roomId", "roomName", "state", "createdAt", "participantCount"],
    properties: {
      roomId: identifier("Provider-stable room identifier."),
      roomName: identifier("Provider room name."),
      state: roomState(),
      createdAt: timestamp("Time the room was created."),
      participantCount: {
        type: "integer",
        description: "Current active participant count.",
        minimum: 0,
      },
    },
  }),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  version: VERSION,
});

const joinRoom = defineContract({
  capability: CAPABILITY,
  name: "join_room",
  description:
    "Create participant credentials and normalized join instructions for a realtime room.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "join_room",
    direction: "input",
    description:
      "Room and participant identity used to create join credentials.",
    required: ["roomName", "participantIdentity"],
    properties: {
      roomName: identifier("Provider room name."),
      participantIdentity: identifier(
        "Stable participant identity in the room.",
      ),
      participantName: identifier("Human-readable participant name."),
      metadata: { type: "string", description: "Opaque participant metadata." },
      tokenTtlSeconds: {
        type: "integer",
        description: "Lifetime of the short-lived participant token.",
        minimum: 60,
        maximum: 86400,
        default: 3600,
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "join_room",
    direction: "output",
    description: "Participant identity and access token for the room.",
    required: [
      "roomId",
      "roomName",
      "participantId",
      "participantIdentity",
      "token",
      "expiresAt",
    ],
    properties: {
      roomId: identifier("Provider-stable room identifier."),
      roomName: identifier("Provider room name."),
      participantId: identifier("Provider-stable participant identifier."),
      participantIdentity: identifier("Stable participant identity."),
      token: identifier("Short-lived room access token."),
      expiresAt: timestamp("Time the short-lived room access token expires."),
      serverUrl: {
        type: "string",
        format: "uri",
        description: "Realtime server URL when the provider exposes it.",
      },
    },
  }),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

const synthesizeSpeech = defineContract({
  capability: CAPABILITY,
  name: "synthesize_speech",
  description:
    "Convert text to speech using a selected voice. Mock mode returns a deterministic audio_ref string instead of audio bytes.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "synthesize_speech",
    direction: "input",
    description: "Text, voice, and optional synthesis controls.",
    required: ["text", "voiceId"],
    properties: {
      text: {
        type: "string",
        description: "Text to synthesize.",
        minLength: 1,
      },
      voiceId: identifier("Provider voice identifier."),
      modelId: identifier("Optional provider speech model identifier."),
      audioFormat: {
        type: "string",
        description: "Requested audio serialization.",
        enum: ["mp3", "wav", "pcm", "ulaw"],
        default: "mp3",
      },
      stability: { type: "number", minimum: 0, maximum: 1 },
      similarityBoost: { type: "number", minimum: 0, maximum: 1 },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "synthesize_speech",
    direction: "output",
    description: "Reference to synthesized audio and billable character count.",
    required: ["audioRef", "characters", "audioFormat"],
    properties: {
      audioRef: identifier(
        "Opaque audio reference; fixture:tts:* identifies deterministic mock audio.",
      ),
      characters: {
        type: "integer",
        description: "Unicode character count synthesized.",
        minimum: 0,
      },
      audioFormat: {
        type: "string",
        enum: ["mp3", "wav", "pcm", "ulaw"],
      },
    },
  }),
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

const transcribeAudio = defineContract({
  capability: CAPABILITY,
  name: "transcribe_audio",
  description:
    "Transcribe referenced audio into normalized text. Mock mode resolves deterministic audio_ref registry entries.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "transcribe_audio",
    direction: "input",
    description: "Audio reference and optional speech-recognition controls.",
    required: ["audioRef"],
    properties: {
      audioRef: identifier("Opaque audio reference to transcribe."),
      model: identifier("Optional provider recognition model."),
      language: identifier("BCP 47 language hint."),
      smartFormat: {
        type: "boolean",
        description:
          "Whether the provider should normalize written formatting.",
        default: true,
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "transcribe_audio",
    direction: "output",
    description: "Best transcript alternative and word timings.",
    required: ["text", "confidence", "words"],
    properties: {
      text: { type: "string", description: "Best transcript text." },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      language: identifier("Detected or requested transcript language."),
      words: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["word", "startMs", "endMs", "confidence"],
          properties: {
            word: { type: "string", minLength: 1 },
            startMs: { type: "integer", minimum: 0 },
            endMs: { type: "integer", minimum: 0 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
  }),
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

const startVoicePipeline = defineContract({
  capability: CAPABILITY,
  name: "start_voice_pipeline",
  description:
    "Start a composed transport, speech, model, and tool pipeline. This is asynchronous by nature.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "start_voice_pipeline",
    direction: "input",
    description: "Opaque runtime agent configuration and optional mock script.",
    required: ["agentConfig"],
    properties: {
      agentConfig: {
        type: "object",
        description:
          "Runtime agent configuration consumed by the voice worker.",
        additionalProperties: true,
      },
      script: scriptProperty(),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "start_voice_pipeline",
    direction: "output",
    description: "Newly allocated voice pipeline.",
    required: ["pipeline"],
    properties: { pipeline: pipelineRecord() },
  }),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: true,
  },
  version: VERSION,
});

const getVoicePipeline = defineContract({
  capability: CAPABILITY,
  name: "get_voice_pipeline",
  description:
    "Retrieve the current state, pinned scope, and latest event sequence for a voice pipeline.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_voice_pipeline",
    direction: "input",
    description: "Identifier of the pipeline to retrieve.",
    required: ["pipelineId"],
    properties: {
      pipelineId: identifier("Stable pipeline/session identifier."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_voice_pipeline",
    direction: "output",
    description: "Current voice-pipeline state.",
    required: ["pipeline"],
    properties: { pipeline: pipelineRecord() },
  }),
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

export const voiceCapabilityContracts = deepFreeze([
  startCall,
  getCall,
  listCalls,
  endCall,
  transferCall,
  sendDtmf,
  buyNumber,
  listNumbers,
  releaseNumber,
  createRoom,
  joinRoom,
  synthesizeSpeech,
  transcribeAudio,
  startVoicePipeline,
  getVoicePipeline,
] as const satisfies readonly CapabilityToolContract[]);

type VoiceContract = (typeof voiceCapabilityContracts)[number];
type VoiceContractsByName = {
  readonly [Contract in VoiceContract as Contract["name"]]: Contract;
};

export const voiceContractsByName = deepFreeze(
  Object.fromEntries(
    voiceCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as VoiceContractsByName,
);
