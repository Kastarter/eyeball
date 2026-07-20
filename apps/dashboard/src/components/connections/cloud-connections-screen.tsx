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
import { TableShell } from "@/src/components/ui/table";
import type { CatalogToolkitSummary } from "@/src/lib/catalog";
import {
  CloudApiError,
  type CloudConnection,
  type CloudConnectionStatus,
  type CloudOAuthApp,
  type CreateCloudConnectionRequest,
  dashboardCloudClient,
} from "@/src/lib/cloud-api";
import { cn } from "@/src/lib/cn";

interface HostedConnectLink {
  expiresAt: string;
  redirectUrl: string;
  toolkit: string;
}

export interface CloudConnectionsScreenProps {
  initialConnections: readonly CloudConnection[];
  initialNewConnectionOpen?: boolean;
  oauthApps: readonly CloudOAuthApp[];
  oauthRedirectOrigins: readonly string[];
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

function dateLabel(value: string): string {
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

function fieldLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

function mergeConnection(
  connections: readonly CloudConnection[],
  connection: CloudConnection,
): readonly CloudConnection[] {
  const exists = connections.some(
    (candidate) => candidate.id === connection.id,
  );
  return exists
    ? connections.map((candidate) =>
        candidate.id === connection.id ? connection : candidate,
      )
    : [connection, ...connections];
}

export function cloudConnectionRequest({
  externalUserId,
  fields,
  oauthAppId = "",
  providerAccountLabel,
  returnUrl = "",
  toolkit,
}: {
  externalUserId: string;
  fields: Readonly<Record<string, string>>;
  oauthAppId?: string;
  providerAccountLabel: string;
  returnUrl?: string;
  toolkit: CatalogToolkitSummary;
}): CreateCloudConnectionRequest {
  const common = {
    externalUserId: externalUserId.trim(),
    ...(providerAccountLabel.trim().length === 0
      ? {}
      : { providerAccountLabel: providerAccountLabel.trim() }),
    toolkit: toolkit.slug,
  };
  if (toolkit.authClass === "oauth2") {
    return {
      authType: "oauth2",
      ...common,
      ...(oauthAppId.trim().length === 0
        ? {}
        : { oauthAppId: oauthAppId.trim() }),
      ...(returnUrl.trim().length === 0 ? {} : { returnUrl: returnUrl.trim() }),
    };
  }
  return {
    authType: "api_key",
    ...common,
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, value.trim()]),
    ),
  };
}

export function validateCloudReturnUrl(
  value: string,
  registeredOrigins: readonly string[],
): string | undefined {
  const candidate = value.trim();
  if (candidate.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return "Return URL must be a valid URL.";
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    return "Return URL must use HTTPS (HTTP is allowed only for loopback development).";
  }
  if (!registeredOrigins.includes(url.origin)) {
    return "Return URL origin is not registered in Organization settings.";
  }
  return undefined;
}

export function confirmCloudConnectionRevocation(
  connection: CloudConnection,
  confirm: (message: string) => boolean,
): boolean {
  if (connection.status === "revoked") return false;
  return confirm(
    `Revoke ${connection.externalUserId} × ${connection.toolkit}? Future executions cannot use this connection.`,
  );
}

export function HostedConnectLinkDialog({
  link,
  onClose,
}: {
  link: HostedConnectLink;
  onClose: () => void;
}) {
  return (
    <div
      aria-labelledby="hosted-connect-title"
      aria-modal="true"
      className="modal-overlay"
      role="dialog"
    >
      <button
        aria-label="Close hosted connection link"
        className="modal-overlay__backdrop"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <section className="hosted-connect-link surface surface--raised">
        <div className="hosted-connect-link__icon" aria-hidden="true">
          <Icon name="connections" />
        </div>
        <p className="eyebrow">End-user connect link</p>
        <h2 id="hosted-connect-title">Continue with {link.toolkit}</h2>
        <p>
          Send this short-lived link to the end user, or open it now to finish
          provider authorization. It expires {dateLabel(link.expiresAt)} UTC.
        </p>
        <div className="secret-value hosted-connect-link__value">
          <code>{link.redirectUrl}</code>
          <CopyButton
            label="Copy hosted connection link"
            value={link.redirectUrl}
          />
        </div>
        <div className="modal-actions">
          <Button onClick={onClose} variant="ghost">
            Close
          </Button>
          <a
            className="button button--primary"
            href={link.redirectUrl}
            rel="noreferrer"
            target="_blank"
          >
            Open in new tab
            <Icon name="arrowRight" />
          </a>
        </div>
      </section>
    </div>
  );
}

function CloudNewConnectionPanel({
  onClose,
  onCreated,
  onHostedLink,
  oauthApps,
  oauthRedirectOrigins,
  project,
  toolkits,
}: {
  onClose: () => void;
  onCreated: (connection: CloudConnection) => void;
  onHostedLink: (link: HostedConnectLink) => void;
  oauthApps: readonly CloudOAuthApp[];
  oauthRedirectOrigins: readonly string[];
  project: string;
  toolkits: readonly CatalogToolkitSummary[];
}) {
  const connectableToolkits = useMemo(
    () => toolkits.filter((toolkit) => toolkit.authClass !== "none"),
    [toolkits],
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const [toolkitSlug, setToolkitSlug] = useState(
    connectableToolkits[0]?.slug ?? "",
  );
  const [externalUserId, setExternalUserId] = useState("user_123");
  const [providerAccountLabel, setProviderAccountLabel] = useState("");
  const [fields, setFields] = useState<Readonly<Record<string, string>>>({});
  const [oauthAppId, setOAuthAppId] = useState("");
  const [returnUrl, setReturnUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ code: string; message: string }>();
  const selectedToolkit = connectableToolkits.find(
    (toolkit) => toolkit.slug === toolkitSlug,
  );
  const selectedOAuthApps = oauthApps.filter(
    (app) => app.toolkit === toolkitSlug,
  );

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current
      ?.querySelector<HTMLElement>("input, select, button")
      ?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, submitting]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedToolkit === undefined || externalUserId.trim().length === 0) {
      setError({
        code: "invalid_input",
        message: "Choose a toolkit and enter an external user ID.",
      });
      return;
    }
    if (
      selectedToolkit.authClass !== "oauth2" &&
      selectedToolkit.authFields.some(
        (field) => (fields[field] ?? "").trim().length === 0,
      )
    ) {
      setError({
        code: "invalid_input",
        message:
          "Complete every credential field before creating the connection.",
      });
      return;
    }
    const returnUrlError =
      selectedToolkit.authClass === "oauth2"
        ? validateCloudReturnUrl(returnUrl, oauthRedirectOrigins)
        : undefined;
    if (returnUrlError !== undefined) {
      setError({ code: "invalid_return_url", message: returnUrlError });
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await dashboardCloudClient().createConnection(
        project,
        cloudConnectionRequest({
          externalUserId,
          fields,
          oauthAppId,
          providerAccountLabel,
          returnUrl,
          toolkit: selectedToolkit,
        }),
      );
      onCreated(result.connection);
      onClose();
      if ("redirectUrl" in result) {
        onHostedLink({
          expiresAt: result.expiresAt,
          redirectUrl: result.redirectUrl,
          toolkit: selectedToolkit.displayName,
        });
      }
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message:
          apiError?.message ?? "The hosted connection could not be created.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      aria-label="Add connection"
      aria-modal="true"
      className="drawer-overlay"
      ref={dialogRef}
      role="dialog"
    >
      <button
        aria-label="Close add connection panel"
        className="drawer-overlay__backdrop"
        disabled={submitting}
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <Panel
        className="connection-panel"
        description="Credentials are sent through the same-origin dashboard proxy and stored by the cloud vault."
        drawer
        {...(submitting
          ? {}
          : { onClose, onCloseLabel: "Close add connection panel" })}
        title="Add connection"
      >
        <form className="connection-form" onSubmit={submit}>
          <Select
            hint="Only toolkits that require credentials are listed."
            label="Toolkit"
            onChange={(event) => {
              setToolkitSlug(event.currentTarget.value);
              setFields({});
              setOAuthAppId("");
            }}
            options={connectableToolkits.map((toolkit) => ({
              label: `${toolkit.displayName} · ${toolkit.authClass}`,
              value: toolkit.slug,
            }))}
            value={toolkitSlug}
          />
          <Input
            hint="Stable ID from your product; it scopes this user's credential."
            label="External user ID"
            mono
            onChange={(event) => setExternalUserId(event.currentTarget.value)}
            required
            value={externalUserId}
          />
          <Input
            hint="Optional human-readable provider account label."
            label="Account label"
            onChange={(event) =>
              setProviderAccountLabel(event.currentTarget.value)
            }
            value={providerAccountLabel}
          />
          {selectedToolkit?.authClass === "oauth2" ? (
            <>
              <Select
                hint="Choose an organization app, or use Eyeball's configured shared default."
                label="OAuth app"
                onChange={(event) => setOAuthAppId(event.currentTarget.value)}
                options={[
                  {
                    label: "Automatic (organization app, then shared)",
                    value: "",
                  },
                  ...selectedOAuthApps.map((app) => ({
                    label:
                      app.kind === "shared"
                        ? "Eyeball shared default"
                        : `${app.clientId} · organization app`,
                    value: app.id,
                  })),
                ]}
                value={oauthAppId}
              />
              <Input
                hint={
                  oauthRedirectOrigins.length === 0
                    ? "Optional. Register its origin in Organization settings first."
                    : `Optional. Registered origins: ${oauthRedirectOrigins.join(", ")}`
                }
                label="Return URL"
                mono
                onChange={(event) => setReturnUrl(event.currentTarget.value)}
                placeholder="https://app.example.com/settings/connections"
                type="url"
                value={returnUrl}
              />
              <div className="connect-auth-note">
                <Icon name="connections" />
                <p>
                  Creating this connection returns a short-lived hosted OAuth
                  link. After authorization, a registered return URL can send
                  the user back to your application.
                </p>
              </div>
            </>
          ) : (
            selectedToolkit?.authFields.map((field) => (
              <Input
                autoComplete="off"
                key={field}
                label={fieldLabel(field)}
                mono
                onChange={(event) =>
                  setFields((current) => ({
                    ...current,
                    [field]: event.currentTarget.value,
                  }))
                }
                required
                type="password"
                value={fields[field] ?? ""}
              />
            ))
          )}
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
              disabled={submitting || selectedToolkit === undefined}
              icon={<Icon name="plus" />}
              type="submit"
              variant="primary"
            >
              {submitting ? "Creating…" : "Create connection"}
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}

export function CloudConnectionsScreen({
  initialConnections,
  initialNewConnectionOpen = false,
  oauthApps,
  oauthRedirectOrigins,
  project,
  toolkits,
}: CloudConnectionsScreenProps) {
  const [connections, setConnections] =
    useState<readonly CloudConnection[]>(initialConnections);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    CloudConnectionStatus | "all"
  >("all");
  const [newConnectionOpen, setNewConnectionOpen] = useState(
    initialNewConnectionOpen,
  );
  const [hostedLink, setHostedLink] = useState<HostedConnectLink>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<{
    code: string;
    message: string;
  }>();
  const triggerRef = useRef<HTMLElement | null>(null);
  const toolkitBySlug = useMemo(
    () => new Map(toolkits.map((toolkit) => [toolkit.slug, toolkit])),
    [toolkits],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const page = await dashboardCloudClient().listConnections(
          project,
          signal,
        );
        if (!signal?.aborted) setConnections(page.connections);
      } catch (caught) {
        if (signal?.aborted) return;
        const apiError = caught instanceof CloudApiError ? caught : undefined;
        setActionError({
          code: apiError?.code ?? "cloud_unavailable",
          message:
            apiError?.message ?? "Connection data could not be refreshed.",
        });
      }
    },
    [project],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const visibleConnections = connections.filter((connection) => {
    const normalized = query.trim().toLocaleLowerCase();
    const matchesQuery =
      normalized.length === 0 ||
      [
        connection.externalUserId,
        connection.id,
        connection.providerAccountLabel ?? "",
        connection.toolkit,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized);
    return (
      matchesQuery &&
      (statusFilter === "all" || connection.status === statusFilter)
    );
  });

  function openNewConnection() {
    triggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setNewConnectionOpen(true);
  }

  function closeNewConnection() {
    setNewConnectionOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function revoke(connection: CloudConnection) {
    if (!confirmCloudConnectionRevocation(connection, window.confirm)) return;
    setActionError(undefined);
    setBusy((current) => new Set(current).add(connection.id));
    try {
      const result = (
        await dashboardCloudClient().revokeConnection(project, connection.id)
      ).connection;
      setConnections((current) => mergeConnection(current, result));
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setActionError({
        code: apiError?.code ?? "cloud_unavailable",
        message: apiError?.message ?? "The connection could not be revoked.",
      });
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(connection.id);
        return next;
      });
    }
  }

  async function reauthorize(connection: CloudConnection) {
    setActionError(undefined);
    setBusy((current) => new Set(current).add(connection.id));
    try {
      const result = await dashboardCloudClient().reauthorizeConnection(
        project,
        connection.id,
      );
      setConnections((current) => mergeConnection(current, result.connection));
      setHostedLink({
        expiresAt: result.expiresAt,
        redirectUrl: result.redirectUrl,
        toolkit:
          toolkitBySlug.get(connection.toolkit)?.displayName ??
          connection.toolkit,
      });
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setActionError({
        code: apiError?.code ?? "cloud_unavailable",
        message: apiError?.message ?? "Reauthorization could not be started.",
      });
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(connection.id);
        return next;
      });
    }
  }

  const attentionCount = connections.filter(
    (connection) =>
      connection.status === "expired" || connection.status === "needs_reauth",
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
            Add connection
          </Button>
        }
        description="Manage project-scoped credentials in the cloud vault, issue hosted OAuth links, and reauthorize accounts without exposing provider tokens."
        eyebrow="Project / Connections"
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
          <span className="status-dot status-dot--success" />
          Cloud vault connected
        </div>
      </section>

      {actionError ? (
        <div className="inline-error" role="alert">
          <span className="taxonomy-badge taxonomy-badge--error">
            {actionError.code}
          </span>
          <p>{actionError.message}</p>
          <Button onClick={() => void refresh()} size="small" variant="ghost">
            Retry
          </Button>
        </div>
      ) : null}

      {connections.length === 0 ? (
        <EmptyState
          actions={
            <Button
              icon={<Icon name="plus" />}
              onClick={openNewConnection}
              variant="primary"
            >
              Add first connection
            </Button>
          }
          code={`// Hosted OAuth connections return a revealable end-user link.\n{ authType: "oauth2", toolkit: "github", externalUserId: "user_123" }`}
          description="Choose a toolkit, bind it to an external user ID, then provide API-key fields or share the returned hosted OAuth link."
          title="No cloud connections"
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
                  placeholder="user, connection, label, or toolkit"
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
                    event.currentTarget.value as CloudConnectionStatus | "all",
                  )
                }
                value={statusFilter}
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="pending">Pending</option>
                <option value="needs_reauth">Needs reauth</option>
                <option value="expired">Expired</option>
                <option value="revoked">Revoked</option>
              </select>
            </label>
          </div>
          {visibleConnections.length === 0 ? (
            <div className="filtered-empty">
              <Icon name="connections" />
              <h2>No connections match</h2>
              <p>Clear the search and status filter to restore the list.</p>
              <Button
                onClick={() => {
                  setQuery("");
                  setStatusFilter("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <TableShell
              caption="Cloud connections by external user and toolkit"
              columns={[
                { key: "user", label: "External user" },
                { key: "toolkit", label: "Toolkit" },
                { key: "status", label: "Status" },
                { key: "updated", label: "Updated (UTC)" },
                { key: "actions", label: "Actions" },
              ]}
            >
              {visibleConnections.map((connection) => {
                const toolkit = toolkitBySlug.get(connection.toolkit);
                const isBusy = busy.has(connection.id);
                return (
                  <tr key={connection.id}>
                    <td>
                      <span className="connection-identity">
                        <span>
                          <code>{connection.externalUserId}</code>
                          <CopyButton
                            label="Copy external user ID"
                            value={connection.externalUserId}
                          />
                        </span>
                        <span>
                          <small>
                            {connection.providerAccountLabel ?? connection.id}
                          </small>
                          <CopyButton
                            label="Copy connection ID"
                            value={connection.id}
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
                          <code>{connection.authType}</code>
                        </span>
                      </span>
                    </td>
                    <td>
                      <Badge status={connection.status} />
                    </td>
                    <td className="mono">{dateLabel(connection.updatedAt)}</td>
                    <td>
                      <span className="row-actions">
                        <Button
                          disabled={
                            connection.authType !== "oauth2" ||
                            connection.status === "revoked" ||
                            isBusy
                          }
                          onClick={() => void reauthorize(connection)}
                          size="small"
                          variant="ghost"
                        >
                          Re-auth
                        </Button>
                        <Button
                          disabled={connection.status === "revoked" || isBusy}
                          onClick={() => void revoke(connection)}
                          size="small"
                          variant="danger"
                        >
                          {isBusy ? "Working…" : "Revoke"}
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </TableShell>
          )}
        </section>
      )}

      {newConnectionOpen ? (
        <CloudNewConnectionPanel
          onClose={closeNewConnection}
          onCreated={(connection) =>
            setConnections((current) => mergeConnection(current, connection))
          }
          onHostedLink={setHostedLink}
          oauthApps={oauthApps}
          oauthRedirectOrigins={oauthRedirectOrigins}
          project={project}
          toolkits={toolkits}
        />
      ) : null}
      {hostedLink ? (
        <HostedConnectLinkDialog
          link={hostedLink}
          onClose={() => setHostedLink(undefined)}
        />
      ) : null}
    </div>
  );
}
