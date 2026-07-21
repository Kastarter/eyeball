"use client";

import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/form-controls";
import { Icon } from "@/src/components/ui/icon";
import { Panel } from "@/src/components/ui/panel";
import { Skeleton } from "@/src/components/ui/skeleton";
import { Tabs } from "@/src/components/ui/tabs";
import {
  type CreatedWebhookEndpoint,
  ExecutorApiError,
  type ExecutorClient,
  type RotatedWebhookSecret,
  type UpdateWebhookEndpointRequest,
  type WebhookDeliveryPage,
  type WebhookEndpoint,
  type WebhookSubscriptionEventType,
} from "@/src/lib/api";
import type { CatalogWebhookTriggerOption } from "@/src/lib/catalog";
import { WebhookDeliveriesTab } from "./webhook-deliveries-tab";
import {
  sortWebhookEvents,
  WebhookEventSelector,
} from "./webhook-event-selector";
import {
  confirmWebhookDeletion,
  confirmWebhookSecretRotation,
} from "./webhook-state";

export type WebhookEndpointDrawerTab = "settings" | "deliveries";

interface InlineErrorValue {
  code: string;
  message: string;
}

function InlineError({ error }: { error?: InlineErrorValue | undefined }) {
  if (error === undefined) return null;
  return (
    <div className="inline-error" role="alert">
      <span className="taxonomy-badge taxonomy-badge--error">{error.code}</span>
      <p>{error.message}</p>
    </div>
  );
}

function normalizedError(caught: unknown, fallback: string): InlineErrorValue {
  const error = caught instanceof ExecutorApiError ? caught : undefined;
  return {
    code: error?.code ?? "executor_unavailable",
    message: error?.message ?? fallback,
  };
}

export function validateWebhookDestinationUrl(
  value: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter an absolute HTTPS URL.";
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    return "Use HTTPS without embedded credentials or a fragment.";
  }
  return undefined;
}

function sameEvents(
  left: readonly WebhookSubscriptionEventType[],
  right: readonly WebhookSubscriptionEventType[],
): boolean {
  return (
    sortWebhookEvents(left).join("\u0000") ===
    sortWebhookEvents(right).join("\u0000")
  );
}

export function webhookEndpointPatch(
  endpoint: WebhookEndpoint,
  values: {
    active: boolean;
    events: readonly WebhookSubscriptionEventType[];
    url: string;
  },
): UpdateWebhookEndpointRequest {
  const url = values.url.trim();
  return {
    ...(url === endpoint.url ? {} : { url }),
    ...(sameEvents(values.events, endpoint.events)
      ? {}
      : { events: sortWebhookEvents(values.events) }),
    ...(values.active === endpoint.active ? {} : { active: values.active }),
  };
}

function hasPatchValues(request: UpdateWebhookEndpointRequest): boolean {
  return (
    request.url !== undefined ||
    request.events !== undefined ||
    request.active !== undefined
  );
}

export interface WebhookEndpointDrawerProps {
  catalogTriggerOptions: readonly CatalogWebhookTriggerOption[];
  client: ExecutorClient;
  endpoint?: WebhookEndpoint;
  endpointId?: string;
  initialDeliveryPage?: WebhookDeliveryPage;
  mode: "create" | "edit";
  onClose: () => void;
  onCreated: (endpoint: CreatedWebhookEndpoint) => void;
  onDeleted: (endpointId: string) => void;
  onRefreshEndpoints: () => void;
  onRotated: (rotation: RotatedWebhookSecret) => void;
  onTabChange: (tab: WebhookEndpointDrawerTab) => void;
  onUpdated: (endpoint: WebhookEndpoint) => void;
  suspended?: boolean;
  tab: WebhookEndpointDrawerTab;
}

export function WebhookEndpointDrawer({
  catalogTriggerOptions,
  client,
  endpoint,
  endpointId,
  initialDeliveryPage,
  mode,
  onClose,
  onCreated,
  onDeleted,
  onRefreshEndpoints,
  onRotated,
  onTabChange,
  onUpdated,
  suspended = false,
  tab,
}: WebhookEndpointDrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [currentEndpoint, setCurrentEndpoint] = useState(endpoint);
  const [url, setUrl] = useState(endpoint?.url ?? "");
  const [events, setEvents] = useState<readonly WebhookSubscriptionEventType[]>(
    endpoint?.events ?? [],
  );
  const [active, setActive] = useState(endpoint?.active ?? true);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loadError, setLoadError] = useState<InlineErrorValue>();
  const [createError, setCreateError] = useState<InlineErrorValue>();
  const [saveError, setSaveError] = useState<InlineErrorValue>();
  const [rotationError, setRotationError] = useState<InlineErrorValue>();
  const [deleteError, setDeleteError] = useState<InlineErrorValue>();
  const busy = submitting || saving || rotating || deleting || suspended;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    document.body.style.overflow = "hidden";
    dialogRef.current
      ?.querySelector<HTMLElement>(
        'input:not([disabled]), button:not([disabled]):not([tabindex="-1"])',
      )
      ?.focus();

    function handleKeys(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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

    window.addEventListener("keydown", handleKeys);
    return () => {
      window.removeEventListener("keydown", handleKeys);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (mode !== "edit" || endpointId === undefined) return;
    const controller = new AbortController();
    setLoadError(undefined);
    void client
      .getWebhookEndpoint(endpointId, controller.signal)
      .then((fresh) => {
        if (controller.signal.aborted) return;
        setCurrentEndpoint(fresh);
        setUrl(fresh.url);
        setEvents(fresh.events);
        setActive(fresh.active);
        onUpdated(fresh);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(
          normalizedError(
            caught,
            "Current endpoint metadata could not be loaded.",
          ),
        );
      });
    return () => controller.abort();
  }, [client, endpointId, mode, onUpdated]);

  const urlError =
    url.trim().length === 0
      ? "Destination URL is required."
      : validateWebhookDestinationUrl(url);
  const eventError =
    events.length === 0 ? "Select at least one event subscription." : undefined;
  const patch =
    currentEndpoint === undefined
      ? {}
      : webhookEndpointPatch(currentEndpoint, { active, events, url });
  const valid = urlError === undefined && eventError === undefined;

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    if (!valid) return;
    setSubmitting(true);
    setCreateError(undefined);
    try {
      const created = await client.createWebhookEndpoint({
        url: url.trim(),
        events: sortWebhookEvents(events),
        active,
      });
      onCreated(created);
    } catch (caught) {
      setCreateError(
        normalizedError(caught, "The webhook endpoint could not be created."),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    if (!valid || currentEndpoint === undefined || !hasPatchValues(patch)) {
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    try {
      const updated = await client.updateWebhookEndpoint(
        currentEndpoint.endpointId,
        patch,
      );
      setCurrentEndpoint(updated);
      setUrl(updated.url);
      setEvents(updated.events);
      setActive(updated.active);
      onUpdated(updated);
    } catch (caught) {
      setSaveError(
        normalizedError(caught, "The endpoint settings could not be saved."),
      );
    } finally {
      setSaving(false);
    }
  }

  async function rotateSecret() {
    if (
      currentEndpoint === undefined ||
      !confirmWebhookSecretRotation(currentEndpoint, window.confirm)
    ) {
      return;
    }
    setRotating(true);
    setRotationError(undefined);
    try {
      const rotation = await client.rotateWebhookSecret(
        currentEndpoint.endpointId,
      );
      setCurrentEndpoint((current) =>
        current === undefined
          ? current
          : {
              ...current,
              secretPrefix: rotation.secretPrefix,
              updatedAt: rotation.rotatedAt,
            },
      );
      onRotated(rotation);
    } catch (caught) {
      setRotationError(
        normalizedError(caught, "The signing secret could not be rotated."),
      );
    } finally {
      setRotating(false);
    }
  }

  async function deleteEndpoint() {
    if (
      currentEndpoint === undefined ||
      !confirmWebhookDeletion(currentEndpoint, window.confirm)
    ) {
      return;
    }
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await client.deleteWebhookEndpoint(currentEndpoint.endpointId);
      onDeleted(currentEndpoint.endpointId);
    } catch (caught) {
      setDeleteError(
        normalizedError(caught, "The webhook endpoint could not be deleted."),
      );
    } finally {
      setDeleting(false);
    }
  }

  function endpointForm(createMode: boolean): ReactNode {
    return (
      <form
        className="webhook-endpoint-form"
        onSubmit={createMode ? create : save}
      >
        {!createMode && currentEndpoint ? (
          <div className="webhook-drawer-identity">
            <span>
              <code>{currentEndpoint.endpointId}</code>
              <Badge status={currentEndpoint.active ? "active" : "inactive"} />
            </span>
            <span>
              Signing prefix <code>{currentEndpoint.secretPrefix}</code>
            </span>
            <small>
              Updated {currentEndpoint.updatedAt} · Created{" "}
              {currentEndpoint.createdAt}
            </small>
          </div>
        ) : null}
        <Input
          disabled={busy}
          {...(attempted && urlError !== undefined ? { error: urlError } : {})}
          hint="Absolute HTTPS URL; credentials and fragments are rejected."
          label="Destination URL"
          onChange={(event) => setUrl(event.currentTarget.value)}
          placeholder="https://agent.example.com/eyeball"
          type="url"
          value={url}
        />
        <label className="webhook-active-field">
          <input
            checked={active}
            disabled={busy}
            onChange={(event) => setActive(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>
            <strong>Active</strong>
            <small>
              Turning this off causes unfinished retry work to fail; it does not
              pause deliveries.
            </small>
          </span>
        </label>
        <WebhookEventSelector
          catalogTriggerOptions={catalogTriggerOptions}
          disabled={busy}
          error={attempted ? eventError : undefined}
          onChange={setEvents}
          value={events}
        />
        {createMode ? (
          <div className="webhook-secret-notice" role="note">
            <Icon name="key" />
            <span>
              The signing secret is shown once after creation. Store it before
              dismissing the dialog.
            </span>
          </div>
        ) : null}
        <InlineError error={createMode ? createError : saveError} />
        <div className="webhook-form-actions">
          <Button disabled={busy} onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={busy || !valid || (!createMode && !hasPatchValues(patch))}
            type="submit"
            variant="primary"
          >
            {createMode
              ? submitting
                ? "Creating…"
                : "Create endpoint"
              : saving
                ? "Saving…"
                : "Save changes"}
          </Button>
        </div>
        {!createMode && currentEndpoint ? (
          <section
            className="webhook-danger-zone"
            aria-label="Destructive endpoint actions"
          >
            <div>
              <h3>Signing secret</h3>
              <p>
                Rotation invalidates the old secret immediately. Pending retries
                use the replacement.
              </p>
              <InlineError error={rotationError} />
              <Button
                disabled={busy}
                onClick={() => void rotateSecret()}
                size="small"
                variant="secondary"
              >
                {rotating ? "Rotating…" : "Rotate signing secret"}
              </Button>
            </div>
            <div>
              <h3>Delete endpoint</h3>
              <p>
                Pending work cannot continue, and endpoint-scoped history
                becomes inaccessible.
              </p>
              <InlineError error={deleteError} />
              <Button
                disabled={busy}
                onClick={() => void deleteEndpoint()}
                size="small"
                variant="danger"
              >
                {deleting ? "Deleting…" : "Delete endpoint"}
              </Button>
            </div>
          </section>
        ) : null}
      </form>
    );
  }

  const editContent =
    currentEndpoint === undefined ? (
      <div
        className="webhook-drawer-loading"
        aria-label="Webhook endpoint loading"
        role="status"
      >
        <Skeleton height={18} label="Endpoint identity loading" width="48%" />
        <Skeleton height={68} label="Endpoint URL loading" width="100%" />
        <InlineError error={loadError} />
        {loadError ? (
          <Button onClick={onRefreshEndpoints} size="small" variant="secondary">
            Refresh endpoints
          </Button>
        ) : null}
      </div>
    ) : (
      <Tabs
        ariaLabel="Webhook endpoint management"
        onValueChange={(value) => {
          if (!busy) onTabChange(value as WebhookEndpointDrawerTab);
        }}
        tabs={[
          { id: "settings", label: "Settings", content: endpointForm(false) },
          {
            id: "deliveries",
            label: "Deliveries",
            content: (
              <WebhookDeliveriesTab
                client={client}
                endpointId={currentEndpoint.endpointId}
                initialPage={initialDeliveryPage}
                onRefreshEndpoint={onRefreshEndpoints}
              />
            ),
          },
        ]}
        value={tab}
      />
    );

  return (
    <div
      aria-label={
        mode === "create" ? "New webhook endpoint" : "Manage webhook endpoint"
      }
      aria-hidden={suspended || undefined}
      aria-modal="true"
      className="drawer-overlay"
      inert={suspended || undefined}
      ref={dialogRef}
      role="dialog"
    >
      <button
        aria-label="Close webhook endpoint panel"
        className="drawer-overlay__backdrop"
        disabled={busy}
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <Panel
        className="webhook-endpoint-panel"
        description={
          mode === "create"
            ? "Choose the signed event stream sent to one HTTPS destination."
            : "Manage destination metadata and inspect delivery attempts without payload access."
        }
        drawer
        {...(busy
          ? {}
          : {
              onClose,
              onCloseLabel: "Close webhook endpoint panel",
            })}
        title={mode === "create" ? "New webhook endpoint" : "Webhook endpoint"}
      >
        {mode === "edit" && currentEndpoint ? (
          <InlineError error={loadError} />
        ) : null}
        {mode === "create" ? endpointForm(true) : editContent}
      </Panel>
    </div>
  );
}
