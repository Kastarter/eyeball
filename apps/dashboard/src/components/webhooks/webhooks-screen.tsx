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
import {
  dashboardExecutorClient,
  ExecutorApiError,
  type WebhookEndpoint,
} from "@/src/lib/api";
import type { CatalogWebhookTriggerOption } from "@/src/lib/catalog";
import { cn } from "@/src/lib/cn";
import { isCloudMode } from "@/src/lib/runtime-config";
import {
  WebhookEndpointDrawer,
  type WebhookEndpointDrawerTab,
} from "./webhook-endpoint-drawer";
import { createWebhookState, webhookStateReducer } from "./webhook-state";

const PAGE_SIZE = 25;

const webhookCreateSnippet = `import { Eyeball } from "@eyeball/sdk";

const eyeball = new Eyeball({
  apiKey: process.env.EYEBALL_API_KEY!,
  baseUrl: process.env.EYEBALL_EXECUTOR_URL!,
});

const endpoint = await eyeball.webhooks.create({
  url: "https://agent.example.com/eyeball",
  events: ["execution.completed", "trigger.slack.message_received"],
});

// Store endpoint.secret now; it is returned only once.`;

export type WebhookExecutorState =
  | "loading"
  | "online"
  | "unconfigured"
  | "forbidden"
  | "offline"
  | "not_configured"
  | "error";

interface WebhookScreenError {
  code: string;
  message: string;
}

export function classifyWebhookExecutorFailure(caught: unknown): {
  error: WebhookScreenError;
  state: WebhookExecutorState;
} {
  const error = caught instanceof ExecutorApiError ? caught : undefined;
  const state: WebhookExecutorState =
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
        "Webhook endpoint data could not be refreshed from the executor.",
    },
  };
}

export function WebhookLoadBanner({
  cloud,
  error,
  onRetry,
  project,
  state,
}: {
  cloud: boolean;
  error?: WebhookScreenError | undefined;
  onRetry: () => void;
  project: string;
  state: Exclude<WebhookExecutorState, "loading" | "online">;
}) {
  const settingsHref = `/${encodeURIComponent(project)}/settings`;
  const presentation =
    state === "unconfigured"
      ? {
          title: "Executor credential required",
          description: cloud
            ? "Save the selected project's unpinned executor key in Settings, then retry. Webhook administration never moves to the cloud control plane."
            : "Set a server-only EYEBALL_API_KEY for the dashboard process, then retry. Never expose it through a NEXT_PUBLIC variable.",
          warning: true,
        }
      : state === "forbidden"
        ? {
            title: "Unpinned project key required",
            description:
              "Webhook administration is project-authority only. Save an unpinned key for the selected project in Settings.",
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
                title: "Webhook refresh failed",
                description:
                  error?.message ??
                  "The executor returned an unexpected response. Existing endpoint rows remain visible.",
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

export function parseWebhookDrawerQuery(url: URL): {
  newEndpointOpen: boolean;
  selectedEndpointId?: string;
  tab: WebhookEndpointDrawerTab;
} {
  const newEndpointOpen = url.searchParams.get("new") === "true";
  const endpoint = url.searchParams.get("endpoint")?.trim();
  const tab =
    url.searchParams.get("tab") === "deliveries" ? "deliveries" : "settings";
  return {
    newEndpointOpen,
    ...(newEndpointOpen || endpoint === undefined || endpoint.length === 0
      ? {}
      : { selectedEndpointId: endpoint }),
    tab,
  };
}

export function WebhookFilteredEmptyState({
  onClear,
}: {
  onClear: () => void;
}) {
  return (
    <div className="filtered-empty">
      <Icon name="webhook" />
      <h2>No webhook endpoints match these filters</h2>
      <p>Change the search or status filter to restore the endpoint list.</p>
      <Button onClick={onClear} variant="secondary">
        Clear filters
      </Button>
    </div>
  );
}

export interface WebhooksScreenProps {
  catalogTriggerOptions: readonly CatalogWebhookTriggerOption[];
  initialEndpoints?: readonly WebhookEndpoint[];
  initialNewEndpointOpen?: boolean;
  initialNextCursor?: string;
  initialSelectedEndpoint?: string;
  initialTab?: WebhookEndpointDrawerTab;
  project: string;
}

export function WebhooksScreen({
  catalogTriggerOptions,
  initialEndpoints,
  initialNewEndpointOpen = false,
  initialNextCursor,
  initialSelectedEndpoint,
  initialTab = "settings",
  project,
}: WebhooksScreenProps) {
  const client = useMemo(() => dashboardExecutorClient(project), [project]);
  const [state, dispatch] = useReducer(webhookStateReducer, undefined, () =>
    createWebhookState(initialEndpoints ?? [], initialNextCursor),
  );
  const [executorState, setExecutorState] = useState<WebhookExecutorState>(
    initialEndpoints === undefined ? "loading" : "online",
  );
  const [loadError, setLoadError] = useState<WebhookScreenError>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "inactive"
  >("all");
  const [newEndpointOpen, setNewEndpointOpen] = useState(
    initialNewEndpointOpen,
  );
  const [selectedEndpointId, setSelectedEndpointId] = useState(
    initialNewEndpointOpen ? undefined : initialSelectedEndpoint,
  );
  const [selectedTab, setSelectedTab] =
    useState<WebhookEndpointDrawerTab>(initialTab);
  const [loadingMore, setLoadingMore] = useState(false);
  const listRequestRef = useRef<AbortController | undefined>(undefined);
  const drawerTriggerRef = useRef<HTMLElement | null>(null);
  const cloud = isCloudMode();

  const loadEndpoints = useCallback(
    async (
      cursor: string | undefined,
      signal: AbortSignal,
      append: boolean,
    ) => {
      try {
        const page = await client.listWebhookEndpoints(
          { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
          signal,
        );
        if (signal.aborted) return;
        dispatch({
          type: "listLoaded",
          endpoints: page.webhooks,
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
          ...(append ? { append: true } : {}),
        });
        setExecutorState("online");
        setLoadError(undefined);
      } catch (caught) {
        if (signal.aborted) return;
        const classified = classifyWebhookExecutorFailure(caught);
        setExecutorState(classified.state);
        setLoadError(classified.error);
      }
    },
    [client],
  );

  const refreshEndpoints = useCallback(() => {
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    if (state.endpoints.length === 0) setExecutorState("loading");
    void loadEndpoints(undefined, controller.signal, false);
  }, [loadEndpoints, state.endpoints.length]);

  useEffect(() => {
    if (initialEndpoints !== undefined) return;
    const controller = new AbortController();
    listRequestRef.current = controller;
    void loadEndpoints(undefined, controller.signal, false);
    return () => controller.abort();
  }, [initialEndpoints, loadEndpoints]);

  useEffect(() => () => listRequestRef.current?.abort(), []);

  useEffect(() => {
    function restoreDrawerState() {
      const restored = parseWebhookDrawerQuery(new URL(window.location.href));
      setNewEndpointOpen(restored.newEndpointOpen);
      setSelectedEndpointId(restored.selectedEndpointId);
      setSelectedTab(restored.tab);
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

  const openNewEndpoint = useCallback(() => {
    rememberDrawerTrigger();
    setNewEndpointOpen(true);
    setSelectedEndpointId(undefined);
    setSelectedTab("settings");
    const url = new URL(window.location.href);
    url.searchParams.set("new", "true");
    url.searchParams.delete("endpoint");
    url.searchParams.delete("tab");
    window.history.pushState({}, "", url);
  }, [rememberDrawerTrigger]);

  const openEndpoint = useCallback(
    (endpointId: string, tab: WebhookEndpointDrawerTab) => {
      rememberDrawerTrigger();
      setNewEndpointOpen(false);
      setSelectedEndpointId(endpointId);
      setSelectedTab(tab);
      const url = new URL(window.location.href);
      url.searchParams.delete("new");
      url.searchParams.set("endpoint", endpointId);
      url.searchParams.set("tab", tab);
      window.history.pushState({}, "", url);
    },
    [rememberDrawerTrigger],
  );

  const closeDrawerState = useCallback((restoreFocus: boolean) => {
    setNewEndpointOpen(false);
    setSelectedEndpointId(undefined);
    setSelectedTab("settings");
    const url = new URL(window.location.href);
    url.searchParams.delete("new");
    url.searchParams.delete("endpoint");
    url.searchParams.delete("tab");
    window.history.replaceState({}, "", url);
    if (restoreFocus) {
      window.requestAnimationFrame(() => drawerTriggerRef.current?.focus());
    }
  }, []);

  const closeDrawer = useCallback(
    () => closeDrawerState(true),
    [closeDrawerState],
  );

  const changeTab = useCallback((tab: WebhookEndpointDrawerTab) => {
    setSelectedTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url);
  }, []);

  const handleEndpointUpdated = useCallback((endpoint: WebhookEndpoint) => {
    dispatch({ type: "endpointUpdated", endpoint });
  }, []);

  const handleEndpointDeleted = useCallback(
    (endpointId: string) => {
      dispatch({ type: "endpointDeleted", endpointId });
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
    await loadEndpoints(state.nextCursor, controller.signal, true);
    if (!controller.signal.aborted) setLoadingMore(false);
  }

  const visibleEndpoints = state.endpoints.filter((endpoint) => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matchesQuery =
      normalizedQuery.length === 0 ||
      [endpoint.url, endpoint.endpointId, ...endpoint.events]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" ? endpoint.active : !endpoint.active);
    return matchesQuery && matchesStatus;
  });
  const selectedEndpoint = state.endpoints.find(
    (endpoint) => endpoint.endpointId === selectedEndpointId,
  );
  const activeCount = state.endpoints.filter(
    (endpoint) => endpoint.active,
  ).length;
  const eventCount = new Set(
    state.endpoints.flatMap((endpoint) => endpoint.events),
  ).size;

  return (
    <div className="page-stack webhooks-page">
      <PageHeader
        actions={
          <Button
            icon={<Icon name="plus" />}
            onClick={openNewEndpoint}
            variant="primary"
          >
            New endpoint
          </Button>
        }
        description="Manage signed outgoing event destinations and inspect metadata-only delivery attempts. Signing secrets are never recoverable after reveal."
        eyebrow="Event delivery"
        title="Webhooks"
      />

      <section className="webhook-summary" aria-label="Webhook summary">
        <div>
          <strong className="mono">{state.endpoints.length}</strong>
          <span>loaded endpoints</span>
        </div>
        <div>
          <strong className="mono">{activeCount}</strong>
          <span>active</span>
        </div>
        <div>
          <strong className="mono">{eventCount}</strong>
          <span>event selectors</span>
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
              ? "Loading endpoints"
              : "Executor attention required"}
        </div>
      </section>

      {executorState !== "loading" && executorState !== "online" ? (
        <WebhookLoadBanner
          cloud={cloud}
          error={loadError}
          onRetry={refreshEndpoints}
          project={project}
          state={executorState}
        />
      ) : null}

      {executorState === "loading" && state.endpoints.length === 0 ? (
        <section
          className="webhooks-loading"
          aria-label="Webhook endpoints loading"
        >
          <div className="webhooks-loading__filters">
            <Skeleton
              height={38}
              label="Webhook search loading"
              width="min(100%, 420px)"
            />
            <Skeleton
              height={38}
              label="Webhook status filter loading"
              width={130}
            />
          </div>
          {["one", "two", "three", "four"].map((row) => (
            <div className="webhooks-loading__row" key={row}>
              <Skeleton
                height={14}
                label="Webhook endpoint loading"
                width="34%"
              />
              <Skeleton height={24} label="Webhook status loading" width={90} />
              <Skeleton height={14} label="Webhook time loading" width="18%" />
            </div>
          ))}
        </section>
      ) : state.endpoints.length === 0 && executorState === "online" ? (
        <EmptyState
          actions={
            <Button
              icon={<Icon name="plus" />}
              onClick={openNewEndpoint}
              variant="primary"
            >
              Create endpoint
            </Button>
          }
          code={webhookCreateSnippet}
          description="Create one HTTPS destination and choose the event selectors it receives. The create-time signing secret is shown once."
          title="No webhook endpoints"
        />
      ) : state.endpoints.length > 0 ? (
        <section className="webhooks-table-section">
          <div className="table-filters webhook-filters">
            <label className="table-filters__search">
              <span>Search</span>
              <span className="table-search-control">
                <Icon name="search" />
                <input
                  className="field__control"
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="destination, endpoint ID, event"
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
                    event.currentTarget.value as "all" | "active" | "inactive",
                  )
                }
                value={statusFilter}
              >
                <option value="all">All endpoints</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
          </div>
          {visibleEndpoints.length > 0 ? (
            <TableShell
              caption="Project webhook endpoints"
              columns={[
                { key: "destination", label: "Destination" },
                { key: "events", label: "Events" },
                { key: "status", label: "Status" },
                { key: "prefix", label: "Signing prefix" },
                { key: "updated", label: "Updated (UTC)" },
                { key: "actions", label: "Actions" },
              ]}
            >
              {visibleEndpoints.map((endpoint) => (
                <tr key={endpoint.endpointId}>
                  <td>
                    <span className="webhook-endpoint-identity">
                      <span>
                        <strong>{endpoint.url}</strong>
                        <CopyButton
                          label="Copy webhook URL"
                          value={endpoint.url}
                        />
                      </span>
                      <span>
                        <code>{endpoint.endpointId}</code>
                        <CopyButton
                          label="Copy endpoint ID"
                          value={endpoint.endpointId}
                        />
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className="webhook-event-chips">
                      {endpoint.events.slice(0, 3).map((event) => (
                        <code key={event}>{event}</code>
                      ))}
                      {endpoint.events.length > 3 ? (
                        <small>+{endpoint.events.length - 3} more</small>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <Badge status={endpoint.active ? "active" : "inactive"} />
                  </td>
                  <td className="webhook-prefix-cell">
                    <code>{endpoint.secretPrefix}</code>
                  </td>
                  <td className="mono">{utcLabel(endpoint.updatedAt)}</td>
                  <td>
                    <span className="row-actions webhook-row-actions">
                      <Button
                        onClick={() =>
                          openEndpoint(endpoint.endpointId, "settings")
                        }
                        size="small"
                        variant="ghost"
                      >
                        Manage
                      </Button>
                      <Button
                        onClick={() =>
                          openEndpoint(endpoint.endpointId, "deliveries")
                        }
                        size="small"
                        variant="secondary"
                      >
                        Deliveries
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </TableShell>
          ) : (
            <WebhookFilteredEmptyState
              onClear={() => {
                setQuery("");
                setStatusFilter("all");
              }}
            />
          )}
          <footer className="webhook-pagination">
            <span>
              {state.endpoints.length}{" "}
              {state.endpoints.length === 1 ? "endpoint" : "endpoints"} loaded
              {state.nextCursor === undefined ? " · End of list" : ""}
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

      {newEndpointOpen ? (
        <WebhookEndpointDrawer
          catalogTriggerOptions={catalogTriggerOptions}
          client={client}
          mode="create"
          onClose={closeDrawer}
          onCreated={(created) => {
            dispatch({ type: "endpointCreated", endpoint: created });
            closeDrawerState(false);
            setExecutorState("online");
          }}
          onDeleted={() => undefined}
          onRefreshEndpoints={refreshEndpoints}
          onRotated={() => undefined}
          onTabChange={changeTab}
          onUpdated={() => undefined}
          tab="settings"
        />
      ) : null}
      {!newEndpointOpen && selectedEndpointId ? (
        <WebhookEndpointDrawer
          catalogTriggerOptions={catalogTriggerOptions}
          client={client}
          {...(selectedEndpoint === undefined
            ? {}
            : { endpoint: selectedEndpoint })}
          endpointId={selectedEndpointId}
          key={selectedEndpointId}
          mode="edit"
          onClose={closeDrawer}
          onCreated={() => undefined}
          onDeleted={handleEndpointDeleted}
          onRefreshEndpoints={refreshEndpoints}
          onRotated={(rotation) =>
            dispatch({ type: "secretRotated", rotation })
          }
          onTabChange={changeTab}
          onUpdated={handleEndpointUpdated}
          suspended={state.revealedSecret !== undefined}
          tab={selectedTab}
        />
      ) : null}
      {state.revealedSecret ? (
        <SecretRevealDialog
          acknowledgementLabel="I stored the signing secret"
          copyLabel="Copy signing secret"
          description={
            state.revealedSecret.context === "created"
              ? "This is the only time the endpoint's full signing secret will be displayed. Store it before continuing."
              : "This is the only time the replacement signing secret will be displayed. The old secret is already invalid."
          }
          onClose={() => dispatch({ type: "revealClosed" })}
          secret={state.revealedSecret.value}
          title={
            state.revealedSecret.context === "created"
              ? "Store this signing secret now"
              : "Store the replacement signing secret now"
          }
          warning="Eyeball cannot recover this signing secret after you acknowledge this dialog."
        />
      ) : null}
    </div>
  );
}
