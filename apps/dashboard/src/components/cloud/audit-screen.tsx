"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/src/components/pages/page-header";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { TableShell } from "@/src/components/ui/table";
import {
  CloudApiError,
  type CloudAuditEvent,
  dashboardCloudClient,
} from "@/src/lib/cloud-api";

export interface AuditScreenProps {
  initialEvents: readonly CloudAuditEvent[];
  organizationId: string;
  organizationName: string;
}

function timestampLabel(value: string): string {
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

function metadataLabel(metadata: CloudAuditEvent["metadata"]): string {
  if (metadata === null || Object.keys(metadata).length === 0) return "—";
  const serialized = JSON.stringify(metadata);
  return serialized.length <= 120 ? serialized : `${serialized.slice(0, 117)}…`;
}

export function filterAuditEvents(
  events: readonly CloudAuditEvent[],
  action: string,
): readonly CloudAuditEvent[] {
  return action === "all"
    ? events
    : events.filter((event) => event.action === action);
}

export function AuditScreen({
  initialEvents,
  organizationId,
  organizationName,
}: AuditScreenProps) {
  const [events, setEvents] = useState(initialEvents);
  const [action, setAction] = useState("all");
  const [error, setError] = useState<{ code: string; message: string }>();
  const actions = useMemo(
    () => [...new Set(events.map((event) => event.action))].sort(),
    [events],
  );
  const visibleEvents = filterAuditEvents(events, action);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const page = await dashboardCloudClient().listAuditEvents(
          organizationId,
          {
            limit: 200,
            ...(signal === undefined ? {} : { signal }),
          },
        );
        if (!signal?.aborted) setEvents(page.events);
      } catch (caught) {
        if (signal?.aborted) return;
        const apiError = caught instanceof CloudApiError ? caught : undefined;
        setError({
          code: apiError?.code ?? "cloud_unavailable",
          message: apiError?.message ?? "Audit events could not be refreshed.",
        });
      }
    },
    [organizationId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return (
    <div className="page-stack cloud-list-page">
      <PageHeader
        actions={
          <Button
            icon={<Icon name="activity" />}
            onClick={() => void refresh()}
            variant="secondary"
          >
            Refresh
          </Button>
        }
        description={`Review organization-scoped control-plane activity for ${organizationName}. Events contain identifiers and safe metadata, never stored credentials.`}
        eyebrow="Organization / Audit log"
        title="Audit log"
      />

      {error ? (
        <div className="inline-error" role="alert">
          <span className="taxonomy-badge taxonomy-badge--error">
            {error.code}
          </span>
          <p>{error.message}</p>
        </div>
      ) : null}

      <section className="audit-controls surface">
        <div>
          <strong>{events.length} recorded events</strong>
          <span>Newest first · UTC</span>
        </div>
        <label>
          <span>Filter by action</span>
          <select
            className="field__control"
            onChange={(event) => setAction(event.currentTarget.value)}
            value={action}
          >
            <option value="all">All actions</option>
            {actions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </section>

      {visibleEvents.length === 0 ? (
        <section className="cloud-empty surface surface--raised">
          <span className="cloud-empty__icon" aria-hidden="true">
            <Icon name="activity" />
          </span>
          <h2>No matching audit events</h2>
          <p>
            {events.length === 0
              ? "Control-plane activity will appear here."
              : "Choose another action to see its history."}
          </p>
          {action === "all" ? null : (
            <Button onClick={() => setAction("all")}>Clear filter</Button>
          )}
        </section>
      ) : (
        <TableShell
          caption={`Audit events for ${organizationName}`}
          columns={[
            { key: "time", label: "Time (UTC)" },
            { key: "action", label: "Action" },
            { key: "actor", label: "Actor" },
            { key: "target", label: "Target" },
            { key: "metadata", label: "Safe metadata" },
          ]}
        >
          {visibleEvents.map((event) => (
            <tr key={`${event.sequence}-${event.action}`}>
              <td className="mono audit-time">
                {timestampLabel(event.createdAt)}
              </td>
              <td>
                <code className="audit-action">{event.action}</code>
              </td>
              <td className="mono">{event.actorUserId ?? "system"}</td>
              <td>
                <span className="audit-target">
                  <strong>{event.targetType}</strong>
                  <code>{event.targetId ?? "—"}</code>
                </span>
              </td>
              <td>
                <code className="audit-metadata">
                  {metadataLabel(event.metadata)}
                </code>
              </td>
            </tr>
          ))}
        </TableShell>
      )}
    </div>
  );
}
