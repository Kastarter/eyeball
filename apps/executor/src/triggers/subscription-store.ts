import type {
  TriggerSubscription,
  TriggerSubscriptionId,
  TriggerSubscriptionPage,
} from "@eyeball/core";

export interface StoredTriggerSubscription extends TriggerSubscription {
  /** SHA-256 digest; the plaintext ingest secret is returned only at creation. */
  ingestSecretHash?: string;
}

export interface ListTriggerSubscriptionsInput {
  cursor?: string;
  limit: number;
  userId?: string;
}

export interface TriggerSubscriptionStore {
  create(subscription: StoredTriggerSubscription): Promise<TriggerSubscription>;
  get(
    projectId: string,
    subscriptionId: string,
  ): Promise<TriggerSubscription | undefined>;
  getInternal(
    subscriptionId: string,
  ): Promise<StoredTriggerSubscription | undefined>;
  list(
    projectId: string,
    input: ListTriggerSubscriptionsInput,
  ): Promise<TriggerSubscriptionPage>;
  listActive(): Promise<readonly StoredTriggerSubscription[]>;
  delete(projectId: string, subscriptionId: string): Promise<boolean>;
}

export class TriggerSubscriptionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerSubscriptionStoreError";
  }
}

export class InvalidTriggerSubscriptionCursorError extends TriggerSubscriptionStoreError {
  constructor() {
    super("Trigger subscription cursor is invalid.");
    this.name = "InvalidTriggerSubscriptionCursorError";
  }
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function publicSubscription(
  subscription: StoredTriggerSubscription,
): TriggerSubscription {
  const { ingestSecretHash: _ingestSecretHash, ...result } = subscription;
  return result;
}

export function triggerSubscriptionCursorAfter(
  subscriptionId: TriggerSubscriptionId,
): string {
  return Buffer.from(
    JSON.stringify({ after: subscriptionId }),
    "utf8",
  ).toString("base64url");
}

export function subscriptionIdFromCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("after" in parsed) ||
      typeof parsed.after !== "string" ||
      parsed.after.length === 0
    ) {
      throw new InvalidTriggerSubscriptionCursorError();
    }
    return parsed.after;
  } catch (error) {
    if (error instanceof InvalidTriggerSubscriptionCursorError) throw error;
    throw new InvalidTriggerSubscriptionCursorError();
  }
}

export function validateTriggerSubscriptionListInput(
  input: ListTriggerSubscriptionsInput,
): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new TriggerSubscriptionStoreError(
      "Trigger subscription list limit must be an integer from 1 through 100.",
    );
  }
}

/** Process-local subscription registry. Durable deployments inject another store. */
export class InMemoryTriggerSubscriptionStore
  implements TriggerSubscriptionStore
{
  readonly #projects = new Map<
    string,
    Map<TriggerSubscriptionId, StoredTriggerSubscription>
  >();
  readonly #byId = new Map<TriggerSubscriptionId, StoredTriggerSubscription>();

  async create(
    subscription: StoredTriggerSubscription,
  ): Promise<TriggerSubscription> {
    if (this.#byId.has(subscription.subscriptionId)) {
      throw new Error(
        `Duplicate trigger subscription ID: ${subscription.subscriptionId}`,
      );
    }
    const snapshot = copy(subscription);
    this.#project(subscription.projectId).set(
      subscription.subscriptionId,
      snapshot,
    );
    this.#byId.set(subscription.subscriptionId, snapshot);
    return copy(publicSubscription(snapshot));
  }

  async get(
    projectId: string,
    subscriptionId: string,
  ): Promise<TriggerSubscription | undefined> {
    const subscription = this.#projects
      .get(projectId)
      ?.get(subscriptionId as TriggerSubscriptionId);
    return subscription === undefined
      ? undefined
      : copy(publicSubscription(subscription));
  }

  async getInternal(
    subscriptionId: string,
  ): Promise<StoredTriggerSubscription | undefined> {
    const subscription = this.#byId.get(
      subscriptionId as TriggerSubscriptionId,
    );
    return subscription === undefined ? undefined : copy(subscription);
  }

  async list(
    projectId: string,
    input: ListTriggerSubscriptionsInput,
  ): Promise<TriggerSubscriptionPage> {
    validateTriggerSubscriptionListInput(input);
    const all = [...(this.#projects.get(projectId)?.values() ?? [])]
      .filter(
        (subscription) =>
          input.userId === undefined || subscription.userId === input.userId,
      )
      .reverse();
    let offset = 0;
    if (input.cursor !== undefined) {
      const after = subscriptionIdFromCursor(input.cursor);
      const index = all.findIndex(
        (subscription) => subscription.subscriptionId === after,
      );
      if (index === -1) throw new InvalidTriggerSubscriptionCursorError();
      offset = index + 1;
    }
    const subscriptions = all
      .slice(offset, offset + input.limit)
      .map((subscription) => copy(publicSubscription(subscription)));
    const nextOffset = offset + subscriptions.length;
    const last = subscriptions.at(-1);
    return {
      subscriptions,
      ...(nextOffset < all.length && last !== undefined
        ? { nextCursor: triggerSubscriptionCursorAfter(last.subscriptionId) }
        : {}),
    };
  }

  async listActive(): Promise<readonly StoredTriggerSubscription[]> {
    return [...this.#byId.values()]
      .filter((subscription) => subscription.status === "active")
      .map(copy);
  }

  async delete(projectId: string, subscriptionId: string): Promise<boolean> {
    const project = this.#projects.get(projectId);
    const typedId = subscriptionId as TriggerSubscriptionId;
    if (project?.delete(typedId) !== true) return false;
    this.#byId.delete(typedId);
    if (project.size === 0) this.#projects.delete(projectId);
    return true;
  }

  #project(
    projectId: string,
  ): Map<TriggerSubscriptionId, StoredTriggerSubscription> {
    const existing = this.#projects.get(projectId);
    if (existing !== undefined) return existing;
    const created = new Map<TriggerSubscriptionId, StoredTriggerSubscription>();
    this.#projects.set(projectId, created);
    return created;
  }
}
