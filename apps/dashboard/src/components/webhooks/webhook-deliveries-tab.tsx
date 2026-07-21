"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { Skeleton } from "@/src/components/ui/skeleton";
import { TableShell } from "@/src/components/ui/table";
import {
  ExecutorApiError,
  type ExecutorClient,
  projectWebhookDeliveryPage,
  type WebhookDelivery,
  type WebhookDeliveryPage,
} from "@/src/lib/api";

const PAGE_SIZE = 20;

function utcLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    second: "2-digit",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

export function webhookAttemptDuration(
  attemptedAt: string,
  completedAt: string,
): string {
  const duration = Date.parse(completedAt) - Date.parse(attemptedAt);
  if (!Number.isFinite(duration) || duration < 0) return "Unknown";
  if (duration < 1_000) return `${duration} ms`;
  return `${(duration / 1_000).toFixed(duration < 10_000 ? 2 : 1)} s`;
}

function mergeDeliveries(
  current: readonly WebhookDelivery[],
  incoming: readonly WebhookDelivery[],
): readonly WebhookDelivery[] {
  const byId = new Map(
    current.map((delivery) => [delivery.deliveryId, delivery]),
  );
  for (const delivery of incoming) byId.set(delivery.deliveryId, delivery);
  return [...byId.values()].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
}

export interface WebhookDeliveriesTabProps {
  client: ExecutorClient;
  endpointId: string;
  initialPage?: WebhookDeliveryPage | undefined;
  onRefreshEndpoint: () => void;
}

export function WebhookDeliveriesTab({
  client,
  endpointId,
  initialPage,
  onRefreshEndpoint,
}: WebhookDeliveriesTabProps) {
  const projectedInitialPage = useMemo(
    () =>
      initialPage === undefined
        ? undefined
        : projectWebhookDeliveryPage(initialPage),
    [initialPage],
  );
  const [deliveries, setDeliveries] = useState<readonly WebhookDelivery[]>(
    mergeDeliveries([], projectedInitialPage?.deliveries ?? []),
  );
  const [nextCursor, setNextCursor] = useState(
    projectedInitialPage?.nextCursor,
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "stale">(
    projectedInitialPage === undefined ? "loading" : "ready",
  );
  const [error, setError] = useState<{ code: string; message: string }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef<AbortController | undefined>(undefined);

  const loadFirstPage = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setStatus("loading");
    setError(undefined);
    try {
      const page = await client.listWebhookDeliveries(
        endpointId,
        { limit: PAGE_SIZE },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setDeliveries(mergeDeliveries([], page.deliveries));
      setNextCursor(page.nextCursor);
      setStatus("ready");
    } catch (caught) {
      if (controller.signal.aborted) return;
      const apiError = caught instanceof ExecutorApiError ? caught : undefined;
      setStatus(apiError?.status === 404 ? "stale" : "error");
      setError({
        code: apiError?.code ?? "executor_unavailable",
        message:
          apiError?.message ??
          "Delivery history could not be loaded from the executor.",
      });
    }
  }, [client, endpointId]);

  useEffect(() => {
    if (projectedInitialPage !== undefined) {
      setDeliveries(mergeDeliveries([], projectedInitialPage.deliveries));
      setNextCursor(projectedInitialPage.nextCursor);
      setStatus("ready");
      setError(undefined);
      return;
    }
    void loadFirstPage();
    return () => requestRef.current?.abort();
  }, [loadFirstPage, projectedInitialPage]);

  useEffect(() => () => requestRef.current?.abort(), []);

  async function loadMore() {
    if (nextCursor === undefined || loadingMore) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoadingMore(true);
    setError(undefined);
    try {
      const page = await client.listWebhookDeliveries(
        endpointId,
        { limit: PAGE_SIZE, cursor: nextCursor },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setDeliveries((current) => mergeDeliveries(current, page.deliveries));
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (controller.signal.aborted) return;
      const apiError = caught instanceof ExecutorApiError ? caught : undefined;
      if (apiError?.status === 404) setStatus("stale");
      setError({
        code: apiError?.code ?? "executor_unavailable",
        message:
          apiError?.message ?? "More delivery history could not be loaded.",
      });
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  if (status === "loading" && deliveries.length === 0) {
    return (
      <section
        aria-label="Webhook deliveries loading"
        className="webhook-deliveries-loading"
      >
        {["one", "two", "three"].map((row) => (
          <div key={row}>
            <Skeleton height={24} label="Delivery status loading" width={98} />
            <Skeleton height={13} label="Delivery event loading" width="34%" />
            <Skeleton height={13} label="Delivery timing loading" width="22%" />
          </div>
        ))}
      </section>
    );
  }

  if (status === "stale") {
    return (
      <div className="webhook-delivery-state" role="alert">
        <Icon name="webhook" />
        <h3>Endpoint no longer available</h3>
        <p>
          This endpoint may have been deleted. Endpoint-scoped history cannot be
          reopened after deletion.
        </p>
        <Button onClick={onRefreshEndpoint} size="small" variant="secondary">
          Refresh endpoints
        </Button>
      </div>
    );
  }

  if (status === "error" && deliveries.length === 0) {
    return (
      <div className="webhook-delivery-state" role="alert">
        <Icon name="activity" />
        <h3>Delivery history unavailable</h3>
        <p>{error?.message}</p>
        <Button
          onClick={() => void loadFirstPage()}
          size="small"
          variant="secondary"
        >
          Retry
        </Button>
      </div>
    );
  }

  if (deliveries.length === 0) {
    return (
      <div className="webhook-delivery-state">
        <Icon name="webhook" />
        <h3>No deliveries for this endpoint</h3>
        <p>
          Delivery attempts will appear here after a subscribed event is
          emitted.
        </p>
        <footer>0 deliveries · End of history</footer>
      </div>
    );
  }

  return (
    <section className="webhook-deliveries">
      {error ? (
        <div className="inline-error" role="alert">
          <span className="taxonomy-badge taxonomy-badge--error">
            {error.code}
          </span>
          <p>{error.message}</p>
        </div>
      ) : null}
      <TableShell
        caption="Webhook deliveries and complete attempt history"
        columns={[
          { key: "status", label: "Status" },
          { key: "event", label: "Event" },
          { key: "identity", label: "Delivery" },
          { key: "created", label: "Created (UTC)" },
          { key: "next", label: "Completed / retry" },
          { key: "attempts", label: "Attempts" },
        ]}
      >
        {deliveries.map((delivery) => (
          <Fragment key={delivery.deliveryId}>
            <tr>
              <td>
                <Badge status={delivery.status} />
              </td>
              <td>
                <code className="webhook-delivery-event">
                  {delivery.eventType}
                </code>
              </td>
              <td>
                <span className="webhook-delivery-identity">
                  <code>{delivery.eventId}</code>
                  <small>{delivery.deliveryId}</small>
                </span>
              </td>
              <td className="mono">{utcLabel(delivery.createdAt)}</td>
              <td>
                {delivery.completedAt ? (
                  <span className="webhook-delivery-time webhook-delivery-time--completed">
                    Completed {utcLabel(delivery.completedAt)}
                  </span>
                ) : delivery.nextRetryAt ? (
                  <span className="webhook-delivery-time webhook-delivery-time--retry">
                    Retry {utcLabel(delivery.nextRetryAt)}
                  </span>
                ) : (
                  <span className="webhook-delivery-time">In progress</span>
                )}
              </td>
              <td className="mono">{delivery.attempts.length}</td>
            </tr>
            <tr className="webhook-attempt-row">
              <td colSpan={6}>
                <details>
                  <summary>
                    Complete attempt history ({delivery.attempts.length})
                  </summary>
                  {delivery.attempts.length === 0 ? (
                    <p>No attempts have started yet.</p>
                  ) : (
                    <div className="webhook-attempt-table-wrap">
                      <table className="webhook-attempt-table">
                        <thead>
                          <tr>
                            <th scope="col">Attempt</th>
                            <th scope="col">Started (UTC)</th>
                            <th scope="col">Completed (UTC)</th>
                            <th scope="col">Duration</th>
                            <th scope="col">Response</th>
                          </tr>
                        </thead>
                        <tbody>
                          {delivery.attempts.map((attempt) => (
                            <tr
                              key={`${delivery.deliveryId}-${attempt.attempt}`}
                            >
                              <td className="mono">
                                Attempt {attempt.attempt}
                              </td>
                              <td className="mono">
                                {utcLabel(attempt.attemptedAt)}
                              </td>
                              <td className="mono">
                                {utcLabel(attempt.completedAt)}
                              </td>
                              <td className="mono">
                                {webhookAttemptDuration(
                                  attempt.attemptedAt,
                                  attempt.completedAt,
                                )}
                              </td>
                              <td>
                                {attempt.statusCode === undefined ? (
                                  <span className="webhook-transport-error">
                                    {attempt.error ?? "No response received."}
                                  </span>
                                ) : (
                                  <code>HTTP {attempt.statusCode}</code>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </details>
              </td>
            </tr>
          </Fragment>
        ))}
      </TableShell>
      <footer className="webhook-pagination">
        <span>
          {deliveries.length}{" "}
          {deliveries.length === 1 ? "delivery" : "deliveries"} loaded
          {nextCursor === undefined ? " · End of history" : ""}
        </span>
        {nextCursor ? (
          <Button
            disabled={loadingMore}
            onClick={() => void loadMore()}
            size="small"
            variant="secondary"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </footer>
    </section>
  );
}
