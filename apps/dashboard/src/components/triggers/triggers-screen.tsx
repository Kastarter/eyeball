"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { PageHeader } from "@/src/components/pages/page-header";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { CopyButton } from "@/src/components/ui/copy-button";
import { EmptyState } from "@/src/components/ui/empty-state";
import { Icon } from "@/src/components/ui/icon";
import { SecretRevealDialog } from "@/src/components/ui/secret-reveal-dialog";
import { Skeleton } from "@/src/components/ui/skeleton";
import { TableShell } from "@/src/components/ui/table";
import { Tabs } from "@/src/components/ui/tabs";
import {
  dashboardExecutorClient,
  ExecutorApiError,
  type TriggerSubscription,
} from "@/src/lib/api";
import type { CatalogTriggerSubscriptionOption } from "@/src/lib/catalog";
import { cn } from "@/src/lib/cn";
import { isCloudMode } from "@/src/lib/runtime-config";
import { TriggerEventsTab } from "./trigger-events-tab";
import { createTriggerState, triggerStateReducer } from "./trigger-state";
import { TriggerSubscriptionDrawer } from "./trigger-subscription-drawer";

const PAGE_SIZE = 25;

const triggerCreateSnippet = `import { Eyeball } from "@eyeball/sdk";

const eyeball = new Eyeball({
  apiKey: process.env.EYEBALL_API_KEY!,
  baseUrl: process.env.EYEBALL_EXECUTOR_URL!,
});

const subscription = await eyeball.subscriptions.create({
  trigger: "gmail.email_received",
  userId: "demo_user",
  webhookEndpointIds: ["whep_agent_inbox"],
  pollIntervalSeconds: 120,
});

// Push triggers also return subscription.ingestUrl exactly once.`;

export type TriggerExecutorState =
  | "loading"
  | "online"
  | "unconfigured"
  | "forbidden"
  | "offline"
  | "not_configured"
  | "error";

interface TriggerScreenError {
  code: string;
  message: string;
}

export function classifyTriggerExecutorFailure(caught: unknown): {
  error: TriggerScreenError;
  state: TriggerExecutorState;
} {
  const error = caught instanceof ExecutorApiError ? caught : undefined;
  const state: TriggerExecutorState =
    error?.status === 401
      ? "unconfigured"
      : error?.status === 403 && error.code === "auth_insufficient_scope"
        ? "forbidden"
        : error?.status === 502
          ? "offline"
          : error?.status === 503 && error.code === "executor_not_configured"
            ? "not_configured"
            : "error";
  return {
    state,
    error: {
      code: error?.code ?? "executor_unavailable",
      message:
        error?.message ??
        "Trigger subscription data could not be refreshed from the executor.",
    },
  };
}

export function TriggerLoadBanner({
  cloud,
  error,
  onRetry,
  project,
  state,
}: {
  cloud: boolean;
  error?: TriggerScreenError | undefined;
  onRetry: () => void;
  project: string;
  state: Exclude<TriggerExecutorState, "loading" | "online">;
}) {
  const settingsHref = `/${encodeURIComponent(project)}/settings`;
  const presentation =
    state === "unconfigured"
      ? {
          title: "Executor credential required",
          description: cloud
            ? "Save the selected project's executor key in Settings, then retry. Trigger administration never moves to the cloud control plane."
            : "Set a server-only EYEBALL_API_KEY for the dashboard process, then retry. Never expose it through a NEXT_PUBLIC variable.",
          warning: true,
        }
      : state === "forbidden"
        ? {
            title: "Project key user pin conflict",
            description:
              "The saved executor key pins a different user than this subscription list requires. Save a compatible key in Settings.",
            warning: true,
          }
        : state === "offline"
          ? {
              title: "Executor offline",
              description:
                "The dashboard could not reach the configured executor. Check the process and executor URL, then retry.",
              warning: false,
            }
          : state === "not_configured"
            ? {
                title: "Executor URL not configured",
                description:
                  "Configure the dashboard's server-side EYEBALL_EXECUTOR_URL with HTTPS or an explicit loopback URL, then retry.",
                warning: true,
              }
            : {
                title: "Trigger refresh failed",
                description:
                  error?.message ??
                  "The executor returned an unexpected response. Existing subscription rows remain visible.",
                warning: false,
              };

  return (
    <div
      className={cn(
        "offline-banner",
        presentation.warning && "offline-banner--warning",
      )}
      role="status"
    >
      <Icon name="activity" />
      <div>
        <strong>{presentation.title}</strong>
        <p>{presentation.description}</p>
        {error && state === "error" ? (
          <small className="mono">{error.code}</small>
        ) : null}
      </div>
      {cloud && (state === "unconfigured" || state === "forbidden") ? (
        <Link
          className="button button--secondary button--small"
          href={settingsHref}
        >
          Open Settings
        </Link>
      ) : null}
      <Button onClick={onRetry} size="small" variant="secondary">
        Retry
      </Button>
    </div>
  );
}

function utcLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

export function parseTriggerDrawerQuery(url: URL): {
  newSubscriptionOpen: boolean;
  selectedSubscriptionId?: string;
} {
  const page = parseTriggerPageQuery(url);
  return {
    newSubscriptionOpen: page.newSubscriptionOpen,
    ...(page.selectedSubscriptionId === undefined
      ? {}
      : { selectedSubscriptionId: page.selectedSubscriptionId }),
  };
}

export type TriggerView = "subscriptions" | "events";

export function parseTriggerPageQuery(url: URL): {
  view: TriggerView;
  newSubscriptionOpen: boolean;
  selectedSubscriptionId?: string;
} {
  const newSubscriptionOpen = url.searchParams.get("new") === "true";
  const subscription = url.searchParams.get("subscription")?.trim();
  const hasSelectedSubscription =
    !newSubscriptionOpen &&
    subscription !== undefined &&
    subscription.length > 0;
  const view: TriggerView =
    !newSubscriptionOpen &&
    !hasSelectedSubscription &&
    url.searchParams.get("view") === "events"
      ? "events"
      : "subscriptions";
  return {
    view,
    newSubscriptionOpen,
    ...(newSubscriptionOpen ||
    subscription === undefined ||
    subscription.length === 0
      ? {}
      : { selectedSubscriptionId: subscription }),
  };
}

export function TriggerFilteredEmptyState({
  onClear,
}: {
  onClear: () => void;
}) {
  return (
    <div className="filtered-empty">
      <Icon name="connections" />
      <h2>No trigger subscriptions match these filters</h2>
      <p>
        Change the search or status filter to restore the subscription list.
      </p>
      <Button onClick={onClear} variant="secondary">
        Clear filters
      </Button>
    </div>
  );
}

export interface TriggersScreenProps {
  catalogTriggerOptions: readonly CatalogTriggerSubscriptionOption[];
  initialNewSubscriptionOpen?: boolean;
  initialNextCursor?: string;
  initialSelectedSubscription?: string;
  initialSubscriptions?: readonly TriggerSubscription[];
  initialView?: TriggerView;
  project: string;
}

export function TriggersScreen({
  catalogTriggerOptions,
  initialNewSubscriptionOpen = false,
  initialNextCursor,
  initialSelectedSubscription,
  initialSubscriptions,
  initialView = "subscriptions",
  project,
}: TriggersScreenProps) {
  const client = useMemo(() => dashboardExecutorClient(project), [project]);
  const [state, dispatch] = useReducer(triggerStateReducer, undefined, () =>
    createTriggerState(initialSubscriptions ?? [], initialNextCursor),
  );
  const [executorState, setExecutorState] = useState<TriggerExecutorState>(
    initialSubscriptions === undefined ? "loading" : "online",
  );
  const [loadError, setLoadError] = useState<TriggerScreenError>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused">(
    "all",
  );
  const [newSubscriptionOpen, setNewSubscriptionOpen] = useState(
    initialNewSubscriptionOpen,
  );
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState(
    initialNewSubscriptionOpen ? undefined : initialSelectedSubscription,
  );
  const [view, setView] = useState<TriggerView>(
    initialNewSubscriptionOpen || initialSelectedSubscription !== undefined
      ? "subscriptions"
      : initialView,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const listRequestRef = useRef<AbortController | undefined>(undefined);
  const drawerTriggerRef = useRef<HTMLElement | null>(null);
  const cloud = isCloudMode();

  const modeFor = useCallback(
    (trigger: string) =>
      catalogTriggerOptions.find((option) => option.trigger === trigger)?.mode,
    [catalogTriggerOptions],
  );

  const loadSubscriptions = useCallback(
    async (
      cursor: string | undefined,
      signal: AbortSignal,
      append: boolean,
    ) => {
      try {
        const page = await client.listTriggerSubscriptions(
          { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
          signal,
        );
        if (signal.aborted) return;
        dispatch({
          type: "listLoaded",
          subscriptions: page.subscriptions,
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
          ...(append ? { append: true } : {}),
        });
        setExecutorState("online");
        setLoadError(undefined);
      } catch (caught) {
        if (signal.aborted) return;
        const classified = classifyTriggerExecutorFailure(caught);
        setExecutorState(classified.state);
        setLoadError(classified.error);
      }
    },
    [client],
  );

  const refreshSubscriptions = useCallback(() => {
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    if (state.subscriptions.length === 0) setExecutorState("loading");
    void loadSubscriptions(undefined, controller.signal, false);
  }, [loadSubscriptions, state.subscriptions.length]);

  useEffect(() => {
    if (initialSubscriptions !== undefined) return;
    const controller = new AbortController();
    listRequestRef.current = controller;
    void loadSubscriptions(undefined, controller.signal, false);
    return () => controller.abort();
  }, [initialSubscriptions, loadSubscriptions]);

  useEffect(() => () => listRequestRef.current?.abort(), []);

  useEffect(() => {
    function restoreDrawerState() {
      const restored = parseTriggerPageQuery(new URL(window.location.href));
      setView(restored.view);
      setNewSubscriptionOpen(restored.newSubscriptionOpen);
      setSelectedSubscriptionId(restored.selectedSubscriptionId);
    }
    window.addEventListener("popstate", restoreDrawerState);
    return () => window.removeEventListener("popstate", restoreDrawerState);
  }, []);

  const rememberDrawerTrigger = useCallback(() => {
    drawerTriggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, []);

  const openNewSubscription = useCallback(() => {
    rememberDrawerTrigger();
    setView("subscriptions");
    setNewSubscriptionOpen(true);
    setSelectedSubscriptionId(undefined);
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    url.searchParams.set("new", "true");
    url.searchParams.delete("subscription");
    window.history.pushState({}, "", url);
  }, [rememberDrawerTrigger]);

  const openSubscription = useCallback(
    (subscriptionId: string) => {
      rememberDrawerTrigger();
      setView("subscriptions");
      setNewSubscriptionOpen(false);
      setSelectedSubscriptionId(subscriptionId);
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      url.searchParams.delete("new");
      url.searchParams.set("subscription", subscriptionId);
      window.history.pushState({}, "", url);
    },
    [rememberDrawerTrigger],
  );

  const closeDrawerState = useCallback((restoreFocus: boolean) => {
    setNewSubscriptionOpen(false);
    setSelectedSubscriptionId(undefined);
    const url = new URL(window.location.href);
    url.searchParams.delete("new");
    url.searchParams.delete("subscription");
    window.history.replaceState({}, "", url);
    if (restoreFocus) {
      window.requestAnimationFrame(() => drawerTriggerRef.current?.focus());
    }
  }, []);

  const closeDrawer = useCallback(
    () => closeDrawerState(true),
    [closeDrawerState],
  );

  const changeView = useCallback((nextValue: string) => {
    const nextView: TriggerView =
      nextValue === "events" ? "events" : "subscriptions";
    setView(nextView);
    const url = new URL(window.location.href);
    if (nextView === "events") {
      setNewSubscriptionOpen(false);
      setSelectedSubscriptionId(undefined);
      url.searchParams.set("view", "events");
      url.searchParams.delete("new");
      url.searchParams.delete("subscription");
    } else {
      url.searchParams.delete("view");
    }
    window.history.pushState({}, "", url);
  }, []);

  const handleSubscriptionDeleted = useCallback(
    (subscriptionId: string) => {
      dispatch({ type: "subscriptionDeleted", subscriptionId });
      closeDrawer();
    },
    [closeDrawer],
  );

  async function loadMore() {
    if (state.nextCursor === undefined || loadingMore) return;
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    setLoadingMore(true);
    await loadSubscriptions(state.nextCursor, controller.signal, true);
    if (!controller.signal.aborted) setLoadingMore(false);
  }

  const visibleSubscriptions = state.subscriptions.filter((subscription) => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matchesQuery =
      normalizedQuery.length === 0 ||
      [
        subscription.subscriptionId,
        subscription.trigger,
        subscription.userId,
        ...subscription.webhookEndpointIds,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    const matchesStatus =
      statusFilter === "all" || subscription.status === statusFilter;
    return matchesQuery && matchesStatus;
  });
  const selectedSubscription = state.subscriptions.find(
    (subscription) => subscription.subscriptionId === selectedSubscriptionId,
  );
  const activeCount = state.subscriptions.filter(
    (subscription) => subscription.status === "active",
  ).length;
  const pushCount = state.subscriptions.filter(
    (subscription) => modeFor(subscription.trigger) === "push",
  ).length;

  return (
    <div className="page-stack webhooks-page triggers-page">
      <PageHeader
        actions={
          <Button
            icon={<Icon name="plus" />}
            onClick={openNewSubscription}
            variant="primary"
          >
            New subscription
          </Button>
        }
        description="Subscribe user connections to canonical provider triggers. Events arrive through signed webhook endpoints; push ingest URLs are never recoverable after reveal."
        eyebrow="Event sources"
        title="Triggers"
      />

      <section className="webhook-summary" aria-label="Trigger summary">
        <div>
          <strong className="mono">{state.subscriptions.length}</strong>
          <span>loaded subscriptions</span>
        </div>
        <div>
          <strong className="mono">{activeCount}</strong>
          <span>active</span>
        </div>
        <div>
          <strong className="mono">{pushCount}</strong>
          <span>push mode</span>
        </div>
        <div className="webhook-summary__executor">
          <span
            className={cn(
              "status-dot",
              executorState === "online"
                ? "status-dot--success"
                : executorState === "loading"
                  ? "status-dot--accent status-dot--pulse"
                  : executorState === "unconfigured" ||
                      executorState === "forbidden" ||
                      executorState === "not_configured"
                    ? "status-dot--warning"
                    : "status-dot--error",
            )}
          />
          {executorState === "online"
            ? "Executor connected"
            : executorState === "loading"
              ? "Loading subscriptions"
              : "Executor attention required"}
        </div>
      </section>

      <div className="trigger-page-tabs">
        <Tabs
          ariaLabel="Trigger views"
          onValueChange={changeView}
          tabs={[
            {
              id: "subscriptions",
              label: "Subscriptions",
              content: (
                <>
                  {executorState !== "loading" && executorState !== "online" ? (
                    <TriggerLoadBanner
                      cloud={cloud}
                      error={loadError}
                      onRetry={refreshSubscriptions}
                      project={project}
                      state={executorState}
                    />
                  ) : null}

                  {executorState === "loading" &&
                  state.subscriptions.length === 0 ? (
                    <section
                      className="webhooks-loading"
                      aria-label="Trigger subscriptions loading"
                    >
                      <div className="webhooks-loading__filters">
                        <Skeleton
                          height={38}
                          label="Trigger search loading"
                          width="min(100%, 420px)"
                        />
                        <Skeleton
                          height={38}
                          label="Trigger status filter loading"
                          width={130}
                        />
                      </div>
                      {["one", "two", "three", "four"].map((row) => (
                        <div className="webhooks-loading__row" key={row}>
                          <Skeleton
                            height={14}
                            label="Trigger subscription loading"
                            width="34%"
                          />
                          <Skeleton
                            height={24}
                            label="Trigger status loading"
                            width={90}
                          />
                          <Skeleton
                            height={14}
                            label="Trigger time loading"
                            width="18%"
                          />
                        </div>
                      ))}
                    </section>
                  ) : state.subscriptions.length === 0 &&
                    executorState === "online" ? (
                    <EmptyState
                      actions={
                        <Button
                          icon={<Icon name="plus" />}
                          onClick={openNewSubscription}
                          variant="primary"
                        >
                          Create subscription
                        </Button>
                      }
                      code={triggerCreateSnippet}
                      description="Subscribe a user's connection to a provider trigger and route its events to signed webhook endpoints. Push ingest URLs are shown once."
                      title="No trigger subscriptions"
                    />
                  ) : state.subscriptions.length > 0 ? (
                    <section className="webhooks-table-section">
                      <div className="table-filters webhook-filters">
                        <label className="table-filters__search">
                          <span>Search</span>
                          <span className="table-search-control">
                            <Icon name="search" />
                            <input
                              className="field__control"
                              onChange={(event) =>
                                setQuery(event.currentTarget.value)
                              }
                              placeholder="subscription ID, trigger, user, endpoint"
                              type="search"
                              value={query}
                            />
                          </span>
                        </label>
                        <label>
                          <span>Status</span>
                          <select
                            className="field__control"
                            onChange={(event) =>
                              setStatusFilter(
                                event.currentTarget.value as
                                  | "all"
                                  | "active"
                                  | "paused",
                              )
                            }
                            value={statusFilter}
                          >
                            <option value="all">All subscriptions</option>
                            <option value="active">Active</option>
                            <option value="paused">Paused</option>
                          </select>
                        </label>
                      </div>
                      {visibleSubscriptions.length > 0 ? (
                        <TableShell
                          caption="Project trigger subscriptions"
                          columns={[
                            { key: "subscription", label: "Subscription" },
                            { key: "mode", label: "Mode" },
                            { key: "user", label: "User" },
                            { key: "endpoints", label: "Endpoints" },
                            { key: "status", label: "Status" },
                            { key: "updated", label: "Updated (UTC)" },
                            { key: "actions", label: "Actions" },
                          ]}
                        >
                          {visibleSubscriptions.map((subscription) => {
                            const mode = modeFor(subscription.trigger);
                            return (
                              <tr key={subscription.subscriptionId}>
                                <td>
                                  <span className="webhook-endpoint-identity">
                                    <span>
                                      <strong>{subscription.trigger}</strong>
                                    </span>
                                    <span>
                                      <code>{subscription.subscriptionId}</code>
                                      <CopyButton
                                        label="Copy subscription ID"
                                        value={subscription.subscriptionId}
                                      />
                                    </span>
                                  </span>
                                </td>
                                <td>
                                  <code>
                                    {mode === undefined
                                      ? "unknown"
                                      : mode === "push"
                                        ? "push"
                                        : `poll${
                                            subscription.pollIntervalSeconds ===
                                            undefined
                                              ? ""
                                              : ` · ${subscription.pollIntervalSeconds}s`
                                          }`}
                                  </code>
                                </td>
                                <td className="mono">{subscription.userId}</td>
                                <td className="mono">
                                  {subscription.webhookEndpointIds.length}
                                </td>
                                <td>
                                  <Badge
                                    status={
                                      subscription.status === "active"
                                        ? "active"
                                        : "inactive"
                                    }
                                  />
                                </td>
                                <td className="mono">
                                  {utcLabel(subscription.updatedAt)}
                                </td>
                                <td>
                                  <span className="row-actions webhook-row-actions">
                                    <Button
                                      onClick={() =>
                                        openSubscription(
                                          subscription.subscriptionId,
                                        )
                                      }
                                      size="small"
                                      variant="ghost"
                                    >
                                      Manage
                                    </Button>
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </TableShell>
                      ) : (
                        <TriggerFilteredEmptyState
                          onClear={() => {
                            setQuery("");
                            setStatusFilter("all");
                          }}
                        />
                      )}
                      <footer className="webhook-pagination">
                        <span>
                          {state.subscriptions.length}{" "}
                          {state.subscriptions.length === 1
                            ? "subscription"
                            : "subscriptions"}{" "}
                          loaded
                          {state.nextCursor === undefined
                            ? " · End of list"
                            : ""}
                        </span>
                        {state.nextCursor ? (
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
                </>
              ),
            },
            {
              id: "events",
              label: "Recent events",
              content: <TriggerEventsTab client={client} />,
            },
          ]}
          value={view}
        />
      </div>

      {newSubscriptionOpen ? (
        <TriggerSubscriptionDrawer
          catalogTriggerOptions={catalogTriggerOptions}
          client={client}
          mode="create"
          onClose={closeDrawer}
          onCreated={(created) => {
            dispatch({ type: "subscriptionCreated", subscription: created });
            closeDrawerState(false);
            setExecutorState("online");
          }}
          onDeleted={() => undefined}
          onRefreshSubscriptions={refreshSubscriptions}
          onRotated={() => undefined}
        />
      ) : null}
      {!newSubscriptionOpen && selectedSubscriptionId ? (
        <TriggerSubscriptionDrawer
          catalogTriggerOptions={catalogTriggerOptions}
          client={client}
          key={selectedSubscriptionId}
          mode="manage"
          onClose={closeDrawer}
          onCreated={() => undefined}
          onDeleted={handleSubscriptionDeleted}
          onRefreshSubscriptions={refreshSubscriptions}
          onRotated={(rotation) =>
            dispatch({ type: "ingestSecretRotated", rotation })
          }
          {...(selectedSubscription === undefined
            ? {}
            : { subscription: selectedSubscription })}
          subscriptionId={selectedSubscriptionId}
          suspended={state.revealedIngestUrl !== undefined}
        />
      ) : null}
      {state.revealedIngestUrl ? (
        <SecretRevealDialog
          acknowledgementLabel="I stored the ingest URL"
          copyLabel="Copy ingest URL"
          description={
            state.revealedIngestUrl.context === "created"
              ? "This is the only time the push ingest URL will be displayed. Configure the provider with it before continuing."
              : "This is the only time the replacement ingest URL will be displayed. The old URL is already invalid."
          }
          onClose={() => dispatch({ type: "revealClosed" })}
          secret={state.revealedIngestUrl.value}
          title={
            state.revealedIngestUrl.context === "created"
              ? "Store this push ingest URL now"
              : "Store the replacement ingest URL now"
          }
          warning="Eyeball cannot recover this ingest URL after you acknowledge this dialog. Rotate the subscription to mint a replacement."
        />
      ) : null}
    </div>
  );
}
