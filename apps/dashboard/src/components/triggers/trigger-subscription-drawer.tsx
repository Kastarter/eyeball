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
import { CopyButton } from "@/src/components/ui/copy-button";
import { Input } from "@/src/components/ui/form-controls";
import { Icon } from "@/src/components/ui/icon";
import { Panel } from "@/src/components/ui/panel";
import { Skeleton } from "@/src/components/ui/skeleton";
import {
  type CreatedTriggerSubscription,
  ExecutorApiError,
  type ExecutorClient,
  type RotatedTriggerIngestSecret,
  type TriggerSubscription,
  type WebhookEndpoint,
} from "@/src/lib/api";
import type { CatalogTriggerSubscriptionOption } from "@/src/lib/catalog";
import {
  confirmTriggerDeletion,
  confirmTriggerIngestRotation,
} from "./trigger-state";

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

export function subscriptionDeliveryMode(
  trigger: string,
  options: readonly CatalogTriggerSubscriptionOption[],
): "polling" | "push" | undefined {
  return options.find((option) => option.trigger === trigger)?.mode;
}

export function validateTriggerPollInterval(
  value: string,
  option: CatalogTriggerSubscriptionOption | undefined,
): string | undefined {
  if (option === undefined || option.mode !== "polling") return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    return "Enter a whole number of seconds.";
  }
  if (seconds < option.minimumIntervalSeconds) {
    return `The ${option.trigger} provider minimum is ${option.minimumIntervalSeconds} seconds.`;
  }
  return undefined;
}

export interface TriggerSubscriptionDrawerProps {
  catalogTriggerOptions: readonly CatalogTriggerSubscriptionOption[];
  client: ExecutorClient;
  mode: "create" | "manage";
  onClose: () => void;
  onCreated: (subscription: CreatedTriggerSubscription) => void;
  onDeleted: (subscriptionId: string) => void;
  onRefreshSubscriptions: () => void;
  onRotated: (rotation: RotatedTriggerIngestSecret) => void;
  subscription?: TriggerSubscription;
  subscriptionId?: string;
  suspended?: boolean;
}

export function TriggerSubscriptionDrawer({
  catalogTriggerOptions,
  client,
  mode,
  onClose,
  onCreated,
  onDeleted,
  onRefreshSubscriptions,
  onRotated,
  subscription,
  subscriptionId,
  suspended = false,
}: TriggerSubscriptionDrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [currentSubscription, setCurrentSubscription] = useState(subscription);
  const [trigger, setTrigger] = useState(
    catalogTriggerOptions[0]?.trigger ?? "",
  );
  const [userId, setUserId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [endpointIds, setEndpointIds] = useState<readonly string[]>([]);
  const [pollInterval, setPollInterval] = useState("");
  const [availableEndpoints, setAvailableEndpoints] =
    useState<readonly WebhookEndpoint[]>();
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loadError, setLoadError] = useState<InlineErrorValue>();
  const [endpointLoadError, setEndpointLoadError] =
    useState<InlineErrorValue>();
  const [createError, setCreateError] = useState<InlineErrorValue>();
  const [rotationError, setRotationError] = useState<InlineErrorValue>();
  const [deleteError, setDeleteError] = useState<InlineErrorValue>();
  const busy = submitting || rotating || deleting || suspended;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const selectedOption = catalogTriggerOptions.find(
    (option) => option.trigger === trigger,
  );

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    document.body.style.overflow = "hidden";
    dialogRef.current
      ?.querySelector<HTMLElement>(
        'select:not([disabled]), input:not([disabled]), button:not([disabled]):not([tabindex="-1"])',
      )
      ?.focus();

    function handleKeys(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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
    if (mode !== "create") return;
    const controller = new AbortController();
    setEndpointLoadError(undefined);
    void client
      .listWebhookEndpoints({ limit: 100 }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setAvailableEndpoints(page.webhooks);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setAvailableEndpoints([]);
        setEndpointLoadError(
          normalizedError(
            caught,
            "Webhook endpoints could not be loaded for delivery selection.",
          ),
        );
      });
    return () => controller.abort();
  }, [client, mode]);

  useEffect(() => {
    if (mode !== "manage" || subscriptionId === undefined) return;
    const controller = new AbortController();
    setLoadError(undefined);
    void client
      .getTriggerSubscription(subscriptionId, controller.signal)
      .then((fresh) => {
        if (controller.signal.aborted) return;
        setCurrentSubscription(fresh);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(
          normalizedError(
            caught,
            "Current subscription metadata could not be loaded.",
          ),
        );
      });
    return () => controller.abort();
  }, [client, mode, subscriptionId]);

  useEffect(() => {
    if (selectedOption?.mode === "polling") {
      setPollInterval(String(selectedOption.defaultIntervalSeconds));
    } else {
      setPollInterval("");
    }
  }, [selectedOption]);

  const triggerError =
    trigger.length === 0 ? "Choose a canonical trigger." : undefined;
  const userIdError =
    userId.trim().length === 0 ? "User ID is required." : undefined;
  const endpointError =
    endpointIds.length === 0
      ? "Select at least one webhook endpoint to receive events."
      : undefined;
  const pollIntervalError = validateTriggerPollInterval(
    pollInterval,
    selectedOption,
  );
  const valid =
    triggerError === undefined &&
    userIdError === undefined &&
    endpointError === undefined &&
    pollIntervalError === undefined;

  function toggleEndpoint(endpointId: string, checked: boolean) {
    setEndpointIds((current) =>
      checked
        ? [
            ...current.filter((candidate) => candidate !== endpointId),
            endpointId,
          ]
        : current.filter((candidate) => candidate !== endpointId),
    );
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    if (!valid) return;
    setSubmitting(true);
    setCreateError(undefined);
    try {
      const trimmedConnection = connectionId.trim();
      const created = await client.createTriggerSubscription({
        trigger,
        userId: userId.trim(),
        ...(trimmedConnection.length === 0
          ? {}
          : { connectionId: trimmedConnection }),
        webhookEndpointIds: endpointIds,
        ...(selectedOption?.mode === "polling"
          ? { pollIntervalSeconds: Number(pollInterval) }
          : {}),
      });
      onCreated(created);
    } catch (caught) {
      setCreateError(
        normalizedError(
          caught,
          "The trigger subscription could not be created.",
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function rotateIngestSecret() {
    if (
      currentSubscription === undefined ||
      !confirmTriggerIngestRotation(currentSubscription, window.confirm)
    ) {
      return;
    }
    setRotating(true);
    setRotationError(undefined);
    try {
      const rotation = await client.rotateTriggerIngestSecret(
        currentSubscription.subscriptionId,
      );
      setCurrentSubscription((current) =>
        current === undefined
          ? current
          : { ...current, updatedAt: rotation.rotatedAt },
      );
      onRotated(rotation);
    } catch (caught) {
      setRotationError(
        normalizedError(caught, "The push ingest URL could not be rotated."),
      );
    } finally {
      setRotating(false);
    }
  }

  async function deleteSubscription() {
    if (
      currentSubscription === undefined ||
      !confirmTriggerDeletion(currentSubscription, window.confirm)
    ) {
      return;
    }
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await client.deleteTriggerSubscription(
        currentSubscription.subscriptionId,
      );
      onDeleted(currentSubscription.subscriptionId);
    } catch (caught) {
      setDeleteError(
        normalizedError(
          caught,
          "The trigger subscription could not be deleted.",
        ),
      );
    } finally {
      setDeleting(false);
    }
  }

  function createForm(): ReactNode {
    return (
      <form className="trigger-subscription-form" onSubmit={create}>
        <label className="field">
          <span className="field__label">Canonical trigger</span>
          <select
            className="field__control"
            disabled={busy}
            onChange={(event) => setTrigger(event.currentTarget.value)}
            value={trigger}
          >
            {catalogTriggerOptions.map((option) => (
              <option key={option.trigger} value={option.trigger}>
                {option.trigger} · {option.mode === "push" ? "push" : "polling"}
              </option>
            ))}
          </select>
          {selectedOption ? (
            <small className="field__hint">{selectedOption.description}</small>
          ) : null}
          {attempted && triggerError !== undefined ? (
            <small className="field__error">{triggerError}</small>
          ) : null}
        </label>
        {selectedOption ? (
          <div className="trigger-mode-note" role="note">
            <Icon
              name={selectedOption.mode === "push" ? "webhook" : "activity"}
            />
            <span>
              {selectedOption.mode === "push"
                ? "Push trigger: the provider posts events to an unguessable ingest URL revealed once after creation."
                : `Polling trigger: the executor polls the provider on your interval (minimum ${selectedOption.minimumIntervalSeconds} seconds).`}
            </span>
          </div>
        ) : null}
        <Input
          disabled={busy}
          {...(attempted && userIdError !== undefined
            ? { error: userIdError }
            : {})}
          hint="End user whose connection authorizes the trigger."
          label="User ID"
          onChange={(event) => setUserId(event.currentTarget.value)}
          placeholder="demo_user"
          value={userId}
        />
        <Input
          disabled={busy}
          hint="Optional. Pins the subscription to one connection; the newest usable connection is selected otherwise."
          label="Connection ID"
          onChange={(event) => setConnectionId(event.currentTarget.value)}
          placeholder="conn_…"
          value={connectionId}
        />
        {selectedOption?.mode === "polling" ? (
          <Input
            disabled={busy}
            {...(attempted && pollIntervalError !== undefined
              ? { error: pollIntervalError }
              : {})}
            hint={`Provider default ${selectedOption.defaultIntervalSeconds}s, minimum ${selectedOption.minimumIntervalSeconds}s.`}
            label="Poll interval (seconds)"
            onChange={(event) => setPollInterval(event.currentTarget.value)}
            type="number"
            value={pollInterval}
          />
        ) : null}
        <fieldset className="trigger-endpoint-field">
          <legend>Deliver events to</legend>
          {availableEndpoints === undefined ? (
            <Skeleton
              height={40}
              label="Webhook endpoints loading"
              width="100%"
            />
          ) : availableEndpoints.length === 0 ? (
            <p className="trigger-endpoint-field__empty">
              No webhook endpoints exist yet. Create one on the Webhooks page
              first; trigger events deliver only through signed webhooks.
            </p>
          ) : (
            availableEndpoints.map((endpoint) => (
              <label
                className="trigger-endpoint-field__option"
                key={endpoint.endpointId}
              >
                <input
                  checked={endpointIds.includes(endpoint.endpointId)}
                  disabled={busy}
                  onChange={(event) =>
                    toggleEndpoint(
                      endpoint.endpointId,
                      event.currentTarget.checked,
                    )
                  }
                  type="checkbox"
                />
                <span>
                  <strong>{endpoint.url}</strong>
                  <code>{endpoint.endpointId}</code>
                </span>
              </label>
            ))
          )}
          <InlineError error={endpointLoadError} />
          {attempted && endpointError !== undefined ? (
            <small className="field__error">{endpointError}</small>
          ) : null}
        </fieldset>
        {selectedOption?.mode === "push" ? (
          <div className="webhook-secret-notice" role="note">
            <Icon name="key" />
            <span>
              The push ingest URL is shown once after creation. Store it before
              dismissing the dialog.
            </span>
          </div>
        ) : null}
        <InlineError error={createError} />
        <div className="webhook-form-actions">
          <Button disabled={busy} onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy || !valid} type="submit" variant="primary">
            {submitting ? "Creating…" : "Create subscription"}
          </Button>
        </div>
      </form>
    );
  }

  const manageMode = subscriptionDeliveryMode(
    currentSubscription?.trigger ?? "",
    catalogTriggerOptions,
  );

  const manageContent =
    currentSubscription === undefined ? (
      <div
        className="webhook-drawer-loading"
        aria-label="Trigger subscription loading"
        role="status"
      >
        <Skeleton
          height={18}
          label="Subscription identity loading"
          width="48%"
        />
        <Skeleton
          height={68}
          label="Subscription detail loading"
          width="100%"
        />
        <InlineError error={loadError} />
        {loadError ? (
          <Button
            onClick={onRefreshSubscriptions}
            size="small"
            variant="secondary"
          >
            Refresh subscriptions
          </Button>
        ) : null}
      </div>
    ) : (
      <div className="trigger-subscription-detail">
        <div className="webhook-drawer-identity">
          <span>
            <code>{currentSubscription.subscriptionId}</code>
            <Badge
              status={
                currentSubscription.status === "active" ? "active" : "inactive"
              }
            />
          </span>
          <span>
            Trigger <code>{currentSubscription.trigger}</code>
            {manageMode !== undefined ? (
              <code className="trigger-mode-chip">
                {manageMode === "push" ? "push" : "polling"}
              </code>
            ) : null}
          </span>
          <span>
            User <code>{currentSubscription.userId}</code>
            <CopyButton
              label="Copy user ID"
              value={currentSubscription.userId}
            />
          </span>
          {currentSubscription.connectionId !== undefined ? (
            <span>
              Connection <code>{currentSubscription.connectionId}</code>
            </span>
          ) : null}
          {currentSubscription.pollIntervalSeconds !== undefined ? (
            <span>
              Poll interval{" "}
              <code>{currentSubscription.pollIntervalSeconds}s</code>
            </span>
          ) : null}
          <small>
            Updated {currentSubscription.updatedAt} · Created{" "}
            {currentSubscription.createdAt}
          </small>
        </div>
        <section
          className="trigger-endpoint-summary"
          aria-label="Delivery endpoints"
        >
          <h3>Delivery endpoints</h3>
          {currentSubscription.webhookEndpointIds.length === 0 ? (
            <p>No webhook endpoints are attached to this subscription.</p>
          ) : (
            <ul>
              {currentSubscription.webhookEndpointIds.map((endpointId) => (
                <li key={endpointId}>
                  <code>{endpointId}</code>
                  <CopyButton label="Copy endpoint ID" value={endpointId} />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section
          className="webhook-danger-zone"
          aria-label="Destructive subscription actions"
        >
          {manageMode === "push" ? (
            <div>
              <h3>Push ingest URL</h3>
              <p>
                Rotation invalidates the old ingest URL immediately; update the
                provider with the replacement shown once.
              </p>
              <InlineError error={rotationError} />
              <Button
                disabled={busy}
                onClick={() => void rotateIngestSecret()}
                size="small"
                variant="secondary"
              >
                {rotating ? "Rotating…" : "Rotate ingest URL"}
              </Button>
            </div>
          ) : null}
          <div>
            <h3>Delete subscription</h3>
            <p>
              The provider stops delivering events for this subscription
              immediately.
            </p>
            <InlineError error={deleteError} />
            <Button
              disabled={busy}
              onClick={() => void deleteSubscription()}
              size="small"
              variant="danger"
            >
              {deleting ? "Deleting…" : "Delete subscription"}
            </Button>
          </div>
        </section>
      </div>
    );

  return (
    <div
      aria-label={
        mode === "create"
          ? "New trigger subscription"
          : "Manage trigger subscription"
      }
      aria-hidden={suspended || undefined}
      aria-modal="true"
      className="drawer-overlay"
      inert={suspended || undefined}
      ref={dialogRef}
      role="dialog"
    >
      <button
        aria-label="Close trigger subscription panel"
        className="drawer-overlay__backdrop"
        disabled={busy}
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <Panel
        className="webhook-endpoint-panel trigger-subscription-panel"
        description={
          mode === "create"
            ? "Subscribe one user's connection to a canonical provider trigger and choose the signed webhook endpoints that receive its events."
            : "Inspect subscription metadata, rotate the push ingest URL, or delete the subscription. Subscriptions are immutable; recreate to change targets."
        }
        drawer
        {...(busy
          ? {}
          : {
              onClose,
              onCloseLabel: "Close trigger subscription panel",
            })}
        title={
          mode === "create"
            ? "New trigger subscription"
            : "Trigger subscription"
        }
      >
        {mode === "manage" && currentSubscription ? (
          <InlineError error={loadError} />
        ) : null}
        {mode === "create" ? createForm() : manageContent}
      </Panel>
    </div>
  );
}
