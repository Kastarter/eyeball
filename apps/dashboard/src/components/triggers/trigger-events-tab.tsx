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
  type ListTriggerEventsParams,
  projectTriggerEventPage,
  type TriggerEvent,
  type TriggerEventPage,
} from "@/src/lib/api";

const PAGE_SIZE = 20;

type LoadState = "loading" | "ready" | "error";

interface EventError {
  code: string;
  message: string;
}

interface AppliedFilters {
  subscriptionId?: string;
  trigger?: string;
}

export type TriggerEventView = "loading" | "full-error" | "empty" | "table";

export function triggerEventView(
  state: LoadState,
  eventCount: number,
): TriggerEventView {
  if (state === "loading" && eventCount === 0) return "loading";
  if (state === "error" && eventCount === 0) return "full-error";
  if (state === "ready" && eventCount === 0) return "empty";
  return "table";
}

export function triggerEventUtcLabel(value: string): string {
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

export function mergeTriggerEvents(
  current: readonly TriggerEvent[],
  incoming: readonly TriggerEvent[],
): readonly TriggerEvent[] {
  const merged = [...current];
  const positions = new Map(
    merged.map((event, index) => [event.arrivalId, index] as const),
  );
  for (const event of incoming) {
    const existing = positions.get(event.arrivalId);
    if (existing === undefined) {
      positions.set(event.arrivalId, merged.length);
      merged.push(event);
    } else {
      merged[existing] = event;
    }
  }
  return merged.sort(
    (left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
  );
}

function normalizeFilters(
  subscriptionId: string,
  trigger: string,
): AppliedFilters {
  const normalizedSubscriptionId = subscriptionId.trim();
  const normalizedTrigger = trigger.trim();
  return {
    ...(normalizedSubscriptionId.length === 0
      ? {}
      : { subscriptionId: normalizedSubscriptionId }),
    ...(normalizedTrigger.length === 0 ? {} : { trigger: normalizedTrigger }),
  };
}

function eventError(caught: unknown, fallback: string): EventError {
  const apiError = caught instanceof ExecutorApiError ? caught : undefined;
  return {
    code: apiError?.code ?? "executor_unavailable",
    message: apiError?.message ?? fallback,
  };
}

function dedupLabel(status: TriggerEvent["dedupStatus"]): string {
  return status === "accepted" ? "Accepted" : "Duplicate";
}

export interface TriggerEventsTabProps {
  client: ExecutorClient;
  initialPage?: TriggerEventPage;
}

export function TriggerEventsTab({
  client,
  initialPage,
}: TriggerEventsTabProps) {
  const projectedInitialPage = useMemo(
    () =>
      initialPage === undefined
        ? undefined
        : projectTriggerEventPage(initialPage),
    [initialPage],
  );
  const [events, setEvents] = useState<readonly TriggerEvent[]>(
    mergeTriggerEvents([], projectedInitialPage?.triggerEvents ?? []),
  );
  const [nextCursor, setNextCursor] = useState<string | undefined>(
    projectedInitialPage?.nextCursor,
  );
  const [state, setState] = useState<LoadState>(
    projectedInitialPage === undefined ? "loading" : "ready",
  );
  const [error, setError] = useState<EventError>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [subscriptionDraft, setSubscriptionDraft] = useState("");
  const [triggerDraft, setTriggerDraft] = useState("");
  const [filters, setFilters] = useState<AppliedFilters>({});
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const initialPagePendingRef = useRef(projectedInitialPage !== undefined);

  const loadFirstPage = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setEvents([]);
    setNextCursor(undefined);
    setLoadingMore(false);
    setState("loading");
    setError(undefined);
    const params: ListTriggerEventsParams = {
      limit: PAGE_SIZE,
      ...filters,
    };
    try {
      const page = await client.listTriggerEvents(params, controller.signal);
      if (controller.signal.aborted) return;
      setEvents(mergeTriggerEvents([], page.triggerEvents));
      setNextCursor(page.nextCursor);
      setState("ready");
    } catch (caught) {
      if (controller.signal.aborted) return;
      setState("error");
      setError(
        eventError(
          caught,
          "Recent trigger events could not be loaded from the executor.",
        ),
      );
    }
  }, [client, filters]);

  useEffect(() => {
    if (initialPagePendingRef.current) {
      initialPagePendingRef.current = false;
      return;
    }
    void refreshVersion;
    void loadFirstPage();
    return () => requestRef.current?.abort();
  }, [loadFirstPage, refreshVersion]);

  useEffect(() => () => requestRef.current?.abort(), []);

  async function loadMore() {
    if (nextCursor === undefined || loadingMore) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoadingMore(true);
    setError(undefined);
    try {
      const page = await client.listTriggerEvents(
        { limit: PAGE_SIZE, cursor: nextCursor, ...filters },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setEvents((current) => mergeTriggerEvents(current, page.triggerEvents));
      setNextCursor(page.nextCursor);
      setState("ready");
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(
        eventError(caught, "More trigger-event history could not be loaded."),
      );
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  const view = triggerEventView(state, events.length);
  const hasFilters =
    filters.subscriptionId !== undefined || filters.trigger !== undefined;

  return (
    <section
      className="trigger-events-panel"
      aria-label="Recent trigger events"
    >
      <form
        className="trigger-event-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const nextFilters = normalizeFilters(subscriptionDraft, triggerDraft);
          if (
            nextFilters.subscriptionId === filters.subscriptionId &&
            nextFilters.trigger === filters.trigger
          ) {
            setRefreshVersion((version) => version + 1);
          } else {
            setFilters(nextFilters);
          }
        }}
      >
        <label>
          <span>Exact subscription ID</span>
          <input
            className="field__control mono"
            onChange={(event) =>
              setSubscriptionDraft(event.currentTarget.value)
            }
            placeholder="trgsub_…"
            value={subscriptionDraft}
          />
        </label>
        <label>
          <span>Exact canonical trigger</span>
          <input
            className="field__control mono"
            onChange={(event) => setTriggerDraft(event.currentTarget.value)}
            placeholder="slack.message_received"
            value={triggerDraft}
          />
        </label>
        <div className="trigger-event-filter-actions">
          <Button size="small" type="submit" variant="secondary">
            Apply
          </Button>
          <Button
            disabled={
              !hasFilters && subscriptionDraft === "" && triggerDraft === ""
            }
            onClick={() => {
              setSubscriptionDraft("");
              setTriggerDraft("");
              if (hasFilters) setFilters({});
              else setRefreshVersion((version) => version + 1);
            }}
            size="small"
            type="button"
            variant="ghost"
          >
            Clear
          </Button>
          <Button
            onClick={() => setRefreshVersion((version) => version + 1)}
            size="small"
            type="button"
            variant="ghost"
          >
            Refresh
          </Button>
        </div>
      </form>

      {view === "loading" ? (
        <section
          aria-label="Trigger events loading"
          className="trigger-events-loading"
        >
          {["one", "two", "three"].map((row) => (
            <div key={row}>
              <Skeleton height={24} label="Event status loading" width={108} />
              <Skeleton
                height={13}
                label="Event identity loading"
                width="35%"
              />
              <Skeleton height={13} label="Event time loading" width="22%" />
            </div>
          ))}
        </section>
      ) : null}

      {view === "full-error" ? (
        <div className="trigger-event-state" role="alert">
          <Icon name="activity" />
          <h3>Recent events unavailable</h3>
          <p>{error?.message}</p>
          <Button
            onClick={() => setRefreshVersion((version) => version + 1)}
            size="small"
            variant="secondary"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {view === "empty" ? (
        <div className="trigger-event-state">
          <Icon name="activity" />
          <h3>
            {hasFilters ? "No events match these filters" : "No recent events"}
          </h3>
          <p>
            {hasFilters
              ? "Change or clear the exact filters to inspect another history slice."
              : "Accepted and duplicate provider arrivals will appear here as redacted metadata."}
          </p>
          <footer>0 events · End of history</footer>
        </div>
      ) : null}

      {view === "table" ? (
        <section className="trigger-events">
          {error ? (
            <div className="inline-error" role="alert">
              <span className="taxonomy-badge taxonomy-badge--error">
                {error.code}
              </span>
              <p>{error.message}</p>
            </div>
          ) : null}
          <TableShell
            caption="Redacted project trigger-event history"
            columns={[
              { key: "delivery", label: "Delivery" },
              { key: "event", label: "Event" },
              { key: "subscription", label: "Subscription" },
              { key: "mode", label: "Mode" },
              { key: "dedup", label: "Dedup" },
              { key: "received", label: "Received (UTC)" },
              { key: "occurred", label: "Occurred (UTC)" },
              { key: "targets", label: "Targets" },
            ]}
          >
            {events.map((event) => (
              <Fragment key={event.arrivalId}>
                <tr>
                  <td>
                    <Badge status={event.deliveryStatus} />
                  </td>
                  <td>
                    <span className="trigger-event-id-stack">
                      <strong>{event.trigger}</strong>
                      <code>{event.arrivalId}</code>
                      <small>{event.eventId}</small>
                    </span>
                  </td>
                  <td className="mono">{event.subscriptionId}</td>
                  <td>
                    <code>{event.deliveryMode}</code>
                  </td>
                  <td>
                    <span
                      className={`trigger-event-dedup trigger-event-dedup--${event.dedupStatus}`}
                    >
                      {dedupLabel(event.dedupStatus)}
                    </span>
                  </td>
                  <td className="mono">
                    {triggerEventUtcLabel(event.receivedAt)}
                  </td>
                  <td className="mono">
                    {triggerEventUtcLabel(event.occurredAt)}
                  </td>
                  <td className="mono">
                    {event.requestedWebhookEndpointIds.length} requested ·{" "}
                    {event.deliveryTargets.length} actual
                  </td>
                </tr>
                <tr className="trigger-event-target-row">
                  <td colSpan={8}>
                    <details>
                      <summary>
                        Delivery metadata · expires{" "}
                        {triggerEventUtcLabel(event.expiresAt)}
                      </summary>
                      {event.deliveryTargets.length === 0 ? (
                        <p>
                          No delivery targets materialized for this arrival.
                        </p>
                      ) : (
                        <ul>
                          {event.deliveryTargets.map((target) => (
                            <li key={target.deliveryId}>
                              <span>
                                <code>{target.endpointId}</code>
                                <small>{target.deliveryId}</small>
                              </span>
                              <Badge status={target.status} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </details>
                  </td>
                </tr>
              </Fragment>
            ))}
          </TableShell>
          <footer className="webhook-pagination">
            <span>
              {events.length} {events.length === 1 ? "event" : "events"} loaded
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
      ) : null}
    </section>
  );
}
