import { createHash } from "node:crypto";
import type { ExecutionId } from "./types/execution.js";
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
export const VOICE_WORKER_CONTRACT_VERSION = "eyeball.voice-worker.v2" as const;

/** Reserved child identity accepted from a pinned key or scoped session grant. */
export const VOICE_WORKER_EXECUTION_ID_HEADER = "X-Eyeball-Execution-Id";

/** Signed voice-session binding required on grant-authenticated child calls. */
export const VOICE_SESSION_ID_HEADER = "X-Eyeball-Voice-Session-Id";

const VOICE_EXECUTION_ID_PREFIX = "exe_voice_";

function voiceSessionExecutionBinding(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

/** Creates a stable child execution ID cryptographically bound to one voice session. */
export function voiceSessionExecutionId(
  sessionId: string,
  eventKey: string,
): ExecutionId {
  const eventDigest = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(eventKey)
    .digest("hex")
    .slice(0, 32);
  return `${VOICE_EXECUTION_ID_PREFIX}${voiceSessionExecutionBinding(sessionId)}${eventDigest}` as ExecutionId;
}

/** Checks whether a reserved child execution ID belongs to the authorized session. */
export function isVoiceSessionExecutionIdForSession(
  executionId: string,
  sessionId: string,
): boolean {
  return new RegExp(
    `^${VOICE_EXECUTION_ID_PREFIX}${voiceSessionExecutionBinding(sessionId)}[0-9a-f]{32}$`,
    "u",
  ).test(executionId);
}

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

/**
 * Opaque worker-to-executor capability for one remote voice session.
 *
 * The worker must never expose this value through public sessions, events,
 * transcripts, health responses, or general request snapshots.
 */
export interface VoiceWorkerExecutorGrant {
  token: string;
  expiresAt: string;
}

export interface VoiceWorkerStartSessionRequest {
  contractVersion: VoiceWorkerContractVersion;
  /** Executor-owned immutable identifier used by every child execution. */
  sessionId: string;
  scope: {
    projectId: string;
    userId: string;
  };
  agent: VoiceWorkerAgentSnapshot;
  transport: VoiceWorkerTransportConfig;
  executorGrant?: VoiceWorkerExecutorGrant;
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
