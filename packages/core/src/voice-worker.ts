import type {
  JsonValue,
  ObjectSchema202012,
  QualifiedToolName,
} from "./types/tool.js";
import type {
  RecordingPolicy,
  VoiceAgentGuardrails,
  VoiceAgentSession,
  VoiceAgentSessionEvent,
  VoiceAgentWebhookPolicy,
  VoiceConfig,
} from "./voice-agents.js";

/** Wire-level compatibility marker for the executor-to-worker control plane. */
export const VOICE_WORKER_CONTRACT_VERSION = "eyeball.voice-worker.v1" as const;

/** Reserved child identity accepted only from a user-pinned executor key. */
export const VOICE_WORKER_EXECUTION_ID_HEADER = "X-Eyeball-Execution-Id";

export type VoiceWorkerContractVersion = typeof VOICE_WORKER_CONTRACT_VERSION;

/** Immutable canonical tool definition supplied to the model for one session. */
export interface VoiceWorkerAllowedTool {
  name: QualifiedToolName;
  description: string;
  inputSchema: ObjectSchema202012;
}

/** Immutable voice-agent revision snapshot. Provider credentials are never included. */
export interface VoiceWorkerAgentSnapshot {
  id: string;
  revision: number;
  systemPrompt: string;
  llm: {
    provider: "anthropic";
    model: string;
    temperature?: number;
    maxOutputTokens?: number;
  };
  voice: VoiceConfig;
  allowedTools: readonly VoiceWorkerAllowedTool[];
  guardrails: VoiceAgentGuardrails;
  webhooks: VoiceAgentWebhookPolicy;
  recordingPolicy: RecordingPolicy;
  bargeIn: {
    enabled: boolean;
  };
}

export type VoiceWorkerTransportConfig =
  | {
      kind: "twilio";
      to: string;
      from?: string;
      transportConnectionId?: string;
      metadata?: Readonly<Record<string, JsonValue>>;
    }
  | {
      kind: "livekit";
      roomName: string;
      transportConnectionId?: string;
      participantIdentity?: string;
      metadata?: Readonly<Record<string, JsonValue>>;
    }
  | {
      kind: "chat";
      metadata?: Readonly<Record<string, JsonValue>>;
    }
  | {
      /** Deterministic, audio-less transport available only to contract tests. */
      kind: "fake";
      turns: readonly [VoiceWorkerFakeTurn, ...VoiceWorkerFakeTurn[]];
    };

export interface VoiceWorkerFakeTurn {
  caller: string;
  assistant?: string;
  /** Deterministic delay used only by contract tests. */
  delayMs?: number;
  toolCall?: {
    name: QualifiedToolName;
    input: Readonly<Record<string, JsonValue>>;
  };
}

export interface VoiceWorkerStartSessionRequest {
  contractVersion: VoiceWorkerContractVersion;
  scope: {
    projectId: string;
    userId: string;
  };
  agent: VoiceWorkerAgentSnapshot;
  transport: VoiceWorkerTransportConfig;
}

export interface VoiceWorkerStartSessionResponse {
  contractVersion: VoiceWorkerContractVersion;
  session: VoiceAgentSession;
}

export interface VoiceWorkerStopSessionRequest {
  contractVersion: VoiceWorkerContractVersion;
  reason?: string;
}

export interface VoiceWorkerStopSessionResponse {
  contractVersion: VoiceWorkerContractVersion;
  session: VoiceAgentSession;
}

export interface VoiceWorkerChatTurnRequest {
  contractVersion: VoiceWorkerContractVersion;
  text: string;
  idempotencyKey: string;
}

export interface VoiceWorkerChatTurnResponse {
  contractVersion: VoiceWorkerContractVersion;
  session: VoiceAgentSession;
  turnId: string;
  assistantMessage: string;
}

export interface VoiceWorkerSessionResponse {
  contractVersion: VoiceWorkerContractVersion;
  session: VoiceAgentSession;
}

export interface VoiceWorkerEventPage {
  contractVersion: VoiceWorkerContractVersion;
  events: readonly VoiceAgentSessionEvent[];
  nextSequence: number;
  hasMore: boolean;
}

/** One server-to-client WebSocket message on `/v1/sessions/{id}/events`. */
export interface VoiceWorkerEventEnvelope {
  contractVersion: VoiceWorkerContractVersion;
  event: VoiceAgentSessionEvent;
}
