"use client";

import { type FormEvent, useState } from "react";
import { PageHeader } from "@/src/components/pages/page-header";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/form-controls";
import { Icon } from "@/src/components/ui/icon";
import { EXECUTOR_KEY_SETTINGS_HEADER } from "@/src/lib/executor-key-shared";

export function ExecutorSettingsScreen({
  configured: initiallyConfigured,
  project,
}: {
  configured: boolean;
  project: string;
}) {
  const [configured, setConfigured] = useState(initiallyConfigured);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  }>();

  async function request(method: "DELETE" | "POST", value?: string) {
    const response = await fetch("/api/dashboard/executor-key", {
      method,
      headers: {
        "Content-Type": "application/json",
        [EXECUTOR_KEY_SETTINGS_HEADER]: "1",
      },
      body: JSON.stringify({
        projectId: project,
        ...(value === undefined ? {} : { key: value }),
      }),
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Executor key settings request failed.");
    return (await response.json()) as { configured: boolean };
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await request("POST", key);
      setConfigured(result.configured);
      setKey("");
      setMessage({
        kind: "success",
        text: "Executor key stored for this project in an HttpOnly browser-session cookie.",
      });
    } catch {
      setMessage({
        kind: "error",
        text: "The executor key could not be stored. Check the value and retry.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await request("DELETE");
      setConfigured(result.configured);
      setMessage({
        kind: "success",
        text: "The browser-session executor key was cleared for this project.",
      });
    } catch {
      setMessage({
        kind: "error",
        text: "The executor key could not be cleared.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack settings-page">
      <PageHeader
        description="Connect this dashboard session to the selected project's executor while keeping the key out of client-side JavaScript and public environment variables."
        eyebrow="Operator configuration"
        title="Settings"
      />

      <section className="settings-grid">
        <article className="settings-card surface surface--raised">
          <header>
            <span className="settings-card__icon" aria-hidden="true">
              <Icon name="key" />
            </span>
            <div>
              <p className="eyebrow">Selected project</p>
              <h2>Executor API key</h2>
            </div>
            <Badge status={configured ? "active" : "pending"} />
          </header>
          <p>
            Paste a project API key created on the API Keys screen. Eyeball uses
            it only from the server-side executor proxy for this project and
            this browser session. Toolkits, Executions, Overview activity, and
            Voice Agents continue to use your existing executor URL.
          </p>
          <form className="cloud-form" onSubmit={save}>
            <Input
              autoComplete="off"
              hint="The value is submitted once and never rendered back to the browser."
              label={configured ? "Replace executor key" : "Executor key"}
              mono
              onChange={(event) => setKey(event.currentTarget.value)}
              placeholder="eyb_live_…"
              required
              type="password"
              value={key}
            />
            {message ? (
              <p
                className={
                  message.kind === "error"
                    ? "settings-message settings-message--error"
                    : "settings-message settings-message--success"
                }
                role={message.kind === "error" ? "alert" : "status"}
              >
                {message.text}
              </p>
            ) : null}
            <div className="settings-card__actions">
              {configured ? (
                <Button
                  disabled={saving}
                  onClick={() => void clear()}
                  variant="danger"
                >
                  Clear session key
                </Button>
              ) : null}
              <Button
                disabled={saving || key.trim().length < 8}
                type="submit"
                variant="primary"
              >
                {saving ? "Saving…" : configured ? "Replace key" : "Save key"}
              </Button>
            </div>
          </form>
        </article>

        <aside className="operator-steps surface">
          <p className="eyebrow">Required operator step</p>
          <h2>Cloud does not inject executor credentials</h2>
          <ol>
            <li>Create a project key on the API Keys screen.</li>
            <li>Copy it during the reveal-once dialog.</li>
            <li>Paste it here for the selected project.</li>
            <li>
              Configure the dashboard server's existing executor URL as usual.
            </li>
          </ol>
          <p>
            This deliberate boundary keeps browser control-plane sessions
            separate from executor authentication and avoids automatic key
            provisioning.
          </p>
        </aside>
      </section>
    </div>
  );
}
