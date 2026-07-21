import type {
  VoiceObserverFailedWebhookEvent,
  VoiceSessionWebhookEvent,
  VoiceTranscriptWebhookEvent,
} from "@eyeball/core";

export type VoiceWebhookEvent =
  | VoiceSessionWebhookEvent
  | VoiceTranscriptWebhookEvent
  | VoiceObserverFailedWebhookEvent;

export type VoiceWebhookSourceKind =
  | "session_event"
  | "transcript"
  | "observer_failure";

export interface VoiceWebhookSourceRecord {
  readonly projectId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly eventType: VoiceWebhookEvent["type"];
  readonly sourceKind: VoiceWebhookSourceKind;
  readonly workerSequence?: number;
  readonly envelope: VoiceWebhookEvent;
  readonly createdAt: string;
}

export type VoiceWebhookSourceAdmission = Omit<
  VoiceWebhookSourceRecord,
  "createdAt"
> & { readonly createdAt?: string };

/** Validates the cross-column identity before either memory or Postgres writes. */
export function normalizeVoiceWebhookSourceAdmission(
  input: VoiceWebhookSourceAdmission,
): VoiceWebhookSourceRecord {
  const sourceShapeIsValid =
    (input.sourceKind === "session_event" &&
      input.eventType === "voice.session.event" &&
      input.workerSequence !== undefined) ||
    (input.sourceKind === "transcript" &&
      input.eventType === "voice.transcript.ready" &&
      input.workerSequence === undefined) ||
    (input.sourceKind === "observer_failure" &&
      input.eventType === "voice.observer.failed" &&
      input.workerSequence === undefined);
  const createdAt = input.createdAt ?? input.envelope.createdAt;
  if (
    input.projectId.length === 0 ||
    input.eventId.length === 0 ||
    input.sessionId.length === 0 ||
    input.envelope.projectId !== input.projectId ||
    input.envelope.id !== input.eventId ||
    input.envelope.type !== input.eventType ||
    input.envelope.data.sessionId !== input.sessionId ||
    !sourceShapeIsValid ||
    (input.workerSequence !== undefined &&
      (!Number.isSafeInteger(input.workerSequence) ||
        input.workerSequence < 1)) ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new TypeError("Voice webhook source identity is invalid.");
  }
  return structuredClone({
    ...input,
    createdAt: new Date(createdAt).toISOString(),
  });
}

/** Complete durable voice envelopes used by any replica during delivery. */
export interface VoiceWebhookSourceStore {
  ensureSource(
    input: VoiceWebhookSourceAdmission,
  ): Promise<"inserted" | "existing">;
  getSource(
    projectId: string,
    eventId: string,
  ): Promise<VoiceWebhookSourceRecord | undefined>;
}
