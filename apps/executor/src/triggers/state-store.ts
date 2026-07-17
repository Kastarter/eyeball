import type { TriggerSubscriptionId } from "@eyeball/core";

export interface TriggerState {
  subscriptionId: TriggerSubscriptionId;
  cursor?: string;
  nextPollAt?: string;
  updatedAt: string;
}

export interface TriggerStateStore {
  get(subscriptionId: TriggerSubscriptionId): Promise<TriggerState | undefined>;
  put(state: TriggerState): Promise<void>;
  delete(subscriptionId: TriggerSubscriptionId): Promise<void>;
  /** Atomically claims a provider identity within the supplied retention window. */
  claimProviderEvent(
    subscriptionId: TriggerSubscriptionId,
    providerEventId: string,
    now: string,
    expiresAt: string,
  ): Promise<boolean>;
}

export function validTriggerTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${field} must be a valid timestamp.`);
  }
  return timestamp;
}

/** Process-local cursor and dedup state. Durable deployments inject another store. */
export class InMemoryTriggerStateStore implements TriggerStateStore {
  readonly #states = new Map<TriggerSubscriptionId, TriggerState>();
  readonly #claims = new Map<TriggerSubscriptionId, Map<string, number>>();

  async get(
    subscriptionId: TriggerSubscriptionId,
  ): Promise<TriggerState | undefined> {
    const state = this.#states.get(subscriptionId);
    return state === undefined ? undefined : structuredClone(state);
  }

  async put(state: TriggerState): Promise<void> {
    validTriggerTimestamp(state.updatedAt, "Trigger state updatedAt");
    if (state.nextPollAt !== undefined) {
      validTriggerTimestamp(state.nextPollAt, "Trigger state nextPollAt");
    }
    this.#states.set(state.subscriptionId, structuredClone(state));
  }

  async delete(subscriptionId: TriggerSubscriptionId): Promise<void> {
    this.#states.delete(subscriptionId);
    this.#claims.delete(subscriptionId);
  }

  async claimProviderEvent(
    subscriptionId: TriggerSubscriptionId,
    providerEventId: string,
    now: string,
    expiresAt: string,
  ): Promise<boolean> {
    if (providerEventId.length === 0) {
      throw new Error("Provider event ID must not be empty.");
    }
    const nowMs = validTriggerTimestamp(now, "Dedup claim now");
    const expiresAtMs = validTriggerTimestamp(
      expiresAt,
      "Dedup claim expiresAt",
    );
    if (expiresAtMs <= nowMs) {
      throw new Error("Dedup claim expiry must be later than now.");
    }
    const claims =
      this.#claims.get(subscriptionId) ?? new Map<string, number>();
    this.#claims.set(subscriptionId, claims);
    for (const [eventId, expiry] of claims) {
      if (expiry <= nowMs) claims.delete(eventId);
    }
    const existing = claims.get(providerEventId);
    if (existing !== undefined && existing > nowMs) return false;
    claims.set(providerEventId, expiresAtMs);
    return true;
  }
}
