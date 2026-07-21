import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExecutorApiError,
  ExecutorClient,
  type WebhookDeliveryPage,
  type WebhookEndpoint,
} from "@/src/lib/api";
import type { CatalogWebhookTriggerOption } from "@/src/lib/catalog";
import { WebhookDeliveriesTab } from "./webhook-deliveries-tab";
import { WebhookEndpointDrawer } from "./webhook-endpoint-drawer";
import {
  confirmWebhookDeletion,
  confirmWebhookSecretRotation,
  createWebhookState,
  webhookStateReducer,
} from "./webhook-state";
import {
  classifyWebhookExecutorFailure,
  WebhookFilteredEmptyState,
  WebhookLoadBanner,
  WebhooksScreen,
} from "./webhooks-screen";

const FULL_SECRET = "whsec_full_secret_must_not_render";
const ROTATED_SECRET = "whsec_rotated_secret_must_not_persist";

const endpoint: WebhookEndpoint = {
  endpointId: "whe_fixture",
  url: "https://receiver.example.test/eyeball",
  secretPrefix: "whsec_fixt",
  events: ["execution.completed", "trigger.slack.message_received"],
  active: true,
  createdAt: "2026-07-20T12:00:00.000Z",
  updatedAt: "2026-07-20T12:05:00.000Z",
};

const catalogTriggerOptions: readonly CatalogWebhookTriggerOption[] = [
  {
    description: "A Slack message was received.",
    label: "slack.message_received",
    toolkit: "slack",
    value: "trigger.slack.message_received",
  },
];

const client = new ExecutorClient({
  baseUrl: "https://executor.example.test",
  fetch: (async () => {
    throw new Error("Static-render tests must not fetch.");
  }) as typeof globalThis.fetch,
});

const callbacks = {
  onClose: () => undefined,
  onCreated: () => undefined,
  onDeleted: () => undefined,
  onRefreshEndpoints: () => undefined,
  onRotated: () => undefined,
  onTabChange: () => undefined,
  onUpdated: () => undefined,
};

function deliveryFixture(nextCursor?: string): WebhookDeliveryPage {
  return {
    deliveries: [
      {
        deliveryId: "whd_fixture",
        endpointId: endpoint.endpointId,
        eventId: "evt_fixture",
        eventType: "execution.completed",
        status: "delivering",
        attempts: [
          {
            attempt: 1,
            attemptedAt: "2026-07-20T12:10:00.000Z",
            completedAt: "2026-07-20T12:10:00.250Z",
            statusCode: 503,
            responseBody: "RESPONSE_BODY_SENTINEL",
          },
          {
            attempt: 2,
            attemptedAt: "2026-07-20T12:11:00.000Z",
            completedAt: "2026-07-20T12:11:01.250Z",
            error: "Connection refused by receiver",
            requestBody: "REQUEST_BODY_SENTINEL",
          },
        ],
        createdAt: "2026-07-20T12:09:00.000Z",
        nextRetryAt: "2026-07-20T12:12:00.000Z",
        payload: "PAYLOAD_SENTINEL",
        headers: "HEADER_SENTINEL",
        secret: "DELIVERY_SECRET_SENTINEL",
      },
    ],
    ...(nextCursor === undefined ? {} : { nextCursor }),
  } as unknown as WebhookDeliveryPage;
}

describe("WebhooksScreen", () => {
  it("renders endpoint metadata and never renders unknown secret fields", () => {
    const endpointWithSecret = {
      ...endpoint,
      secret: FULL_SECRET,
    } as unknown as WebhookEndpoint;
    const markup = renderToStaticMarkup(
      <WebhooksScreen
        catalogTriggerOptions={catalogTriggerOptions}
        initialEndpoints={[endpointWithSecret]}
        project="proj_fixture"
      />,
    );

    expect(markup).toContain("Webhooks");
    expect(markup).toContain("New endpoint");
    expect(markup).toContain(endpoint.url);
    expect(markup).toContain(endpoint.endpointId);
    expect(markup).toContain("execution.completed");
    expect(markup).toContain("trigger.slack.message_received");
    expect(markup).toContain("Active");
    expect(markup).toContain(endpoint.secretPrefix);
    expect(markup).toContain("Jul 20, 2026, 12:05");
    expect(markup).not.toContain(FULL_SECRET);
  });

  it("distinguishes a true empty project from filtered-empty results", () => {
    const emptyMarkup = renderToStaticMarkup(
      <WebhooksScreen
        catalogTriggerOptions={catalogTriggerOptions}
        initialEndpoints={[]}
        project="proj_fixture"
      />,
    );
    const filteredMarkup = renderToStaticMarkup(
      <WebhookFilteredEmptyState onClear={() => undefined} />,
    );

    expect(emptyMarkup).toContain("No webhook endpoints");
    expect(emptyMarkup).toContain("eyeball.webhooks.create");
    expect(emptyMarkup).toContain("Create endpoint");
    expect(emptyMarkup).not.toContain("match these filters");
    expect(filteredMarkup).toContain(
      "No webhook endpoints match these filters",
    );
    expect(filteredMarkup).toContain("Clear filters");
    expect(filteredMarkup).not.toContain("eyeball.webhooks.create");
  });

  it("renders specific setup, scope, and offline guidance", () => {
    const markup = renderToStaticMarkup(
      <div>
        <WebhookLoadBanner
          cloud={false}
          onRetry={() => undefined}
          project="demo"
          state="unconfigured"
        />
        <WebhookLoadBanner
          cloud
          onRetry={() => undefined}
          project="proj_fixture"
          state="forbidden"
        />
        <WebhookLoadBanner
          cloud={false}
          onRetry={() => undefined}
          project="demo"
          state="offline"
        />
      </div>,
    );

    expect(markup).toContain("EYEBALL_API_KEY");
    expect(markup).toContain("Unpinned project key required");
    expect(markup).toContain("Open Settings");
    expect(markup).toContain("Executor offline");
    expect(markup.match(/Retry/g)).toHaveLength(3);
  });

  it("classifies executor failures without losing normalized codes", () => {
    expect(
      classifyWebhookExecutorFailure(new ExecutorApiError("Missing", 401))
        .state,
    ).toBe("unconfigured");
    expect(
      classifyWebhookExecutorFailure(
        new ExecutorApiError("Scope", 403, {
          code: "auth_insufficient_scope",
        }),
      ).state,
    ).toBe("forbidden");
    expect(
      classifyWebhookExecutorFailure(new ExecutorApiError("Offline", 502))
        .state,
    ).toBe("offline");
    expect(
      classifyWebhookExecutorFailure(
        new ExecutorApiError("Missing URL", 503, {
          code: "executor_not_configured",
        }),
      ).state,
    ).toBe("not_configured");
  });
});

describe("WebhookEndpointDrawer", () => {
  it("renders an explicit create form with URL, active, and event semantics", () => {
    const markup = renderToStaticMarkup(
      <WebhookEndpointDrawer
        {...callbacks}
        catalogTriggerOptions={catalogTriggerOptions}
        client={client}
        mode="create"
        tab="settings"
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("New webhook endpoint");
    expect(markup).toContain("Destination URL");
    expect(markup).toContain("Active");
    expect(markup).toContain("Execution");
    expect(markup).toContain("Voice");
    expect(markup).toContain("Triggers");
    expect(markup).toContain("shown once after creation");
    expect(markup.match(/checked=""/g)).toHaveLength(1);
  });

  it("renders metadata-only edit settings and accessible tabs", () => {
    const markup = renderToStaticMarkup(
      <WebhookEndpointDrawer
        {...callbacks}
        catalogTriggerOptions={catalogTriggerOptions}
        client={client}
        endpoint={endpoint}
        endpointId={endpoint.endpointId}
        mode="edit"
        tab="settings"
      />,
    );

    expect(markup).toContain(endpoint.url);
    expect(markup).toContain(endpoint.secretPrefix);
    expect(markup).not.toContain(FULL_SECRET);
    expect(markup).toContain('role="tablist"');
    expect(markup.match(/role="tab"/g)).toHaveLength(2);
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup).toContain('role="tabpanel"');
    const control = markup.match(
      /aria-controls="([^"]+)" aria-selected="true"/u,
    )?.[1];
    expect(control).toBeDefined();
    expect(markup).toContain(`id="${control}"`);
    expect(markup).toContain("Rotate signing secret");
    expect(markup).toContain("Delete endpoint");
  });
});

describe("WebhookDeliveriesTab", () => {
  it("renders only typed delivery and attempt metadata", () => {
    const markup = renderToStaticMarkup(
      <WebhookDeliveriesTab
        client={client}
        endpointId={endpoint.endpointId}
        initialPage={deliveryFixture("cursor_next")}
        onRefreshEndpoint={() => undefined}
      />,
    );

    expect(markup).toContain("Delivering");
    expect(markup).toContain("whd_fixture");
    expect(markup).toContain("evt_fixture");
    expect(markup).toContain("Attempt 1");
    expect(markup).toContain("250 ms");
    expect(markup).toContain("1.25 s");
    expect(markup).toContain("HTTP 503");
    expect(markup).toContain("Connection refused by receiver");
    expect(markup).toContain("Load more");
    expect(markup).toContain("1 delivery loaded");
    for (const sentinel of [
      "PAYLOAD_SENTINEL",
      "REQUEST_BODY_SENTINEL",
      "RESPONSE_BODY_SENTINEL",
      "HEADER_SENTINEL",
      "DELIVERY_SECRET_SENTINEL",
    ]) {
      expect(markup).not.toContain(sentinel);
    }
  });

  it("renders a true empty delivery history and terminal footer", () => {
    const markup = renderToStaticMarkup(
      <WebhookDeliveriesTab
        client={client}
        endpointId={endpoint.endpointId}
        initialPage={{ deliveries: [] }}
        onRefreshEndpoint={() => undefined}
      />,
    );

    expect(markup).toContain("No deliveries for this endpoint");
    expect(markup).toContain("0 deliveries · End of history");
    expect(markup).not.toContain("Load more");
  });
});

describe("webhook reveal-once state", () => {
  it("separates create secrets, survives metadata refresh, and discards the reveal", () => {
    let state = createWebhookState([endpoint]);
    state = webhookStateReducer(state, {
      type: "endpointCreated",
      endpoint: {
        ...endpoint,
        endpointId: "whe_created",
        secretPrefix: "whsec_crea",
        secret: FULL_SECRET,
      },
    });

    expect(JSON.stringify(state.endpoints)).not.toContain(FULL_SECRET);
    expect(state.revealedSecret?.value).toBe(FULL_SECRET);
    state = webhookStateReducer(state, {
      type: "listLoaded",
      endpoints: state.endpoints,
    });
    expect(state.revealedSecret?.value).toBe(FULL_SECRET);
    state = webhookStateReducer(state, { type: "revealClosed" });
    expect(state.revealedSecret).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain(FULL_SECRET);
  });

  it("updates, rotates, closes, and deletes public endpoint state", () => {
    let state = createWebhookState([endpoint]);
    state = webhookStateReducer(state, {
      type: "endpointUpdated",
      endpoint: { ...endpoint, url: "https://updated.example.test/hook" },
    });
    expect(state.endpoints[0]?.url).toBe("https://updated.example.test/hook");

    state = webhookStateReducer(state, {
      type: "secretRotated",
      rotation: {
        endpointId: endpoint.endpointId,
        secretPrefix: "whsec_rota",
        secret: ROTATED_SECRET,
        rotatedAt: "2026-07-20T13:00:00.000Z",
      },
    });
    expect(state.endpoints[0]?.secretPrefix).toBe("whsec_rota");
    expect(JSON.stringify(state.endpoints)).not.toContain(ROTATED_SECRET);
    expect(state.revealedSecret?.value).toBe(ROTATED_SECRET);
    state = webhookStateReducer(state, { type: "revealClosed" });
    expect(JSON.stringify(state)).not.toContain(ROTATED_SECRET);

    state = webhookStateReducer(state, {
      type: "endpointDeleted",
      endpointId: endpoint.endpointId,
    });
    expect(state.endpoints).toHaveLength(0);
  });

  it("honors confirmation cancellation and states immediate consequences", () => {
    let rotationMessage = "";
    let deletionMessage = "";
    expect(confirmWebhookSecretRotation(endpoint, () => false)).toBe(false);
    expect(confirmWebhookDeletion(endpoint, () => false)).toBe(false);
    expect(
      confirmWebhookSecretRotation(endpoint, (message) => {
        rotationMessage = message;
        return true;
      }),
    ).toBe(true);
    expect(
      confirmWebhookDeletion(endpoint, (message) => {
        deletionMessage = message;
        return true;
      }),
    ).toBe(true);
    expect(rotationMessage).toContain("invalid immediately");
    expect(rotationMessage).toContain("pending retries");
    expect(deletionMessage).toContain("Pending work cannot continue");
    expect(deletionMessage).toContain("history becomes inaccessible");
  });
});
