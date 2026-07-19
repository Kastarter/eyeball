"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/src/components/pages/page-header";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { CopyButton } from "@/src/components/ui/copy-button";
import { Input } from "@/src/components/ui/form-controls";
import { Icon } from "@/src/components/ui/icon";
import { TableShell } from "@/src/components/ui/table";
import {
  CloudApiError,
  type CloudApiKey,
  dashboardCloudClient,
} from "@/src/lib/cloud-api";
import { SecretRevealDialog } from "./secret-reveal-dialog";

export interface ApiKeysScreenProps {
  currentUserId: string;
  initialApiKeys: readonly CloudApiKey[];
  project: string;
}

function dateLabel(value: string | null): string {
  if (value === null) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

export function confirmApiKeyRevocation(
  apiKey: CloudApiKey,
  confirm: (message: string) => boolean,
): boolean {
  if (apiKey.revokedAt !== null) return false;
  return confirm(
    `Revoke ${apiKey.name} (${apiKey.prefix}…)? Clients using it will immediately lose access.`,
  );
}

function ApiKeyCreateDialog({
  currentUserId,
  onClose,
  onCreated,
  project,
}: {
  currentUserId: string;
  onClose: () => void;
  onCreated: (result: { apiKey: CloudApiKey; key: string }) => void;
  project: string;
}) {
  const [name, setName] = useState("Dashboard operator key");
  const [pinned, setPinned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ code: string; message: string }>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await dashboardCloudClient().createApiKey(project, {
        name: name.trim(),
        ...(pinned ? { pinnedUserId: currentUserId } : {}),
      });
      onCreated(result);
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message: apiError?.message ?? "The project key could not be created.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      aria-labelledby="create-api-key-title"
      aria-modal="true"
      className="modal-overlay"
      role="dialog"
    >
      <button
        aria-label="Close API key form"
        className="modal-overlay__backdrop"
        disabled={submitting}
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <section className="cloud-form-modal surface surface--raised">
        <p className="eyebrow">Project credential</p>
        <h2 id="create-api-key-title">Create API key</h2>
        <p>
          The full key is shown once. Store it in a server-side secrets manager,
          never in browser code or a public environment variable.
        </p>
        <form className="cloud-form" onSubmit={submit}>
          <Input
            label="Key name"
            onChange={(event) => setName(event.currentTarget.value)}
            required
            value={name}
          />
          <label className="check-field">
            <input
              checked={pinned}
              onChange={(event) => setPinned(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>
              <strong>Pin to my user identity</strong>
              <small>
                Executor calls made with this key cannot claim a different user.
              </small>
            </span>
          </label>
          {error ? (
            <div className="inline-error" role="alert">
              <span className="taxonomy-badge taxonomy-badge--error">
                {error.code}
              </span>
              <p>{error.message}</p>
            </div>
          ) : null}
          <div className="modal-actions">
            <Button disabled={submitting} onClick={onClose} variant="ghost">
              Cancel
            </Button>
            <Button disabled={submitting} type="submit" variant="primary">
              {submitting ? "Creating…" : "Create key"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function ApiKeysScreen({
  currentUserId,
  initialApiKeys,
  project,
}: ApiKeysScreenProps) {
  const [apiKeys, setApiKeys] =
    useState<readonly CloudApiKey[]>(initialApiKeys);
  const [createOpen, setCreateOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string>();
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [error, setError] = useState<{ code: string; message: string }>();

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const page = await dashboardCloudClient().listApiKeys(project, signal);
        if (!signal?.aborted) setApiKeys(page.apiKeys);
      } catch (caught) {
        if (signal?.aborted) return;
        const apiError = caught instanceof CloudApiError ? caught : undefined;
        setError({
          code: apiError?.code ?? "cloud_unavailable",
          message: apiError?.message ?? "Project keys could not be refreshed.",
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

  async function revoke(apiKey: CloudApiKey) {
    if (!confirmApiKeyRevocation(apiKey, window.confirm)) return;
    setError(undefined);
    setRevoking((current) => new Set(current).add(apiKey.id));
    try {
      const result = await dashboardCloudClient().revokeApiKey(
        project,
        apiKey.id,
      );
      setApiKeys((current) =>
        current.map((candidate) =>
          candidate.id === result.apiKey.id ? result.apiKey : candidate,
        ),
      );
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message: apiError?.message ?? "The project key could not be revoked.",
      });
    } finally {
      setRevoking((current) => {
        const next = new Set(current);
        next.delete(apiKey.id);
        return next;
      });
    }
  }

  return (
    <div className="page-stack cloud-list-page">
      <PageHeader
        actions={
          <Button
            icon={<Icon name="plus" />}
            onClick={() => setCreateOpen(true)}
            variant="primary"
          >
            Create key
          </Button>
        }
        description="Issue project-scoped executor credentials, optionally pin them to your user identity, and revoke access without displaying stored secrets."
        eyebrow="Access control"
        title="API Keys"
      />

      <div className="security-callout">
        <Icon name="key" />
        <div>
          <strong>Only prefixes remain visible after creation</strong>
          <p>
            Copy a new key during the reveal-once step. The control plane cannot
            retrieve the full value later.
          </p>
        </div>
      </div>

      {error ? (
        <div className="inline-error" role="alert">
          <span className="taxonomy-badge taxonomy-badge--error">
            {error.code}
          </span>
          <p>{error.message}</p>
          <Button onClick={() => void refresh()} size="small" variant="ghost">
            Retry
          </Button>
        </div>
      ) : null}

      {apiKeys.length === 0 ? (
        <section className="cloud-empty surface surface--raised">
          <span className="cloud-empty__icon" aria-hidden="true">
            <Icon name="key" />
          </span>
          <h2>No project keys yet</h2>
          <p>Create the first key, then store it immediately.</p>
          <Button onClick={() => setCreateOpen(true)} variant="primary">
            Create first key
          </Button>
        </section>
      ) : (
        <TableShell
          caption="Project API keys"
          columns={[
            { key: "name", label: "Name" },
            { key: "prefix", label: "Prefix" },
            { key: "scope", label: "Identity scope" },
            { key: "usage", label: "Last used (UTC)" },
            { key: "status", label: "Status" },
            { key: "actions", label: "Actions" },
          ]}
        >
          {apiKeys.map((apiKey) => {
            const isRevoking = revoking.has(apiKey.id);
            return (
              <tr key={apiKey.id}>
                <td>
                  <strong>{apiKey.name}</strong>
                  <small className="table-subline mono">
                    Created {dateLabel(apiKey.createdAt)}
                  </small>
                </td>
                <td>
                  <span className="prefix-cell">
                    <code>{apiKey.prefix}…</code>
                    <CopyButton
                      label="Copy API key prefix"
                      value={apiKey.prefix}
                    />
                  </span>
                </td>
                <td>
                  {apiKey.pinnedUserId === null ? (
                    <span>All project users</span>
                  ) : (
                    <span className="pinned-user">
                      <Icon name="key" />
                      {apiKey.pinnedUserId === currentUserId
                        ? "Pinned to you"
                        : "Pinned to one user"}
                    </span>
                  )}
                </td>
                <td className="mono">{dateLabel(apiKey.lastUsedAt)}</td>
                <td>
                  <Badge
                    status={apiKey.revokedAt === null ? "active" : "revoked"}
                  />
                </td>
                <td>
                  <Button
                    disabled={apiKey.revokedAt !== null || isRevoking}
                    onClick={() => void revoke(apiKey)}
                    size="small"
                    variant="danger"
                  >
                    {isRevoking ? "Revoking…" : "Revoke"}
                  </Button>
                </td>
              </tr>
            );
          })}
        </TableShell>
      )}

      {createOpen ? (
        <ApiKeyCreateDialog
          currentUserId={currentUserId}
          onClose={() => setCreateOpen(false)}
          onCreated={(result) => {
            setApiKeys((current) => [result.apiKey, ...current]);
            setCreateOpen(false);
            setRevealedKey(result.key);
          }}
          project={project}
        />
      ) : null}
      {revealedKey ? (
        <SecretRevealDialog
          onClose={() => setRevealedKey(undefined)}
          secret={revealedKey}
          title="Store this project key now"
        />
      ) : null}
    </div>
  );
}
