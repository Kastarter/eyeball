import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ExecutionWebhookEvent,
  TerminalEventType,
} from "./types/execution.js";
import type {
  TranscriptArtifact,
  VoiceAgentSessionEvent,
} from "./voice-agents.js";

export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1_000;

export const WEBHOOK_ID_HEADER = "Eyeball-Webhook-Id";
/** Canonical signed-delivery timestamp header. */
export const WEBHOOK_TIMESTAMP_HEADER = "Eyeball-Webhook-Timestamp";
/** Canonical signed-delivery signature header. */
export const WEBHOOK_SIGNATURE_HEADER = "Eyeball-Webhook-Signature";
/** Original RFC 001 name, accepted and emitted for compatibility. */
export const WEBHOOK_TIMESTAMP_HEADER_ALIAS = "Eyeball-Timestamp";
/** Original RFC 001 name, accepted and emitted for compatibility. */
export const WEBHOOK_SIGNATURE_HEADER_ALIAS = "Eyeball-Signature";

export const WEBHOOK_SUBSCRIPTION_EVENT_TYPES = [
  "execution.completed",
  "execution.succeeded",
  "execution.failed",
  "voice.session.event",
  "voice.transcript.ready",
] as const;

export type WebhookSubscriptionEventType =
  (typeof WEBHOOK_SUBSCRIPTION_EVENT_TYPES)[number];

export type WebhookEventType =
  | TerminalEventType
  | "voice.session.event"
  | "voice.transcript.ready";

export interface WebhookEndpoint {
  endpointId: string;
  url: string;
  secretPrefix: string;
  events: readonly WebhookSubscriptionEventType[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedWebhookEndpoint extends WebhookEndpoint {
  /** Returned only by endpoint creation. Store this value immediately. */
  secret: string;
}

export interface RotatedWebhookSecret {
  endpointId: string;
  secretPrefix: string;
  /** Returned only by secret rotation. Store this value immediately. */
  secret: string;
  rotatedAt: string;
}

export interface WebhookEndpointPage {
  webhooks: readonly WebhookEndpoint[];
  nextCursor?: string;
}

export interface VoiceSessionWebhookEvent {
  id: string;
  type: "voice.session.event";
  createdAt: string;
  projectId: string;
  data: VoiceAgentSessionEvent;
}

export interface VoiceTranscriptWebhookEvent {
  id: string;
  type: "voice.transcript.ready";
  createdAt: string;
  projectId: string;
  data: TranscriptArtifact;
}

export type WebhookEvent =
  | ExecutionWebhookEvent
  | VoiceSessionWebhookEvent
  | VoiceTranscriptWebhookEvent;

export type WebhookDeliveryStatus =
  | "pending"
  | "delivering"
  | "succeeded"
  | "failed";

export interface WebhookDeliveryAttempt {
  attempt: number;
  attemptedAt: string;
  completedAt: string;
  statusCode?: number;
  error?: string;
}

export interface WebhookDelivery {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  eventType: WebhookEventType;
  status: WebhookDeliveryStatus;
  attempts: readonly WebhookDeliveryAttempt[];
  createdAt: string;
  nextRetryAt?: string;
  completedAt?: string;
}

export interface WebhookDeliveryPage {
  deliveries: readonly WebhookDelivery[];
  nextCursor?: string;
}

export type WebhookHeaderSource =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface VerifyWebhookSignatureOptions {
  /** Exact request bytes. Verify before parsing JSON. */
  payload: string | Uint8Array;
  headers: WebhookHeaderSource;
  secret: string;
  /** Defaults to five minutes. */
  toleranceMs?: number;
  /** Test seam; defaults to the current wall-clock time. */
  now?: number | Date;
}

export interface CreateWebhookSignatureOptions {
  payload: string | Uint8Array;
  secret: string;
  /** Decimal Unix time in seconds, exactly as sent in the timestamp header. */
  timestamp: string;
}

function headerValue(
  headers: WebhookHeaderSource,
  name: string,
): string | undefined {
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name) ?? undefined;
  }
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== expected) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function encodedPayload(payload: string | Uint8Array): Uint8Array {
  return typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
}

/** Creates the RFC 001 `v1=<hex>` signature for an exact raw payload. */
export function createWebhookSignature(
  options: CreateWebhookSignatureOptions,
): string {
  const digest = createHmac("sha256", options.secret)
    .update(options.timestamp, "utf8")
    .update(".", "utf8")
    .update(encodedPayload(options.payload))
    .digest("hex");
  return `v1=${digest}`;
}

/**
 * Verifies a signed webhook using a constant-time digest comparison and a
 * five-minute replay window. The payload must be the unmodified raw body.
 */
export function verifyWebhookSignature(
  options: VerifyWebhookSignatureOptions,
): boolean {
  const toleranceMs = options.toleranceMs ?? WEBHOOK_TIMESTAMP_TOLERANCE_MS;
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) return false;
  if (options.secret.length === 0) return false;

  const timestamp =
    headerValue(options.headers, WEBHOOK_TIMESTAMP_HEADER) ??
    headerValue(options.headers, WEBHOOK_TIMESTAMP_HEADER_ALIAS);
  const signature =
    headerValue(options.headers, WEBHOOK_SIGNATURE_HEADER) ??
    headerValue(options.headers, WEBHOOK_SIGNATURE_HEADER_ALIAS);
  if (
    timestamp === undefined ||
    signature === undefined ||
    !/^[0-9]{1,16}$/u.test(timestamp) ||
    !/^v1=[0-9a-f]{64}$/u.test(signature)
  ) {
    return false;
  }

  const timestampMs = Number(timestamp) * 1_000;
  const nowMs =
    options.now instanceof Date
      ? options.now.valueOf()
      : (options.now ?? Date.now());
  if (
    !Number.isFinite(timestampMs) ||
    !Number.isFinite(nowMs) ||
    Math.abs(nowMs - timestampMs) > toleranceMs
  ) {
    return false;
  }

  const expected = createWebhookSignature({
    payload: options.payload,
    secret: options.secret,
    timestamp,
  });
  const expectedBytes = Buffer.from(expected.slice(3), "hex");
  const actualBytes = Buffer.from(signature.slice(3), "hex");
  return (
    expectedBytes.byteLength === actualBytes.byteLength &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}
