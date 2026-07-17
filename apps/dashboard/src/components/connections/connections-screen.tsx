"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PageHeader } from "@/src/components/pages/page-header";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { CopyButton } from "@/src/components/ui/copy-button";
import { EmptyState } from "@/src/components/ui/empty-state";
import { Input, Select } from "@/src/components/ui/form-controls";
import { Icon } from "@/src/components/ui/icon";
import { Panel } from "@/src/components/ui/panel";
import { Skeleton } from "@/src/components/ui/skeleton";
import { TableShell } from "@/src/components/ui/table";
import {
  type ConnectionRecord,
  type ConnectionStatus,
  dashboardExecutorClient,
  ExecutorApiError,
} from "@/src/lib/api";
import type { CatalogToolkitSummary } from "@/src/lib/catalog";
import { cn } from "@/src/lib/cn";

const connectionSnippet = `import { Eyeball } from "@eyeball/sdk";

const eb = new Eyeball({
  apiKey: process.env.EYEBALL_API_KEY!,
  baseUrl: process.env.EYEBALL_EXECUTOR_URL!,
});

const connection = await eb.connections.create({
  userId: "user_123", // maps to external_user_id
  toolkit: "gmail",
});`;

interface ConnectionRow extends ConnectionRecord {
  optimistic?: boolean;
}

type ExecutorState = "loading" | "offline" | "online" | "unconfigured";

export interface ConnectionsScreenProps {
  initialConnections?: readonly ConnectionRecord[];
  initialNewConnectionOpen?: boolean;
  project: string;
  toolkits: readonly CatalogToolkitSummary[];
}

function initials(displayName: string): string {
  return displayName
    .split(/[\s-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}

function createdLabel(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.valueOf())) return createdAt;
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

function NewConnectionPanel({
  onClose,
  onCreated,
  onDiscard,
  onUnavailable,
  toolkits,
}: {
  onClose: () => void;
  onCreated: (connection: ConnectionRow) => void;
  onDiscard: (connectionId: string) => void;
  onUnavailable: (state: "offline" | "unconfigured") => void;
  toolkits: readonly CatalogToolkitSummary[];
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [toolkit, setToolkit] = useState(toolkits[0]?.slug ?? "");
  const [userId, setUserId] = useState("user_123");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{
    code: string;
    message: string;
  }>();

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current
      ?.querySelector<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input, select',
      )
      ?.focus();
    function handleDialogKeys(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable === undefined || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.removeEventListener("keydown", handleDialogKeys);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, submitting]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (userId.trim().length === 0 || toolkit.length === 0) {
      setError({
        code: "invalid_input",
        message: "Choose a toolkit and enter an external user ID.",
      });
      return;
    }
    setSubmitting(true);
    setError(undefined);
    const optimistic: ConnectionRow = {
      connectionId: `conn_optimistic_${Date.now()}`,
      createdAt: new Date().toISOString(),
      optimistic: true,
      status: "connected",
      toolkit,
      userId: userId.trim(),
    };
    onCreated(optimistic);
    try {
      const created = await dashboardExecutorClient().createConnection({
        toolkit,
        userId: userId.trim(),
      });
      onCreated({
        ...optimistic,
        connectionId: created.connectionId,
        optimistic: false,
      });
      onClose();
    } catch (caught) {
      onDiscard(optimistic.connectionId);
      const apiError = caught instanceof ExecutorApiError ? caught : undefined;
      if (apiError === undefined || apiError.status === 502) {
        onUnavailable("offline");
      } else if (apiError.status === 401) {
        onUnavailable("unconfigured");
      }
      setError({
        code: apiError?.code ?? "executor_unavailable",
        message:
          apiError?.message ??
          "The configured executor is offline. Check its URL and API key, then retry.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      aria-label="New connection"
      aria-modal="true"
      className="drawer-overlay"
      ref={dialogRef}
      role="dialog"
    >
      <button
        aria-label="Close new connection panel"
        className="drawer-overlay__backdrop"
        disabled={submitting}
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <Panel
        className="connection-panel"
        description="Creates a process-local fixture connection for development."
        drawer
        {...(submitting
          ? {}
          : {
              onClose,
              onCloseLabel: "Close new connection panel",
            })}
        title="New connection"
      >
        <form className="connection-form" onSubmit={submit}>
          <Select
            hint="The executor dev vault must have a fixture for this toolkit."
            label="Toolkit"
            onChange={(event) => setToolkit(event.currentTarget.value)}
            options={toolkits.map((item) => ({
              label: item.displayName,
              value: item.slug,
            }))}
            value={toolkit}
          />
          <Input
            hint="SDK userId maps to external_user_id."
            label="External user ID"
            mono
            onChange={(event) => setUserId(event.currentTarget.value)}
            value={userId}
          />
          {error ? (
            <div className="inline-error" role="alert">
              <span className="taxonomy-badge taxonomy-badge--error">
                {error.code}
              </span>
              <p>{error.message}</p>
            </div>
          ) : null}
          <div className="connection-form__actions">
            <Button disabled={submitting} onClick={onClose} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={submitting || toolkits.length === 0}
              icon={<Icon name="plus" />}
              type="submit"
              variant="primary"
            >
              {submitting ? "Creating…" : "Create test connection"}
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}

export function ConnectionsScreen({
  initialConnections = [],
  initialNewConnectionOpen = false,
  project,
  toolkits,
}: ConnectionsScreenProps) {
  const [connections, setConnections] =
    useState<readonly ConnectionRow[]>(initialConnections);
  const [executorState, setExecutorState] = useState<ExecutorState>(
    initialConnections.length > 0 ? "online" : "loading",
  );
  const [toolkitFilter, setToolkitFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ConnectionStatus | "all">(
    "all",
  );
  const [newConnectionOpen, setNewConnectionOpen] = useState(
    initialNewConnectionOpen,
  );
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [actionError, setActionError] = useState<{
    code: string;
    message: string;
  }>();
  const newConnectionTriggerRef = useRef<HTMLElement | null>(null);

  const toolkitBySlug = useMemo(
    () => new Map(toolkits.map((toolkit) => [toolkit.slug, toolkit])),
    [toolkits],
  );

  const loadConnections = useCallback(async (signal?: AbortSignal) => {
    try {
      const page = await dashboardExecutorClient().listConnections(signal);
      if (signal?.aborted) return;
      setConnections(page.connections);
      setExecutorState("online");
    } catch (caught) {
      if (signal?.aborted) return;
      const apiError = caught instanceof ExecutorApiError ? caught : undefined;
      setExecutorState(apiError?.status === 401 ? "unconfigured" : "offline");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadConnections(controller.signal);
    return () => {
      controller.abort();
    };
  }, [loadConnections]);

  useEffect(() => {
    function restorePanelState() {
      setNewConnectionOpen(
        new URL(window.location.href).searchParams.get("new") === "true",
      );
    }
    window.addEventListener("popstate", restorePanelState);
    return () => window.removeEventListener("popstate", restorePanelState);
  }, []);

  const openNewConnection = useCallback(() => {
    newConnectionTriggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setNewConnectionOpen(true);
    const url = new URL(window.location.href);
    url.searchParams.set("new", "true");
    window.history.pushState({}, "", url);
  }, []);

  const closeNewConnection = useCallback(() => {
    setNewConnectionOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("new");
    window.history.replaceState({}, "", url);
    window.requestAnimationFrame(() =>
      newConnectionTriggerRef.current?.focus(),
    );
  }, []);

  const visibleConnections = connections.filter((connection) => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matchesQuery =
      normalizedQuery.length === 0 ||
      [connection.userId, connection.connectionId, connection.toolkit]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    return (
      matchesQuery &&
      (toolkitFilter === "all" || connection.toolkit === toolkitFilter) &&
      (statusFilter === "all" || connection.status === statusFilter)
    );
  });

  function mergeConnection(connection: ConnectionRow) {
    if (!connection.optimistic) setExecutorState("online");
    setConnections((current) => {
      const optimisticIndex = current.findIndex(
        (candidate) =>
          candidate.optimistic &&
          candidate.userId === connection.userId &&
          candidate.toolkit === connection.toolkit,
      );
      if (optimisticIndex === -1) return [connection, ...current];
      return current.map((candidate, index) =>
        index === optimisticIndex ? connection : candidate,
      );
    });
  }

  async function revoke(connection: ConnectionRow) {
    if (connection.status === "revoked" || connection.optimistic) return;
    const confirmed = window.confirm(
      `Revoke ${connection.userId} × ${connection.toolkit} in ${project}? Future executions cannot use this connection.`,
    );
    if (!confirmed) return;

    setActionError(undefined);
    setRevoking((current) => new Set(current).add(connection.connectionId));
    try {
      await dashboardExecutorClient().revokeConnection(connection.connectionId);
      setConnections((current) =>
        current.map((candidate) =>
          candidate.connectionId === connection.connectionId
            ? { ...candidate, status: "revoked" }
            : candidate,
        ),
      );
    } catch (caught) {
      const apiError = caught instanceof ExecutorApiError ? caught : undefined;
      if (apiError === undefined || apiError.status === 502)
        setExecutorState("offline");
      else if (apiError.status === 401) setExecutorState("unconfigured");
      setActionError({
        code: apiError?.code ?? "executor_unavailable",
        message:
          apiError?.message ?? "The connection could not be revoked right now.",
      });
    } finally {
      setRevoking((current) => {
        const next = new Set(current);
        next.delete(connection.connectionId);
        return next;
      });
    }
  }

  const attentionCount = connections.filter(
    (connection) => connection.status !== "connected",
  ).length;

  return (
    <div className="page-stack connections-page">
      <PageHeader
        actions={
          <Button
            icon={<Icon name="plus" />}
            onClick={openNewConnection}
            variant="primary"
          >
            New connection
          </Button>
        }
        description="Inspect the external user × toolkit account matrix, create fixture connections, and revoke development credentials without exposing tokens."
        eyebrow="Operational identity"
        title="Connections"
      />

      <section className="connection-summary" aria-label="Connection summary">
        <div>
          <strong className="mono">{connections.length}</strong>
          <span>{connections.length === 1 ? "account" : "accounts"}</span>
        </div>
        <div>
          <strong className={cn("mono", attentionCount > 0 && "text-warning")}>
            {attentionCount}
          </strong>
          <span>need attention</span>
        </div>
        <div className="connection-summary__executor">
          <span
            className={cn(
              "status-dot",
              executorState === "online"
                ? "status-dot--success"
                : executorState === "loading"
                  ? "status-dot--accent status-dot--pulse"
                  : executorState === "unconfigured"
                    ? "status-dot--warning"
                    : "status-dot--error",
            )}
          />
          {executorState === "online"
            ? "Executor connected"
            : executorState === "loading"
              ? "Loading dev vault"
              : executorState === "unconfigured"
                ? "Server key required"
                : "Executor offline"}
        </div>
      </section>

      {executorState === "offline" || executorState === "unconfigured" ? (
        <div
          className={cn(
            "offline-banner",
            executorState === "unconfigured" && "offline-banner--warning",
          )}
          role="status"
        >
          <Icon name="activity" />
          <div>
            <strong>
              {executorState === "unconfigured"
                ? "Authenticated connection data is not configured"
                : "Executor offline"}
            </strong>
            <p>
              {executorState === "unconfigured"
                ? "Set a server-only EYEBALL_API_KEY for this dashboard process. Never expose it through a NEXT_PUBLIC variable."
                : "Connection data could not be refreshed. The local toolkit catalog and SDK guidance remain available."}
            </p>
          </div>
          <Button
            onClick={() => void loadConnections()}
            size="small"
            variant="secondary"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <div className="inline-error" role="alert">
          <span className="taxonomy-badge taxonomy-badge--error">
            {actionError.code}
          </span>
          <p>{actionError.message}</p>
        </div>
      ) : null}

      {executorState === "loading" ? (
        <section
          aria-label="Connections loading"
          className="connections-loading"
        >
          <div className="connections-loading__filters">
            <Skeleton
              height={38}
              label="Connection search loading"
              width="min(100%, 420px)"
            />
            <Skeleton height={38} label="Toolkit filter loading" width={138} />
            <Skeleton height={38} label="Status filter loading" width={124} />
          </div>
          {["one", "two", "three", "four"].map((row) => (
            <div className="connections-loading__row" key={row}>
              <Skeleton
                height={14}
                label="Connection identity loading"
                width="28%"
              />
              <Skeleton
                height={14}
                label="Connection toolkit loading"
                width="18%"
              />
              <Skeleton
                height={24}
                label="Connection status loading"
                width={92}
              />
              <Skeleton
                height={14}
                label="Connection date loading"
                width="16%"
              />
            </div>
          ))}
        </section>
      ) : connections.length === 0 ? (
        <EmptyState
          actions={
            <Button
              icon={<Icon name="plus" />}
              onClick={openNewConnection}
              variant="primary"
            >
              Create test link
            </Button>
          }
          code={connectionSnippet}
          description="Create a connection for one external user. In the SDK, userId maps directly to external_user_id; secrets stay inside the vault."
          title="No connected accounts"
        />
      ) : (
        <section className="connections-table-section">
          <div className="table-filters">
            <label className="table-filters__search">
              <span>Search</span>
              <span className="table-search-control">
                <Icon name="search" />
                <input
                  className="field__control"
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="external_user_id, connection, toolkit"
                  type="search"
                  value={query}
                />
              </span>
            </label>
            <label>
              <span>Toolkit</span>
              <select
                className="field__control"
                onChange={(event) =>
                  setToolkitFilter(event.currentTarget.value)
                }
                value={toolkitFilter}
              >
                <option value="all">All toolkits</option>
                {toolkits.map((toolkit) => (
                  <option key={toolkit.slug} value={toolkit.slug}>
                    {toolkit.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select
                className="field__control"
                onChange={(event) =>
                  setStatusFilter(
                    event.currentTarget.value as ConnectionStatus | "all",
                  )
                }
                value={statusFilter}
              >
                <option value="all">All statuses</option>
                <option value="connected">Connected</option>
                <option value="expired">Expired</option>
                <option value="revoked">Revoked</option>
              </select>
            </label>
          </div>
          {visibleConnections.length > 0 ? (
            <TableShell
              caption="Project connections by external user and toolkit"
              columns={[
                { key: "user", label: "External user ID" },
                { key: "toolkit", label: "Toolkit" },
                { key: "status", label: "Status" },
                { key: "created", label: "Created (UTC)" },
                { key: "actions", label: "Actions" },
              ]}
            >
              {visibleConnections.map((connection) => {
                const toolkit = toolkitBySlug.get(connection.toolkit);
                const isRevoking = revoking.has(connection.connectionId);
                return (
                  <tr key={connection.connectionId}>
                    <td>
                      <span className="connection-identity">
                        <span>
                          <code>{connection.userId}</code>
                          <CopyButton
                            label="Copy external user ID"
                            value={connection.userId}
                          />
                        </span>
                        <span>
                          <small className="mono">
                            {connection.connectionId}
                          </small>
                          <CopyButton
                            label="Copy connection ID"
                            value={connection.connectionId}
                          />
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="connection-toolkit">
                        <span
                          aria-hidden="true"
                          className="toolkit-mark toolkit-mark--small"
                        >
                          {initials(toolkit?.displayName ?? connection.toolkit)}
                        </span>
                        <span>
                          <strong>
                            {toolkit?.displayName ?? connection.toolkit}
                          </strong>
                          <code>{connection.toolkit}</code>
                        </span>
                      </span>
                    </td>
                    <td>
                      <Badge status={connection.status} />
                      {connection.optimistic ? (
                        <small className="optimistic-label">Creating…</small>
                      ) : null}
                    </td>
                    <td className="mono">
                      {createdLabel(connection.createdAt)}
                    </td>
                    <td>
                      <span className="row-actions">
                        <Button
                          disabled
                          size="small"
                          title="hosted OAuth — eyeball cloud"
                          variant="ghost"
                        >
                          Re-auth
                        </Button>
                        <Button
                          disabled={
                            connection.status === "revoked" ||
                            connection.optimistic ||
                            isRevoking
                          }
                          onClick={() => revoke(connection)}
                          size="small"
                          variant="danger"
                        >
                          {isRevoking ? "Revoking…" : "Revoke"}
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </TableShell>
          ) : (
            <div className="filtered-empty">
              <Icon name="connections" />
              <h2>No connections match these filters</h2>
              <p>
                Change the toolkit or status filter to restore the account
                matrix.
              </p>
              <Button
                onClick={() => {
                  setQuery("");
                  setToolkitFilter("all");
                  setStatusFilter("all");
                }}
                variant="secondary"
              >
                Clear filters
              </Button>
            </div>
          )}
        </section>
      )}

      {newConnectionOpen ? (
        <NewConnectionPanel
          onClose={closeNewConnection}
          onCreated={mergeConnection}
          onDiscard={(connectionId) =>
            setConnections((current) =>
              current.filter(
                (connection) => connection.connectionId !== connectionId,
              ),
            )
          }
          onUnavailable={setExecutorState}
          toolkits={toolkits}
        />
      ) : null}
    </div>
  );
}
