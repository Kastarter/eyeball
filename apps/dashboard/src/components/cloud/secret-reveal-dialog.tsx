"use client";

import { Button } from "@/src/components/ui/button";
import { CopyButton } from "@/src/components/ui/copy-button";
import { Icon } from "@/src/components/ui/icon";

export function SecretRevealDialog({
  onClose,
  secret,
  title = "Store this key now",
}: {
  onClose: () => void;
  secret: string;
  title?: string;
}) {
  return (
    <div
      aria-labelledby="secret-reveal-title"
      aria-modal="true"
      className="modal-overlay"
      role="dialog"
    >
      <div className="modal-overlay__backdrop" />
      <section className="secret-reveal surface surface--raised">
        <div className="secret-reveal__icon" aria-hidden="true">
          <Icon name="key" />
        </div>
        <p className="eyebrow">Reveal once</p>
        <h2 id="secret-reveal-title">{title}</h2>
        <p>
          This is the only time the full project key will be displayed. Copy it
          into your password manager or secrets store before continuing.
        </p>
        <div className="secret-value">
          <code>{secret}</code>
          <CopyButton label="Copy project API key" value={secret} />
        </div>
        <div className="secret-warning" role="status">
          <Icon name="activity" />
          <span>Store this now. Eyeball cannot recover the secret later.</span>
        </div>
        <Button onClick={onClose} variant="primary">
          I stored the key
        </Button>
      </section>
    </div>
  );
}
