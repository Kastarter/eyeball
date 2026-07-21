import {
  type CreatedTriggerSubscription,
  projectTriggerSubscription,
  type RotatedTriggerIngestSecret,
  type TriggerSubscription,
} from "@/src/lib/api";

export interface RevealedTriggerIngestUrl {
  context: "created" | "rotated";
  subscriptionId: string;
  value: string;
}

export interface TriggerState {
  subscriptions: readonly TriggerSubscription[];
  nextCursor?: string;
  revealedIngestUrl?: RevealedTriggerIngestUrl;
}

export type TriggerStateAction =
  | {
      type: "listLoaded";
      subscriptions: readonly TriggerSubscription[];
      nextCursor?: string;
      append?: boolean;
    }
  | { type: "subscriptionCreated"; subscription: CreatedTriggerSubscription }
  | { type: "ingestSecretRotated"; rotation: RotatedTriggerIngestSecret }
  | { type: "subscriptionDeleted"; subscriptionId: string }
  | { type: "revealClosed" };

function publicCreatedSubscription(
  subscription: CreatedTriggerSubscription,
): TriggerSubscription {
  return projectTriggerSubscription({
    subscriptionId: subscription.subscriptionId,
    userId: subscription.userId,
    trigger: subscription.trigger,
    ...(subscription.connectionId === undefined
      ? {}
      : { connectionId: subscription.connectionId }),
    webhookEndpointIds: subscription.webhookEndpointIds,
    ...(subscription.filters === undefined
      ? {}
      : { filters: subscription.filters }),
    ...(subscription.pollIntervalSeconds === undefined
      ? {}
      : { pollIntervalSeconds: subscription.pollIntervalSeconds }),
    status: subscription.status,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  });
}

export function createTriggerState(
  subscriptions: readonly TriggerSubscription[] = [],
  nextCursor?: string,
): TriggerState {
  return {
    subscriptions: subscriptions.map(projectTriggerSubscription),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function triggerStateReducer(
  state: TriggerState,
  action: TriggerStateAction,
): TriggerState {
  if (action.type === "listLoaded") {
    const projected = action.subscriptions.map(projectTriggerSubscription);
    const subscriptions = action.append
      ? [
          ...state.subscriptions.filter(
            (subscription) =>
              !projected.some(
                (candidate) =>
                  candidate.subscriptionId === subscription.subscriptionId,
              ),
          ),
          ...projected,
        ]
      : projected;
    return {
      subscriptions,
      ...(action.nextCursor === undefined
        ? {}
        : { nextCursor: action.nextCursor }),
      ...(state.revealedIngestUrl === undefined
        ? {}
        : { revealedIngestUrl: state.revealedIngestUrl }),
    };
  }
  if (action.type === "subscriptionCreated") {
    const subscription = publicCreatedSubscription(action.subscription);
    return {
      ...state,
      subscriptions: [
        subscription,
        ...state.subscriptions.filter(
          (candidate) =>
            candidate.subscriptionId !== subscription.subscriptionId,
        ),
      ],
      ...(action.subscription.ingestUrl === undefined
        ? {}
        : {
            revealedIngestUrl: {
              context: "created",
              subscriptionId: subscription.subscriptionId,
              value: action.subscription.ingestUrl,
            },
          }),
    };
  }
  if (action.type === "ingestSecretRotated") {
    return {
      ...state,
      subscriptions: state.subscriptions.map((subscription) =>
        subscription.subscriptionId === action.rotation.subscriptionId
          ? { ...subscription, updatedAt: action.rotation.rotatedAt }
          : subscription,
      ),
      revealedIngestUrl: {
        context: "rotated",
        subscriptionId: action.rotation.subscriptionId,
        value: action.rotation.ingestUrl,
      },
    };
  }
  if (action.type === "subscriptionDeleted") {
    const subscriptions = state.subscriptions.filter(
      (subscription) => subscription.subscriptionId !== action.subscriptionId,
    );
    if (state.revealedIngestUrl?.subscriptionId === action.subscriptionId) {
      return {
        subscriptions,
        ...(state.nextCursor === undefined
          ? {}
          : { nextCursor: state.nextCursor }),
      };
    }
    return {
      ...state,
      subscriptions,
    };
  }
  return {
    subscriptions: state.subscriptions,
    ...(state.nextCursor === undefined ? {} : { nextCursor: state.nextCursor }),
  };
}

export function confirmTriggerIngestRotation(
  subscription: TriggerSubscription,
  confirm: (message: string) => boolean,
): boolean {
  return confirm(
    `Rotate the push ingest URL for ${subscription.subscriptionId}? The old ingest URL stops accepting provider events immediately.`,
  );
}

export function confirmTriggerDeletion(
  subscription: TriggerSubscription,
  confirm: (message: string) => boolean,
): boolean {
  return confirm(
    `Delete ${subscription.subscriptionId}? The provider stops delivering ${subscription.trigger} events for this subscription immediately.`,
  );
}
