import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExecutorApiError,
  ExecutorClient,
  type TriggerSubscription,
} from "@/src/lib/api";
import type { CatalogTriggerSubscriptionOption } from "@/src/lib/catalog";
import {
  confirmTriggerDeletion,
  confirmTriggerIngestRotation,
  createTriggerState,
  triggerStateReducer,
} from "./trigger-state";
import {
  subscriptionDeliveryMode,
  TriggerSubscriptionDrawer,
  validateTriggerPollInterval,
} from "./trigger-subscription-drawer";
import {
  classifyTriggerExecutorFailure,
  parseTriggerDrawerQuery,
  TriggerFilteredEmptyState,
  TriggerLoadBanner,
  TriggersScreen,
} from "./triggers-screen";

const CREATED_INGEST_URL =
  "https://executor.example.test/v1/ingest/trgsub_created/ingest_url_must_not_render";
const ROTATED_INGEST_URL =
  "https://executor.example.test/v1/ingest/trgsub_fixture/rotated_ingest_url_must_not_persist";

const pushSubscription: TriggerSubscription = {
  subscriptionId: "trgsub_fixture",
  userId: "demo_user",
  trigger: "slack.message_received",
  connectionId: "conn_slack_fixture",
  webhookEndpointIds: ["whe_fixture"],
  status: "active",
  createdAt: "2026-07-21T09:00:00.000Z",
  updatedAt: "2026-07-21T09:05:00.000Z",
};

const pollSubscription: TriggerSubscription = {
  subscriptionId: "trgsub_polling",
  userId: "demo_user",
  trigger: "gmail.email_received",
  webhookEndpointIds: ["whe_fixture", "whe_second"],
  pollIntervalSeconds: 120,
  status: "paused",
  createdAt: "2026-07-21T08:00:00.000Z",
  updatedAt: "2026-07-21T08:30:00.000Z",
};

const catalogTriggerOptions: readonly CatalogTriggerSubscriptionOption[] = [
  {
    defaultIntervalSeconds: 120,
    description: "A new Gmail message arrived in the inbox.",
    minimumIntervalSeconds: 60,
    mode: "polling",
    toolkit: "gmail",
    trigger: "gmail.email_received",
  },
  {
    description: "A Slack message was received.",
    mode: "push",
    toolkit: "slack",
    trigger: "slack.message_received",
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
  onRefreshSubscriptions: () => undefined,
  onRotated: () => undefined,
};

describe("TriggersScreen", () => {
  it("renders subscription metadata and never renders unknown ingest URL fields", () => {
    const subscriptionWithIngestUrl = {
      ...pushSubscription,
      ingestUrl: CREATED_INGEST_URL,
    } as unknown as TriggerSubscription;
    const markup = renderToStaticMarkup(
      <TriggersScreen
        catalogTriggerOptions={catalogTriggerOptions}
        initialSubscriptions={[subscriptionWithIngestUrl, pollSubscription]}
        project="proj_fixture"
      />,
    );

    expect(markup).toContain("Triggers");
    expect(markup).toContain("New subscription");
    expect(markup).toContain(pushSubscription.subscriptionId);
    expect(markup).toContain("slack.message_received");
    expect(markup).toContain("gmail.email_received");
    expect(markup).toContain("push");
    expect(markup).toContain("poll · 120s");
    expect(markup).toContain("demo_user");
    expect(markup).toContain("Jul 21, 2026, 09:05");
    expect(markup).not.toContain(CREATED_INGEST_URL);
  });

  it("distinguishes a true empty project from filtered-empty results", () => {
    const emptyMarkup = renderToStaticMarkup(
      <TriggersScreen
        catalogTriggerOptions={catalogTriggerOptions}
        initialSubscriptions={[]}
        project="proj_fixture"
      />,
    );
    const filteredMarkup = renderToStaticMarkup(
      <TriggerFilteredEmptyState onClear={() => undefined} />,
    );

    expect(emptyMarkup).toContain("No trigger subscriptions");
    expect(emptyMarkup).toContain("eyeball.subscriptions.create");
    expect(emptyMarkup).toContain("Create subscription");
    expect(emptyMarkup).not.toContain("match these filters");
    expect(filteredMarkup).toContain(
      "No trigger subscriptions match these filters",
    );
    expect(filteredMarkup).toContain("Clear filters");
    expect(filteredMarkup).not.toContain("eyeball.subscriptions.create");
  });

  it("renders specific setup, scope, and offline guidance", () => {
    const markup = renderToStaticMarkup(
      <div>
        <TriggerLoadBanner
          cloud={false}
          onRetry={() => undefined}
          project="demo"
          state="unconfigured"
        />
        <TriggerLoadBanner
          cloud
          onRetry={() => undefined}
          project="proj_fixture"
          state="forbidden"
        />
        <TriggerLoadBanner
          cloud={false}
          onRetry={() => undefined}
          project="demo"
          state="offline"
        />
      </div>,
    );

    expect(markup).toContain("EYEBALL_API_KEY");
    expect(markup).toContain("Project key user pin conflict");
    expect(markup).toContain("Open Settings");
    expect(markup).toContain("Executor offline");
    expect(markup.match(/Retry/g)).toHaveLength(3);
  });

  it("classifies executor failures without losing normalized codes", () => {
    expect(
      classifyTriggerExecutorFailure(new ExecutorApiError("Missing", 401))
        .state,
    ).toBe("unconfigured");
    expect(
      classifyTriggerExecutorFailure(
        new ExecutorApiError("Scope", 403, {
          code: "auth_insufficient_scope",
        }),
      ).state,
    ).toBe("forbidden");
    expect(
      classifyTriggerExecutorFailure(new ExecutorApiError("Offline", 502))
        .state,
    ).toBe("offline");
    expect(
      classifyTriggerExecutorFailure(
        new ExecutorApiError("Missing URL", 503, {
          code: "executor_not_configured",
        }),
      ).state,
    ).toBe("not_configured");
  });

  it("restores drawer state from history navigation query parameters", () => {
    expect(
      parseTriggerDrawerQuery(
        new URL("https://dashboard.example.test/demo/triggers?new=true"),
      ),
    ).toEqual({ newSubscriptionOpen: true });
    expect(
      parseTriggerDrawerQuery(
        new URL(
          "https://dashboard.example.test/demo/triggers?subscription=trgsub_fixture",
        ),
      ),
    ).toEqual({
      newSubscriptionOpen: false,
      selectedSubscriptionId: "trgsub_fixture",
    });
    expect(
      parseTriggerDrawerQuery(
        new URL("https://dashboard.example.test/demo/triggers"),
      ),
    ).toEqual({ newSubscriptionOpen: false });
  });
});

describe("TriggerSubscriptionDrawer", () => {
  it("renders a create form with trigger, user, endpoints, and mode semantics", () => {
    const markup = renderToStaticMarkup(
      <TriggerSubscriptionDrawer
        {...callbacks}
        catalogTriggerOptions={catalogTriggerOptions}
        client={client}
        mode="create"
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("New trigger subscription");
    expect(markup).toContain("Canonical trigger");
    expect(markup).toContain("gmail.email_received · polling");
    expect(markup).toContain("slack.message_received · push");
    expect(markup).toContain("User ID");
    expect(markup).toContain("Connection ID");
    expect(markup).toContain("Deliver events to");
    expect(markup).toContain("Poll interval (seconds)");
    expect(markup).toContain("minimum 60s");
  });

  it("renders metadata-only manage view with push rotation and delete actions", () => {
    const markup = renderToStaticMarkup(
      <TriggerSubscriptionDrawer
        {...callbacks}
        catalogTriggerOptions={catalogTriggerOptions}
        client={client}
        mode="manage"
        subscription={pushSubscription}
        subscriptionId={pushSubscription.subscriptionId}
      />,
    );

    expect(markup).toContain(pushSubscription.subscriptionId);
    expect(markup).toContain("slack.message_received");
    expect(markup).toContain("conn_slack_fixture");
    expect(markup).toContain("whe_fixture");
    expect(markup).toContain("Rotate ingest URL");
    expect(markup).toContain("Delete subscription");
    expect(markup).toContain("recreate to change targets");
    expect(markup).not.toContain(CREATED_INGEST_URL);
    expect(markup).not.toContain(ROTATED_INGEST_URL);
  });

  it("hides push ingest rotation for polling subscriptions", () => {
    const markup = renderToStaticMarkup(
      <TriggerSubscriptionDrawer
        {...callbacks}
        catalogTriggerOptions={catalogTriggerOptions}
        client={client}
        mode="manage"
        subscription={pollSubscription}
        subscriptionId={pollSubscription.subscriptionId}
      />,
    );

    expect(markup).toContain("Poll interval");
    expect(markup).toContain("120s");
    expect(markup).not.toContain("Rotate ingest URL");
    expect(markup).toContain("Delete subscription");
  });

  it("validates poll intervals against catalog minimums", () => {
    const polling = catalogTriggerOptions[0];
    expect(validateTriggerPollInterval("120", polling)).toBeUndefined();
    expect(validateTriggerPollInterval("59", polling)).toContain(
      "minimum is 60 seconds",
    );
    expect(validateTriggerPollInterval("abc", polling)).toContain(
      "whole number",
    );
    expect(
      validateTriggerPollInterval("anything", catalogTriggerOptions[1]),
    ).toBeUndefined();
    expect(
      subscriptionDeliveryMode("slack.message_received", catalogTriggerOptions),
    ).toBe("push");
    expect(
      subscriptionDeliveryMode("gmail.email_received", catalogTriggerOptions),
    ).toBe("polling");
    expect(
      subscriptionDeliveryMode("unknown.trigger", catalogTriggerOptions),
    ).toBeUndefined();
  });
});

describe("trigger reveal-once state", () => {
  it("reveals push ingest URLs once, survives refresh, and discards the reveal", () => {
    let state = createTriggerState([pushSubscription]);
    state = triggerStateReducer(state, {
      type: "subscriptionCreated",
      subscription: {
        ...pushSubscription,
        subscriptionId: "trgsub_created",
        ingestUrl: CREATED_INGEST_URL,
      },
    });

    expect(JSON.stringify(state.subscriptions)).not.toContain(
      CREATED_INGEST_URL,
    );
    expect(state.revealedIngestUrl?.value).toBe(CREATED_INGEST_URL);
    state = triggerStateReducer(state, {
      type: "listLoaded",
      subscriptions: state.subscriptions,
    });
    expect(state.revealedIngestUrl?.value).toBe(CREATED_INGEST_URL);
    state = triggerStateReducer(state, { type: "revealClosed" });
    expect(state.revealedIngestUrl).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain(CREATED_INGEST_URL);
  });

  it("does not open a reveal for polling subscriptions without ingest URLs", () => {
    let state = createTriggerState([]);
    state = triggerStateReducer(state, {
      type: "subscriptionCreated",
      subscription: pollSubscription,
    });
    expect(state.subscriptions).toHaveLength(1);
    expect(state.revealedIngestUrl).toBeUndefined();
  });

  it("rotates, closes, and deletes public subscription state", () => {
    let state = createTriggerState([pushSubscription]);
    state = triggerStateReducer(state, {
      type: "ingestSecretRotated",
      rotation: {
        subscriptionId: pushSubscription.subscriptionId,
        ingestUrl: ROTATED_INGEST_URL,
        rotatedAt: "2026-07-21T10:00:00.000Z",
      },
    });
    expect(state.subscriptions[0]?.updatedAt).toBe("2026-07-21T10:00:00.000Z");
    expect(JSON.stringify(state.subscriptions)).not.toContain(
      ROTATED_INGEST_URL,
    );
    expect(state.revealedIngestUrl?.value).toBe(ROTATED_INGEST_URL);
    state = triggerStateReducer(state, { type: "revealClosed" });
    expect(JSON.stringify(state)).not.toContain(ROTATED_INGEST_URL);

    state = triggerStateReducer(state, {
      type: "subscriptionDeleted",
      subscriptionId: pushSubscription.subscriptionId,
    });
    expect(state.subscriptions).toHaveLength(0);
  });

  it("honors confirmation cancellation and states immediate consequences", () => {
    let rotationMessage = "";
    let deletionMessage = "";
    expect(confirmTriggerIngestRotation(pushSubscription, () => false)).toBe(
      false,
    );
    expect(confirmTriggerDeletion(pushSubscription, () => false)).toBe(false);
    expect(
      confirmTriggerIngestRotation(pushSubscription, (message) => {
        rotationMessage = message;
        return true;
      }),
    ).toBe(true);
    expect(
      confirmTriggerDeletion(pushSubscription, (message) => {
        deletionMessage = message;
        return true;
      }),
    ).toBe(true);
    expect(rotationMessage).toContain("stops accepting provider events");
    expect(deletionMessage).toContain("stops delivering");
    expect(deletionMessage).toContain("slack.message_received");
  });
});
