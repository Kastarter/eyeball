import {
  isCanonicalToolName,
  isTriggerEventArrivalId,
  isTriggerSubscriptionId,
  type QualifiedTriggerName,
  type TriggerEventArrivalId,
  type TriggerEventDedupStatus,
  type TriggerEventDeliveryMode,
  type TriggerSubscriptionId,
} from "@eyeball/core";

export type TriggerEventDeliveryAdmissionStatus =
  | "admitted"
  | "failed"
  | "not_enqueued";

/** Private metadata-only row. Payload-bearing types cannot cross this seam. */
export interface StoredTriggerEvent {
  readonly sequence: number;
  readonly projectId: string;
  readonly arrivalId: TriggerEventArrivalId;
  readonly eventId: string;
  readonly subscriptionId: TriggerSubscriptionId;
  readonly trigger: QualifiedTriggerName;
  readonly deliveryMode: TriggerEventDeliveryMode;
  readonly receivedAt: string;
  readonly occurredAt: string;
  readonly dedupStatus: TriggerEventDedupStatus;
  readonly deliveryAdmissionStatus: TriggerEventDeliveryAdmissionStatus;
  readonly requestedWebhookEndpointIds: readonly string[];
  readonly expiresAt: string;
}

export interface AppendTriggerEventInput {
  readonly arrivalId: TriggerEventArrivalId;
  readonly eventId: string;
  readonly subscriptionId: TriggerSubscriptionId;
  readonly trigger: QualifiedTriggerName;
  readonly deliveryMode: TriggerEventDeliveryMode;
  readonly receivedAt: string;
  readonly occurredAt: string;
  readonly dedupStatus: TriggerEventDedupStatus;
  readonly deliveryAdmissionStatus: TriggerEventDeliveryAdmissionStatus;
  readonly requestedWebhookEndpointIds: readonly string[];
  readonly expiresAt: string;
}

export interface ListTriggerEventsInput {
  readonly cursor?: string;
  readonly limit: number;
  readonly now: string;
  readonly subscriptionId?: TriggerSubscriptionId;
  readonly trigger?: QualifiedTriggerName;
}

export interface StoredTriggerEventPage {
  readonly triggerEvents: readonly StoredTriggerEvent[];
  readonly nextCursor?: string;
}

export interface ExpiredTriggerEventSweepInput {
  readonly limit: number;
  readonly now: string;
}

export interface TriggerEventStore {
  append(
    projectId: string,
    input: AppendTriggerEventInput,
  ): Promise<StoredTriggerEvent>;
  list(
    projectId: string,
    input: ListTriggerEventsInput,
  ): Promise<StoredTriggerEventPage>;
  sweepExpired(input: ExpiredTriggerEventSweepInput): Promise<number>;
}

export class TriggerEventStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerEventStoreError";
  }
}

export class TriggerEventPersistenceError extends TriggerEventStoreError {
  constructor() {
    super("Trigger event persistence failed.");
    this.name = "TriggerEventPersistenceError";
  }
}

export class InvalidTriggerEventCursorError extends TriggerEventStoreError {
  constructor() {
    super("Trigger event cursor is invalid.");
    this.name = "InvalidTriggerEventCursorError";
  }
}

interface TriggerEventCursor {
  readonly after: TriggerEventArrivalId;
  readonly subscriptionId: TriggerSubscriptionId | null;
  readonly trigger: QualifiedTriggerName | null;
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TriggerEventStoreError(`${field} must be a valid timestamp.`);
  }
  return parsed;
}

function normalizedTimestamp(value: string, field: string): string {
  return new Date(timestamp(value, field)).toISOString();
}

export function validateTriggerEventListInput(
  input: ListTriggerEventsInput,
): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new TriggerEventStoreError(
      "Trigger event list limit must be an integer from 1 through 100.",
    );
  }
  timestamp(input.now, "Trigger event list now");
  if (
    input.subscriptionId !== undefined &&
    !isTriggerSubscriptionId(input.subscriptionId)
  ) {
    throw new TriggerEventStoreError(
      "Trigger event subscriptionId filter is invalid.",
    );
  }
  if (input.trigger !== undefined && !isCanonicalToolName(input.trigger)) {
    throw new TriggerEventStoreError(
      "Trigger event trigger filter is invalid.",
    );
  }
}

export function validateTriggerEventSweepInput(
  input: ExpiredTriggerEventSweepInput,
): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new TriggerEventStoreError(
      "Trigger event sweep limit must be a positive safe integer.",
    );
  }
  timestamp(input.now, "Trigger event sweep now");
}

function cursorValue(
  arrivalId: TriggerEventArrivalId,
  input: Pick<ListTriggerEventsInput, "subscriptionId" | "trigger">,
): TriggerEventCursor {
  return {
    after: arrivalId,
    subscriptionId: input.subscriptionId ?? null,
    trigger: input.trigger ?? null,
  };
}

export function triggerEventCursorAfter(
  arrivalId: TriggerEventArrivalId,
  input: Pick<ListTriggerEventsInput, "subscriptionId" | "trigger">,
): string {
  return Buffer.from(
    JSON.stringify(cursorValue(arrivalId, input)),
    "utf8",
  ).toString("base64url");
}

export function triggerEventCursorFromString(
  cursor: string,
): TriggerEventCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new InvalidTriggerEventCursorError();
    }
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) {
      throw new InvalidTriggerEventCursorError();
    }
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 3 ||
      !("after" in parsed) ||
      !("subscriptionId" in parsed) ||
      !("trigger" in parsed) ||
      typeof parsed.after !== "string" ||
      !isTriggerEventArrivalId(parsed.after) ||
      (parsed.subscriptionId !== null &&
        (typeof parsed.subscriptionId !== "string" ||
          !isTriggerSubscriptionId(parsed.subscriptionId))) ||
      (parsed.trigger !== null &&
        (typeof parsed.trigger !== "string" ||
          !isCanonicalToolName(parsed.trigger)))
    ) {
      throw new InvalidTriggerEventCursorError();
    }
    const value = cursorValue(parsed.after, {
      ...(parsed.subscriptionId === null
        ? {}
        : { subscriptionId: parsed.subscriptionId }),
      ...(parsed.trigger === null ? {} : { trigger: parsed.trigger }),
    });
    if (
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url") !==
      cursor
    ) {
      throw new InvalidTriggerEventCursorError();
    }
    return value;
  } catch (error) {
    if (error instanceof InvalidTriggerEventCursorError) throw error;
    throw new InvalidTriggerEventCursorError();
  }
}

export function validateTriggerEventAppend(
  projectId: string,
  input: AppendTriggerEventInput,
): void {
  if (projectId.trim().length === 0) {
    throw new TriggerEventStoreError("Trigger event projectId is required.");
  }
  if (!isTriggerEventArrivalId(input.arrivalId)) {
    throw new TriggerEventStoreError("Trigger event arrivalId is invalid.");
  }
  if (input.eventId.trim().length === 0) {
    throw new TriggerEventStoreError("Trigger event eventId is required.");
  }
  if (!isTriggerSubscriptionId(input.subscriptionId)) {
    throw new TriggerEventStoreError(
      "Trigger event subscriptionId is invalid.",
    );
  }
  if (!isCanonicalToolName(input.trigger)) {
    throw new TriggerEventStoreError("Trigger event trigger is invalid.");
  }
  if (input.deliveryMode !== "push" && input.deliveryMode !== "polling") {
    throw new TriggerEventStoreError("Trigger event deliveryMode is invalid.");
  }
  if (input.dedupStatus !== "accepted" && input.dedupStatus !== "duplicate") {
    throw new TriggerEventStoreError("Trigger event dedupStatus is invalid.");
  }
  if (
    input.deliveryAdmissionStatus !== "admitted" &&
    input.deliveryAdmissionStatus !== "failed" &&
    input.deliveryAdmissionStatus !== "not_enqueued"
  ) {
    throw new TriggerEventStoreError(
      "Trigger event deliveryAdmissionStatus is invalid.",
    );
  }
  if (
    (input.dedupStatus === "duplicate" &&
      input.deliveryAdmissionStatus !== "not_enqueued") ||
    (input.dedupStatus === "accepted" &&
      input.deliveryAdmissionStatus === "not_enqueued")
  ) {
    throw new TriggerEventStoreError(
      "Trigger event dedup and admission statuses are inconsistent.",
    );
  }
  const receivedAt = timestamp(input.receivedAt, "Trigger event receivedAt");
  timestamp(input.occurredAt, "Trigger event occurredAt");
  const expiresAt = timestamp(input.expiresAt, "Trigger event expiresAt");
  if (expiresAt <= receivedAt) {
    throw new TriggerEventStoreError(
      "Trigger event expiresAt must be after receivedAt.",
    );
  }
  if (
    !Array.isArray(input.requestedWebhookEndpointIds) ||
    input.requestedWebhookEndpointIds.some(
      (endpointId) =>
        typeof endpointId !== "string" || endpointId.trim().length === 0,
    ) ||
    new Set(input.requestedWebhookEndpointIds).size !==
      input.requestedWebhookEndpointIds.length
  ) {
    throw new TriggerEventStoreError(
      "Trigger event requested endpoint IDs must be distinct non-empty strings.",
    );
  }
}

export function storedTriggerEvent(
  projectId: string,
  sequence: number,
  input: AppendTriggerEventInput,
): StoredTriggerEvent {
  validateTriggerEventAppend(projectId, input);
  return {
    sequence,
    projectId,
    arrivalId: input.arrivalId,
    eventId: input.eventId,
    subscriptionId: input.subscriptionId,
    trigger: input.trigger,
    deliveryMode: input.deliveryMode,
    receivedAt: normalizedTimestamp(
      input.receivedAt,
      "Trigger event receivedAt",
    ),
    occurredAt: normalizedTimestamp(
      input.occurredAt,
      "Trigger event occurredAt",
    ),
    dedupStatus: input.dedupStatus,
    deliveryAdmissionStatus: input.deliveryAdmissionStatus,
    requestedWebhookEndpointIds: [...input.requestedWebhookEndpointIds],
    expiresAt: normalizedTimestamp(input.expiresAt, "Trigger event expiresAt"),
  };
}

function clone(event: StoredTriggerEvent): StoredTriggerEvent {
  return structuredClone(event);
}

function same(left: StoredTriggerEvent, right: StoredTriggerEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Process-local, project-scoped, metadata-only trigger arrival history. */
export class InMemoryTriggerEventStore implements TriggerEventStore {
  readonly #events = new Map<TriggerEventArrivalId, StoredTriggerEvent>();
  #sequence = 0;

  async append(
    projectId: string,
    input: AppendTriggerEventInput,
  ): Promise<StoredTriggerEvent> {
    const candidate = storedTriggerEvent(projectId, this.#sequence + 1, input);
    const existing = this.#events.get(candidate.arrivalId);
    if (existing !== undefined) {
      if (!same(existing, { ...candidate, sequence: existing.sequence })) {
        throw new TriggerEventStoreError(
          "Trigger event arrivalId was reused with different metadata.",
        );
      }
      return clone(existing);
    }
    this.#sequence += 1;
    this.#events.set(candidate.arrivalId, candidate);
    return clone(candidate);
  }

  async list(
    projectId: string,
    input: ListTriggerEventsInput,
  ): Promise<StoredTriggerEventPage> {
    validateTriggerEventListInput(input);
    const projectEvents = [...this.#events.values()]
      .filter((event) => event.projectId === projectId)
      .sort((left, right) => {
        const time = Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
        return time === 0 ? right.sequence - left.sequence : time;
      });
    let offset = 0;
    if (input.cursor !== undefined) {
      const cursor = triggerEventCursorFromString(input.cursor);
      if (
        cursor.subscriptionId !== (input.subscriptionId ?? null) ||
        cursor.trigger !== (input.trigger ?? null)
      ) {
        throw new InvalidTriggerEventCursorError();
      }
      const anchor = projectEvents.findIndex(
        (event) =>
          event.arrivalId === cursor.after &&
          (input.subscriptionId === undefined ||
            event.subscriptionId === input.subscriptionId) &&
          (input.trigger === undefined || event.trigger === input.trigger),
      );
      if (anchor === -1) throw new InvalidTriggerEventCursorError();
      offset = anchor + 1;
    }
    const now = Date.parse(input.now);
    const live = projectEvents
      .slice(offset)
      .filter(
        (event) =>
          Date.parse(event.expiresAt) > now &&
          (input.subscriptionId === undefined ||
            event.subscriptionId === input.subscriptionId) &&
          (input.trigger === undefined || event.trigger === input.trigger),
      );
    const triggerEvents = live.slice(0, input.limit).map(clone);
    const last = triggerEvents.at(-1);
    return {
      triggerEvents,
      ...(live.length > input.limit && last !== undefined
        ? { nextCursor: triggerEventCursorAfter(last.arrivalId, input) }
        : {}),
    };
  }

  async sweepExpired(input: ExpiredTriggerEventSweepInput): Promise<number> {
    validateTriggerEventSweepInput(input);
    const now = Date.parse(input.now);
    const expired = [...this.#events.entries()]
      .filter(([, event]) => Date.parse(event.expiresAt) <= now)
      .sort(([, left], [, right]) => {
        const expiry = Date.parse(left.expiresAt) - Date.parse(right.expiresAt);
        return expiry === 0 ? left.sequence - right.sequence : expiry;
      })
      .slice(0, input.limit);
    for (const [arrivalId] of expired) this.#events.delete(arrivalId);
    return expired.length;
  }
}
