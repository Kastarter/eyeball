import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExecutorClient,
  type TriggerEvent,
  type TriggerEventDeliveryStatus,
} from "@/src/lib/api";
import {
  mergeTriggerEvents,
  TriggerEventsTab,
  triggerEventUtcLabel,
  triggerEventView,
} from "./trigger-events-tab";

const client = new ExecutorClient({
  baseUrl: "https://executor.example.test",
  fetch: (async () => {
    throw new Error("Static-render tests must not fetch.");
  }) as typeof globalThis.fetch,
});

function eventFixture(
  arrivalId: string,
  deliveryStatus: TriggerEventDeliveryStatus = "succeeded",
  overrides: Partial<TriggerEvent> = {},
): TriggerEvent {
  return {
    arrivalId,
    eventId: `evt_trigger_${arrivalId}`,
    subscriptionId: "trgsub_fixture",
    trigger: "slack.message_received",
    deliveryMode: "push",
    receivedAt: "2026-07-21T14:00:00.000Z",
    occurredAt: "2026-07-21T13:59:58.000Z",
    dedupStatus: deliveryStatus === "not_enqueued" ? "duplicate" : "accepted",
    deliveryStatus,
    requestedWebhookEndpointIds: ["whe_fixture", "whe_second"],
    deliveryTargets:
      deliveryStatus === "partial"
        ? [
            {
              endpointId: "whe_fixture",
              deliveryId: "whd_success",
              status: "succeeded",
            },
            {
              endpointId: "whe_second",
              deliveryId: "whd_failed",
              status: "failed",
            },
          ]
        : deliveryStatus === "succeeded"
          ? [
              {
                endpointId: "whe_fixture",
                deliveryId: "whd_fixture",
                status: "succeeded",
              },
            ]
          : [],
    expiresAt: "2026-07-28T14:00:00.000Z",
    ...overrides,
  };
}

describe("TriggerEventsTab", () => {
  it("renders an initial loading skeleton without a page", () => {
    const markup = renderToStaticMarkup(<TriggerEventsTab client={client} />);

    expect(markup).toContain("Trigger events loading");
    expect(markup).not.toContain("No recent events");
  });

  it("distinguishes confirmed empty history and renders its terminal footer", () => {
    const markup = renderToStaticMarkup(
      <TriggerEventsTab client={client} initialPage={{ triggerEvents: [] }} />,
    );

    expect(markup).toContain("No recent events");
    expect(markup).toContain("0 events · End of history");
  });

  it("renders metadata-only arrivals, every aggregate status, and target outcomes", () => {
    const statuses: readonly TriggerEventDeliveryStatus[] = [
      "not_enqueued",
      "admission_failed",
      "selecting",
      "no_targets",
      "pending",
      "delivering",
      "succeeded",
      "failed",
      "partial",
    ];
    const forbidden = {
      payload: "payload-must-not-render",
      providerEventId: "provider-event-must-not-render",
      rawBody: "raw-body-must-not-render",
      pushSecret: "push-secret-must-not-render",
      accessToken: "access-token-must-not-render",
      endpointUrl: "endpoint-url-must-not-render",
      responseBody: "response-body-must-not-render",
    };
    const triggerEvents = statuses.map((status, index) => ({
      ...eventFixture(`trgevt_${index}`, status),
      ...(index === 0 ? forbidden : {}),
      deliveryTargets:
        status === "succeeded"
          ? [
              {
                endpointId: "whe_fixture",
                deliveryId: "whd_fixture",
                status: "succeeded" as const,
                ...forbidden,
              },
            ]
          : eventFixture(`trgevt_${index}`, status).deliveryTargets,
    })) as unknown as readonly TriggerEvent[];

    const markup = renderToStaticMarkup(
      <TriggerEventsTab
        client={client}
        initialPage={{ nextCursor: "cursor_2", triggerEvents }}
      />,
    );

    for (const label of [
      "Not enqueued",
      "Admission failed",
      "Selecting",
      "No targets",
      "Pending",
      "Delivering",
      "Succeeded",
      "Failed",
      "Partial",
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Accepted");
    expect(markup).toContain("Duplicate");
    expect(markup).toContain("slack.message_received");
    expect(markup).toContain("trgsub_fixture");
    expect(markup).toContain("2 requested · 2 actual");
    expect(markup).toContain("whe_fixture");
    expect(markup).toContain("whd_success");
    expect(markup).toContain("Jul 21, 2026, 14:00:00");
    expect(markup).toContain("Load more");
    expect(markup).not.toContain("End of history");
    for (const sentinel of Object.values(forbidden)) {
      expect(markup).not.toContain(sentinel);
    }
  });

  it("merges by arrival ID and keeps newest-first stable ordering", () => {
    const oldest = eventFixture("trgevt_old", "pending", {
      receivedAt: "2026-07-21T13:00:00.000Z",
    });
    const tiedFirst = eventFixture("trgevt_tie_a", "pending");
    const tiedSecond = eventFixture("trgevt_tie_b", "pending");
    const replacement = eventFixture("trgevt_old", "succeeded", {
      receivedAt: "2026-07-21T15:00:00.000Z",
    });

    expect(
      mergeTriggerEvents([oldest, tiedFirst], [tiedSecond, replacement]).map(
        (event) => `${event.arrivalId}:${event.deliveryStatus}`,
      ),
    ).toEqual([
      "trgevt_old:succeeded",
      "trgevt_tie_a:pending",
      "trgevt_tie_b:pending",
    ]);
  });

  it("classifies loading, empty, full-error, and inline-error table states", () => {
    expect(triggerEventView("loading", 0)).toBe("loading");
    expect(triggerEventView("ready", 0)).toBe("empty");
    expect(triggerEventView("error", 0)).toBe("full-error");
    expect(triggerEventView("error", 2)).toBe("table");
    expect(triggerEventView("ready", 2)).toBe("table");
  });

  it("formats timestamps in UTC with seconds", () => {
    expect(triggerEventUtcLabel("2026-07-21T14:00:09.000Z")).toBe(
      "Jul 21, 2026, 14:00:09",
    );
  });
});
