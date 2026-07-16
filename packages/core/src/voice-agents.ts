import type { NormalizedToolError } from "./errors.js";
import { TOOL_ERROR_CODES } from "./errors.js";
import { type InputValidationResult, validateInput } from "./schema.js";
import type {
  JSONSchema202012,
  JsonValue,
  ObjectSchema202012,
  QualifiedToolName,
} from "./types/tool.js";
import { JSON_SCHEMA_DRAFT_2020_12 } from "./types/tool.js";

export type VoiceAgentTransport = "pstn:twilio" | "webrtc:livekit" | "chat";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface LlmModelRef {
  /** Opaque project model-registry reference; never a provider API key. */
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ElevenLabsTtsConfig {
  provider: "elevenlabs";
  voiceId: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
}

export interface DeepgramSttConfig {
  provider: "deepgram";
  model?: string;
  language?: string;
  smartFormat?: boolean;
  interimResults?: boolean;
}

export interface VoiceConfig {
  tts: ElevenLabsTtsConfig;
  stt: DeepgramSttConfig;
}

export interface AllowedHoursWindow {
  days: readonly Weekday[];
  start: string;
  end: string;
  timeZone: string;
}

export type HandoffToHumanConfig =
  | { enabled: false }
  | {
      enabled: true;
      destination: string;
      on: "agent_request" | "caller_request" | "guardrail" | "any";
      announcement?: string;
    };

export interface VoiceAgentGuardrails {
  maxDurationSeconds: number;
  allowedHours?: readonly AllowedHoursWindow[];
  handoffToHuman: HandoffToHumanConfig;
}

export type SessionWebhookEventName =
  | "session.lifecycle"
  | "turn.transcript"
  | "tool_call"
  | "tool_result"
  | "handoff"
  | "dtmf";

export interface VoiceAgentWebhookPolicy {
  /** RFC 001 project endpoint references; never raw URLs or secrets. */
  endpointIds: readonly string[];
  transcript: boolean;
  events: readonly SessionWebhookEventName[];
}

export interface RecordingPolicy {
  mode: "disabled" | "audio" | "audio_and_transcript";
  consent: "external" | "agent_announcement";
  retentionDays: number;
  redactDtmf: boolean;
}

export interface VoiceAgentDefinition {
  id: string;
  revision: number;
  name: string;
  systemPrompt: string;
  llm: LlmModelRef;
  voice: VoiceConfig;
  transport: VoiceAgentTransport;
  tools: readonly QualifiedToolName[];
  guardrails: VoiceAgentGuardrails;
  webhooks: VoiceAgentWebhookPolicy;
  recordingPolicy: RecordingPolicy;
  createdAt: string;
}

export type VoiceAgentDraft = Omit<
  VoiceAgentDefinition,
  "id" | "revision" | "createdAt"
>;

export interface VoiceAgentSummary {
  id: string;
  activeRevision: number;
  name: string;
  transport: VoiceAgentTransport;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type VoiceAgentSessionState =
  | "created"
  | "connecting"
  | "in-progress"
  | "wrap-up"
  | "completed"
  | "failed"
  | "abandoned";

export interface VoiceAgentSession {
  id: string;
  projectId: string;
  agentId: string;
  agentRevision: number;
  transport: VoiceAgentTransport;
  state: VoiceAgentSessionState;
  userId: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastEventSequence: number;
  error?: NormalizedToolError;
}

export type VoiceAgentSessionEventData =
  | {
      type: "session.lifecycle";
      from?: VoiceAgentSessionState;
      to: VoiceAgentSessionState;
    }
  | {
      type: "turn.transcript";
      turnId: string;
      speaker: "human" | "agent";
      text: string;
      final: boolean;
      startMs: number;
      endMs: number;
    }
  | {
      type: "tool_call";
      turnId: string;
      executionId: string;
      tool: QualifiedToolName;
      input: Readonly<Record<string, JsonValue>>;
    }
  | ({
      type: "tool_result";
      turnId: string;
      executionId: string;
      tool: QualifiedToolName;
    } & (
      | { output: JsonValue; error?: never }
      | { output?: never; error: NormalizedToolError }
    ))
  | {
      type: "handoff";
      destination: string;
      reason: string;
      status: "requested" | "completed" | "failed";
    }
  | {
      type: "dtmf";
      direction: "received" | "sent";
      digits: string;
      redacted: boolean;
    };

export interface VoiceAgentSessionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  createdAt: string;
  data: VoiceAgentSessionEventData;
}

export interface TranscriptTurn {
  id: string;
  speaker: "human" | "agent" | "tool";
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  executionId?: string;
  tool?: QualifiedToolName;
}

export interface TranscriptArtifact {
  id: string;
  sessionId: string;
  agentId: string;
  agentRevision: number;
  transport: VoiceAgentTransport;
  final: boolean;
  language?: string;
  startedAt: string;
  endedAt?: string;
  turns: readonly TranscriptTurn[];
  recording?: {
    artifactId: string;
    contentType: string;
    durationMs: number;
  };
}

const id: JSONSchema202012 = { type: "string", minLength: 1 };
const timestamp: JSONSchema202012 = { type: "string", format: "date-time" };
const e164: JSONSchema202012 = {
  type: "string",
  pattern: "^\\+[1-9][0-9]{7,14}$",
};
const stateValues = [
  "created",
  "connecting",
  "in-progress",
  "wrap-up",
  "completed",
  "failed",
  "abandoned",
] as const;

/** Reusable RFC 002 fragments embedded into every published voice-agent schema. */
export const voiceAgentSchemaDefs = {
  id,
  timestamp,
  e164,
  transport: {
    type: "string",
    enum: ["pstn:twilio", "webrtc:livekit", "chat"],
  },
  qualifiedToolName: {
    type: "string",
    minLength: 3,
    maxLength: 63,
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*\\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$",
  },
  llm: {
    type: "object",
    additionalProperties: false,
    required: ["model"],
    properties: {
      model: { type: "string", minLength: 1 },
      temperature: { type: "number", minimum: 0, maximum: 2 },
      maxOutputTokens: { type: "integer", minimum: 1 },
    },
  },
  tts: {
    type: "object",
    additionalProperties: false,
    required: ["provider", "voiceId"],
    properties: {
      provider: { const: "elevenlabs" },
      voiceId: { type: "string", minLength: 1 },
      modelId: { type: "string", minLength: 1 },
      stability: { type: "number", minimum: 0, maximum: 1 },
      similarityBoost: { type: "number", minimum: 0, maximum: 1 },
    },
  },
  stt: {
    type: "object",
    additionalProperties: false,
    required: ["provider"],
    properties: {
      provider: { const: "deepgram" },
      model: { type: "string", minLength: 1 },
      language: { type: "string", minLength: 1 },
      smartFormat: { type: "boolean" },
      interimResults: { type: "boolean" },
    },
  },
  voice: {
    type: "object",
    additionalProperties: false,
    required: ["tts", "stt"],
    properties: {
      tts: { $ref: "#/$defs/tts" },
      stt: { $ref: "#/$defs/stt" },
    },
  },
  allowedHoursWindow: {
    type: "object",
    additionalProperties: false,
    required: ["days", "start", "end", "timeZone"],
    properties: {
      days: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: {
          type: "string",
          enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        },
      },
      start: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" },
      end: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" },
      timeZone: { type: "string", minLength: 1 },
    },
  },
  handoff: {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["enabled"],
        properties: { enabled: { const: false } },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["enabled", "destination", "on"],
        properties: {
          enabled: { const: true },
          destination: e164,
          on: {
            type: "string",
            enum: ["agent_request", "caller_request", "guardrail", "any"],
          },
          announcement: { type: "string", minLength: 1 },
        },
      },
    ],
  },
  guardrails: {
    type: "object",
    additionalProperties: false,
    required: ["maxDurationSeconds", "handoffToHuman"],
    properties: {
      maxDurationSeconds: { type: "integer", minimum: 1 },
      allowedHours: {
        type: "array",
        items: { $ref: "#/$defs/allowedHoursWindow" },
      },
      handoffToHuman: { $ref: "#/$defs/handoff" },
    },
  },
  webhooks: {
    type: "object",
    additionalProperties: false,
    required: ["endpointIds", "transcript", "events"],
    properties: {
      endpointIds: {
        type: "array",
        uniqueItems: true,
        items: id,
      },
      transcript: { type: "boolean" },
      events: {
        type: "array",
        uniqueItems: true,
        items: {
          type: "string",
          enum: [
            "session.lifecycle",
            "turn.transcript",
            "tool_call",
            "tool_result",
            "handoff",
            "dtmf",
          ],
        },
      },
    },
  },
  recordingPolicy: {
    type: "object",
    additionalProperties: false,
    required: ["mode", "consent", "retentionDays", "redactDtmf"],
    properties: {
      mode: {
        type: "string",
        enum: ["disabled", "audio", "audio_and_transcript"],
      },
      consent: {
        type: "string",
        enum: ["external", "agent_announcement"],
      },
      retentionDays: { type: "integer", minimum: 0 },
      redactDtmf: { type: "boolean" },
    },
  },
  agentDraft: {
    type: "object",
    additionalProperties: false,
    required: [
      "name",
      "systemPrompt",
      "llm",
      "voice",
      "transport",
      "tools",
      "guardrails",
      "webhooks",
      "recordingPolicy",
    ],
    properties: {
      name: { type: "string", minLength: 1 },
      systemPrompt: { type: "string", minLength: 1 },
      llm: { $ref: "#/$defs/llm" },
      voice: { $ref: "#/$defs/voice" },
      transport: { $ref: "#/$defs/transport" },
      tools: {
        type: "array",
        uniqueItems: true,
        items: { $ref: "#/$defs/qualifiedToolName" },
      },
      guardrails: { $ref: "#/$defs/guardrails" },
      webhooks: { $ref: "#/$defs/webhooks" },
      recordingPolicy: { $ref: "#/$defs/recordingPolicy" },
    },
  },
  agentDefinition: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "revision",
      "name",
      "systemPrompt",
      "llm",
      "voice",
      "transport",
      "tools",
      "guardrails",
      "webhooks",
      "recordingPolicy",
      "createdAt",
    ],
    properties: {
      id,
      revision: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1 },
      systemPrompt: { type: "string", minLength: 1 },
      llm: { $ref: "#/$defs/llm" },
      voice: { $ref: "#/$defs/voice" },
      transport: { $ref: "#/$defs/transport" },
      tools: {
        type: "array",
        uniqueItems: true,
        items: { $ref: "#/$defs/qualifiedToolName" },
      },
      guardrails: { $ref: "#/$defs/guardrails" },
      webhooks: { $ref: "#/$defs/webhooks" },
      recordingPolicy: { $ref: "#/$defs/recordingPolicy" },
      createdAt: timestamp,
    },
  },
  agentSummary: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "activeRevision",
      "name",
      "transport",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id,
      activeRevision: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1 },
      transport: { $ref: "#/$defs/transport" },
      deletedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  },
  state: { type: "string", enum: stateValues },
  normalizedError: {
    type: "object",
    additionalProperties: false,
    required: ["code", "message", "retryable"],
    properties: {
      code: { type: "string", enum: Object.values(TOOL_ERROR_CODES) },
      message: { type: "string", minLength: 1 },
      retryable: { type: "boolean" },
      retryAfter: { type: "number", minimum: 0 },
      provider: {
        type: "object",
        additionalProperties: false,
        required: ["toolkit"],
        properties: {
          toolkit: { type: "string", minLength: 1 },
          status: { type: "integer", minimum: 100, maximum: 599 },
          code: { type: "string", minLength: 1 },
          requestId: { type: "string", minLength: 1 },
          detail: true,
        },
      },
    },
  },
  session: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "projectId",
      "agentId",
      "agentRevision",
      "transport",
      "state",
      "userId",
      "createdAt",
      "lastEventSequence",
    ],
    properties: {
      id,
      projectId: id,
      agentId: id,
      agentRevision: { type: "integer", minimum: 1 },
      transport: { $ref: "#/$defs/transport" },
      state: { $ref: "#/$defs/state" },
      userId: id,
      createdAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
      lastEventSequence: { type: "integer", minimum: 0 },
      error: { $ref: "#/$defs/normalizedError" },
    },
  },
  eventData: {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "to"],
        properties: {
          type: { const: "session.lifecycle" },
          from: { $ref: "#/$defs/state" },
          to: { $ref: "#/$defs/state" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "turnId",
          "speaker",
          "text",
          "final",
          "startMs",
          "endMs",
        ],
        properties: {
          type: { const: "turn.transcript" },
          turnId: id,
          speaker: { type: "string", enum: ["human", "agent"] },
          text: { type: "string" },
          final: { type: "boolean" },
          startMs: { type: "integer", minimum: 0 },
          endMs: { type: "integer", minimum: 0 },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "turnId", "executionId", "tool", "input"],
        properties: {
          type: { const: "tool_call" },
          turnId: id,
          executionId: id,
          tool: { $ref: "#/$defs/qualifiedToolName" },
          input: { type: "object", additionalProperties: true },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        minProperties: 5,
        maxProperties: 5,
        required: ["type", "turnId", "executionId", "tool"],
        properties: {
          type: { const: "tool_result" },
          turnId: id,
          executionId: id,
          tool: { $ref: "#/$defs/qualifiedToolName" },
          output: true,
          error: { $ref: "#/$defs/normalizedError" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "destination", "reason", "status"],
        properties: {
          type: { const: "handoff" },
          destination: e164,
          reason: { type: "string", minLength: 1 },
          status: {
            type: "string",
            enum: ["requested", "completed", "failed"],
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "direction", "digits", "redacted"],
        properties: {
          type: { const: "dtmf" },
          direction: { type: "string", enum: ["received", "sent"] },
          digits: { type: "string" },
          redacted: { type: "boolean" },
        },
      },
    ],
  },
  event: {
    type: "object",
    additionalProperties: false,
    required: ["id", "sessionId", "sequence", "createdAt", "data"],
    properties: {
      id,
      sessionId: id,
      sequence: { type: "integer", minimum: 1 },
      createdAt: timestamp,
      data: { $ref: "#/$defs/eventData" },
    },
  },
  transcriptTurn: {
    type: "object",
    additionalProperties: false,
    required: ["id", "speaker", "startMs", "endMs", "text"],
    properties: {
      id,
      speaker: { type: "string", enum: ["human", "agent", "tool"] },
      startMs: { type: "integer", minimum: 0 },
      endMs: { type: "integer", minimum: 0 },
      text: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      executionId: id,
      tool: { $ref: "#/$defs/qualifiedToolName" },
    },
  },
  transcriptArtifact: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "sessionId",
      "agentId",
      "agentRevision",
      "transport",
      "final",
      "startedAt",
      "turns",
    ],
    properties: {
      id,
      sessionId: id,
      agentId: id,
      agentRevision: { type: "integer", minimum: 1 },
      transport: { $ref: "#/$defs/transport" },
      final: { type: "boolean" },
      language: { type: "string", minLength: 1 },
      startedAt: timestamp,
      endedAt: timestamp,
      turns: { type: "array", items: { $ref: "#/$defs/transcriptTurn" } },
      recording: {
        type: "object",
        additionalProperties: false,
        required: ["artifactId", "contentType", "durationMs"],
        properties: {
          artifactId: id,
          contentType: { type: "string", minLength: 1 },
          durationMs: { type: "integer", minimum: 0 },
        },
      },
    },
  },
} as const satisfies Readonly<Record<string, JSONSchema202012>>;

/** Standalone validator schema for a draft; published tool schemas embed the same defs. */
export const voiceAgentDraftSchema: ObjectSchema202012 = {
  $schema: JSON_SCHEMA_DRAFT_2020_12,
  $id: "urn:eyeball:voice-agent-draft:1.0.0",
  $defs: voiceAgentSchemaDefs,
  type: "object",
  allOf: [{ $ref: "#/$defs/agentDraft" }],
};

/** Standalone validator schema for an immutable voice-agent revision. */
export const voiceAgentDefinitionSchema: ObjectSchema202012 = {
  $schema: JSON_SCHEMA_DRAFT_2020_12,
  $id: "urn:eyeball:voice-agent-definition:1.0.0",
  $defs: voiceAgentSchemaDefs,
  type: "object",
  allOf: [{ $ref: "#/$defs/agentDefinition" }],
};

/** Validates and clones a portable voice-agent draft at the public core boundary. */
export function validateVoiceAgentDraft(value: unknown): InputValidationResult {
  return validateInput({ inputSchema: voiceAgentDraftSchema }, value);
}

/** Validates and clones one immutable voice-agent revision. */
export function validateVoiceAgentDefinition(
  value: unknown,
): InputValidationResult {
  return validateInput({ inputSchema: voiceAgentDefinitionSchema }, value);
}
