import {
  type CreatedWebhookEndpoint,
  projectWebhookEndpoint,
  type RotatedWebhookSecret,
  type WebhookEndpoint,
} from "@/src/lib/api";

export interface RevealedWebhookSecret {
  context: "created" | "rotated";
  endpointId: string;
  value: string;
}

export interface WebhookState {
  endpoints: readonly WebhookEndpoint[];
  nextCursor?: string;
  revealedSecret?: RevealedWebhookSecret;
}

export type WebhookStateAction =
  | {
      type: "listLoaded";
      endpoints: readonly WebhookEndpoint[];
      nextCursor?: string;
      append?: boolean;
    }
  | { type: "endpointCreated"; endpoint: CreatedWebhookEndpoint }
  | { type: "endpointUpdated"; endpoint: WebhookEndpoint }
  | { type: "secretRotated"; rotation: RotatedWebhookSecret }
  | { type: "endpointDeleted"; endpointId: string }
  | { type: "revealClosed" };

function publicCreatedEndpoint(
  endpoint: CreatedWebhookEndpoint,
): WebhookEndpoint {
  return projectWebhookEndpoint({
    endpointId: endpoint.endpointId,
    url: endpoint.url,
    secretPrefix: endpoint.secretPrefix,
    events: endpoint.events,
    active: endpoint.active,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  });
}

export function createWebhookState(
  endpoints: readonly WebhookEndpoint[] = [],
  nextCursor?: string,
): WebhookState {
  return {
    endpoints: endpoints.map(projectWebhookEndpoint),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function webhookStateReducer(
  state: WebhookState,
  action: WebhookStateAction,
): WebhookState {
  if (action.type === "listLoaded") {
    const projected = action.endpoints.map(projectWebhookEndpoint);
    const endpoints = action.append
      ? [
          ...state.endpoints.filter(
            (endpoint) =>
              !projected.some(
                (candidate) => candidate.endpointId === endpoint.endpointId,
              ),
          ),
          ...projected,
        ]
      : projected;
    return {
      endpoints,
      ...(action.nextCursor === undefined
        ? {}
        : { nextCursor: action.nextCursor }),
      ...(state.revealedSecret === undefined
        ? {}
        : { revealedSecret: state.revealedSecret }),
    };
  }
  if (action.type === "endpointCreated") {
    const endpoint = publicCreatedEndpoint(action.endpoint);
    return {
      ...state,
      endpoints: [
        endpoint,
        ...state.endpoints.filter(
          (candidate) => candidate.endpointId !== endpoint.endpointId,
        ),
      ],
      revealedSecret: {
        context: "created",
        endpointId: endpoint.endpointId,
        value: action.endpoint.secret,
      },
    };
  }
  if (action.type === "endpointUpdated") {
    const endpoint = projectWebhookEndpoint(action.endpoint);
    return {
      ...state,
      endpoints: state.endpoints.map((candidate) =>
        candidate.endpointId === endpoint.endpointId ? endpoint : candidate,
      ),
    };
  }
  if (action.type === "secretRotated") {
    return {
      ...state,
      endpoints: state.endpoints.map((endpoint) =>
        endpoint.endpointId === action.rotation.endpointId
          ? {
              ...endpoint,
              secretPrefix: action.rotation.secretPrefix,
              updatedAt: action.rotation.rotatedAt,
            }
          : endpoint,
      ),
      revealedSecret: {
        context: "rotated",
        endpointId: action.rotation.endpointId,
        value: action.rotation.secret,
      },
    };
  }
  if (action.type === "endpointDeleted") {
    const endpoints = state.endpoints.filter(
      (endpoint) => endpoint.endpointId !== action.endpointId,
    );
    if (state.revealedSecret?.endpointId === action.endpointId) {
      return {
        endpoints,
        ...(state.nextCursor === undefined
          ? {}
          : { nextCursor: state.nextCursor }),
      };
    }
    return {
      ...state,
      endpoints,
    };
  }
  return {
    endpoints: state.endpoints,
    ...(state.nextCursor === undefined ? {} : { nextCursor: state.nextCursor }),
  };
}

export function confirmWebhookSecretRotation(
  endpoint: WebhookEndpoint,
  confirm: (message: string) => boolean,
): boolean {
  return confirm(
    `Rotate the signing secret for ${endpoint.endpointId}? The old secret becomes invalid immediately, including for pending retries.`,
  );
}

export function confirmWebhookDeletion(
  endpoint: WebhookEndpoint,
  confirm: (message: string) => boolean,
): boolean {
  return confirm(
    `Delete ${endpoint.endpointId}? Pending work cannot continue, and endpoint-scoped delivery history becomes inaccessible through the public API.`,
  );
}
