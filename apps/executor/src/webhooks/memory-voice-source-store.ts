import { isDeepStrictEqual } from "node:util";
import type {
  VoiceWebhookSourceAdmission,
  VoiceWebhookSourceRecord,
  VoiceWebhookSourceStore,
} from "./voice-source-store.js";
import { normalizeVoiceWebhookSourceAdmission } from "./voice-source-store.js";

function key(projectId: string, eventId: string): string {
  return JSON.stringify([projectId, eventId]);
}

function sequenceKey(sessionId: string, sequence: number): string {
  return JSON.stringify([sessionId, sequence]);
}

/** Process-local parity implementation; it intentionally does not survive restart. */
export class InMemoryVoiceWebhookSourceStore
  implements VoiceWebhookSourceStore
{
  readonly #sources = new Map<string, VoiceWebhookSourceRecord>();
  readonly #sequences = new Map<string, string>();

  async ensureSource(
    input: VoiceWebhookSourceAdmission,
  ): Promise<"inserted" | "existing"> {
    const incoming = normalizeVoiceWebhookSourceAdmission(input);
    const storageKey = key(incoming.projectId, incoming.eventId);
    const existing = this.#sources.get(storageKey);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, incoming)) {
        throw new Error(
          "Voice webhook source identity was reused with different content.",
        );
      }
      return "existing";
    }
    if (incoming.workerSequence !== undefined) {
      const cursorKey = sequenceKey(
        incoming.sessionId,
        incoming.workerSequence,
      );
      const prior = this.#sequences.get(cursorKey);
      if (prior !== undefined && prior !== storageKey) {
        throw new Error(
          "Voice webhook worker sequence was reused by another source.",
        );
      }
      this.#sequences.set(cursorKey, storageKey);
    }
    this.#sources.set(storageKey, incoming);
    return "inserted";
  }

  async getSource(
    projectId: string,
    eventId: string,
  ): Promise<VoiceWebhookSourceRecord | undefined> {
    const source = this.#sources.get(key(projectId, eventId));
    return source === undefined ? undefined : structuredClone(source);
  }
}
