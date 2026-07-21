"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "./button";
import { CopyButton } from "./copy-button";
import { Icon } from "./icon";

export interface SecretRevealDialogProps {
  acknowledgementLabel?: string;
  copyLabel?: string;
  description?: string;
  onClose: () => void;
  secret: string;
  title?: string;
  warning?: string;
}

export function SecretRevealDialog({
  acknowledgementLabel = "I stored the key",
  copyLabel = "Copy project API key",
  description = "This is the only time the full project key will be displayed. Copy it into your password manager or secrets store before continuing.",
  onClose,
  secret,
  title = "Store this key now",
  warning = "Store this now. Eyeball cannot recover the secret later.",
}: SecretRevealDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const generatedId = useId().replaceAll(":", "");
  const titleId = `${generatedId}-secret-title`;
  const descriptionId = `${generatedId}-secret-description`;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    document.body.style.overflow = "hidden";
    dialogRef.current
      ?.querySelector<HTMLElement>('button:not([disabled]), [tabindex="0"]')
      ?.focus();

    function trapFocus(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

    window.addEventListener("keydown", trapFocus);
    return () => {
      window.removeEventListener("keydown", trapFocus);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="modal-overlay"
      ref={dialogRef}
      role="dialog"
    >
      <div className="modal-overlay__backdrop" />
      <section className="secret-reveal surface surface--raised">
        <div className="secret-reveal__icon" aria-hidden="true">
          <Icon name="key" />
        </div>
        <p className="eyebrow">Reveal once</p>
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        <div className="secret-value">
          <code>{secret}</code>
          <CopyButton label={copyLabel} value={secret} />
        </div>
        <div className="secret-warning" role="status">
          <Icon name="activity" />
          <span>{warning}</span>
        </div>
        <Button onClick={onClose} variant="primary">
          {acknowledgementLabel}
        </Button>
      </section>
    </div>
  );
}
