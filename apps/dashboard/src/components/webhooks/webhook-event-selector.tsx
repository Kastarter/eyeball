"use client";

import { useId, useMemo, useState } from "react";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import type { WebhookSubscriptionEventType } from "@/src/lib/api";
import type { CatalogWebhookTriggerOption } from "@/src/lib/catalog";

const exactTriggerPattern =
  /^trigger\.[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

interface EventChoice {
  description: string;
  label: string;
  value: WebhookSubscriptionEventType;
}

const executionChoices: readonly EventChoice[] = [
  {
    value: "execution.completed",
    label: "Any completed execution",
    description:
      "Convenience selector for succeeded, failed, and cancelled executions.",
  },
  {
    value: "execution.succeeded",
    label: "Succeeded execution",
    description: "Only terminal executions that completed successfully.",
  },
  {
    value: "execution.failed",
    label: "Failed execution",
    description: "Only terminal executions that completed with an error.",
  },
  {
    value: "execution.cancelled",
    label: "Cancelled execution",
    description:
      "Only executions cancelled before or after dispatch may have begun.",
  },
];

const voiceChoices: readonly EventChoice[] = [
  {
    value: "voice.session.event",
    label: "Voice session event",
    description: "Ordered session lifecycle and conversation events.",
  },
  {
    value: "voice.transcript.ready",
    label: "Voice transcript ready",
    description: "The durable final transcript is ready for downstream use.",
  },
  {
    value: "voice.observer.failed",
    label: "Voice observer failed",
    description: "The executor exhausted or rejected observer processing.",
  },
];

const fixedEventOrder = [
  ...executionChoices.map((choice) => choice.value),
  ...voiceChoices.map((choice) => choice.value),
  "trigger.*",
] as const;

export function sortWebhookEvents(
  events: Iterable<WebhookSubscriptionEventType>,
): readonly WebhookSubscriptionEventType[] {
  const order = new Map(fixedEventOrder.map((event, index) => [event, index]));
  return [...new Set(events)].sort((left, right) => {
    const leftOrder = order.get(left);
    const rightOrder = order.get(right);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      return (
        (leftOrder ?? Number.MAX_SAFE_INTEGER) -
        (rightOrder ?? Number.MAX_SAFE_INTEGER)
      );
    }
    return left.localeCompare(right);
  });
}

export function validateExactWebhookTrigger(value: string): string | undefined {
  if (value.length > 71) {
    return "Exact trigger selectors must be 71 characters or fewer.";
  }
  if (!exactTriggerPattern.test(value)) {
    return "Use trigger.<toolkit>.<name> with lowercase letters, digits, hyphens, and underscores.";
  }
  return undefined;
}

export interface WebhookEventSelectorProps {
  catalogTriggerOptions: readonly CatalogWebhookTriggerOption[];
  disabled?: boolean;
  error?: string | undefined;
  onChange: (events: readonly WebhookSubscriptionEventType[]) => void;
  value: readonly WebhookSubscriptionEventType[];
}

export function WebhookEventSelector({
  catalogTriggerOptions,
  disabled = false,
  error,
  onChange,
  value,
}: WebhookEventSelectorProps) {
  const generatedId = useId().replaceAll(":", "");
  const messageId = `${generatedId}-events-message`;
  const addErrorId = `${generatedId}-exact-error`;
  const [exactTrigger, setExactTrigger] = useState("");
  const [addError, setAddError] = useState<string>();
  const selected = useMemo(() => new Set(value), [value]);
  const catalogValues = useMemo(
    () => new Set(catalogTriggerOptions.map((option) => option.value)),
    [catalogTriggerOptions],
  );
  const customValues = sortWebhookEvents(
    value.filter(
      (event) =>
        event !== "trigger.*" &&
        event.startsWith("trigger.") &&
        !catalogValues.has(event as `trigger.${string}`),
    ),
  );

  function toggle(event: WebhookSubscriptionEventType, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(event);
    else next.delete(event);
    onChange(sortWebhookEvents(next));
  }

  function addExactTrigger() {
    const candidate = exactTrigger.trim();
    const validation = validateExactWebhookTrigger(candidate);
    if (validation !== undefined) {
      setAddError(validation);
      return;
    }
    setAddError(undefined);
    onChange(
      sortWebhookEvents([
        ...selected,
        candidate as WebhookSubscriptionEventType,
      ]),
    );
    setExactTrigger("");
  }

  function renderChoice(choice: EventChoice) {
    const id = `${generatedId}-${choice.value.replaceAll(".", "-").replaceAll("*", "all")}`;
    return (
      <label className="webhook-event-choice" htmlFor={id} key={choice.value}>
        <input
          checked={selected.has(choice.value)}
          id={id}
          onChange={(event) =>
            toggle(choice.value, event.currentTarget.checked)
          }
          type="checkbox"
        />
        <span>
          <strong>{choice.label}</strong>
          <code>{choice.value}</code>
          <small>{choice.description}</small>
        </span>
      </label>
    );
  }

  return (
    <fieldset
      aria-describedby={messageId}
      aria-invalid={Boolean(error)}
      className="webhook-event-selector"
      disabled={disabled}
    >
      <legend>Event subscriptions</legend>
      <p id={messageId} className={error ? "webhook-validation" : undefined}>
        {error ??
          "Choose at least one event. Duplicate selectors are removed automatically."}
      </p>
      <section className="webhook-event-group">
        <h3>Execution</h3>
        <div className="webhook-event-grid">
          {executionChoices.map(renderChoice)}
        </div>
      </section>
      <section className="webhook-event-group">
        <h3>Voice</h3>
        <div className="webhook-event-grid">
          {voiceChoices.map(renderChoice)}
        </div>
      </section>
      <section className="webhook-event-group">
        <h3>Triggers</h3>
        <div className="webhook-event-grid">
          {renderChoice({
            value: "trigger.*",
            label: "All catalog triggers",
            description:
              "Wildcard selector for every current and future trigger event.",
          })}
          {catalogTriggerOptions.map((option) =>
            renderChoice({
              value: option.value as WebhookSubscriptionEventType,
              label: option.label,
              description: option.description,
            }),
          )}
        </div>
        <div className="webhook-custom-trigger">
          <label htmlFor={`${generatedId}-exact-trigger`}>
            <span>Add exact trigger</span>
            <input
              aria-describedby={addError === undefined ? undefined : addErrorId}
              aria-invalid={Boolean(addError)}
              className="field__control mono"
              id={`${generatedId}-exact-trigger`}
              maxLength={71}
              onChange={(event) => {
                setExactTrigger(event.currentTarget.value);
                setAddError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addExactTrigger();
              }}
              placeholder="trigger.toolkit.event_name"
              type="text"
              value={exactTrigger}
            />
          </label>
          <Button
            disabled={exactTrigger.trim().length === 0}
            onClick={addExactTrigger}
            size="small"
            variant="secondary"
          >
            Add
          </Button>
        </div>
        {addError ? (
          <p className="webhook-validation" id={addErrorId} role="alert">
            {addError}
          </p>
        ) : null}
        {customValues.length > 0 ? (
          <ul
            className="webhook-custom-trigger-list"
            aria-label="Custom exact triggers"
          >
            {customValues.map((event) => (
              <li className="webhook-custom-trigger-chip" key={event}>
                <code>{event}</code>
                <button
                  aria-label={`Remove ${event}`}
                  onClick={() => toggle(event, false)}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="webhook-event-selector__note">
          Custom selectors are accepted by syntax only; catalog descriptions are
          shown only for known triggers.
        </p>
      </section>
    </fieldset>
  );
}
