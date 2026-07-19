"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useState } from "react";
import { ApertureLogo } from "@/src/components/shell/aperture-logo";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/form-controls";
import { CloudApiError, dashboardCloudClient } from "@/src/lib/cloud-api";

export type AuthScreenKind = "login" | "signup";

export function safeDashboardNextPath(value: string | undefined): string {
  if (
    value === undefined ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/";
  }
  return value;
}

export function AuthScreen({
  kind,
  nextPath = "/",
}: {
  kind: AuthScreenKind;
  nextPath?: string;
}) {
  const signup = kind === "signup";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ code: string; message: string }>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const client = dashboardCloudClient();
      if (signup) await client.signup({ email, password });
      else await client.login({ email, password });
      window.location.assign(safeDashboardNextPath(nextPath));
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message:
          apiError?.message ??
          "The cloud control plane could not be reached. Try again shortly.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-canvas">
      <section aria-labelledby="auth-title" className="auth-card">
        <div className="auth-brand">
          <ApertureLogo size={34} watching />
          <span>eyeball cloud</span>
        </div>
        <p className="eyebrow">{signup ? "Create account" : "Welcome back"}</p>
        <h1 id="auth-title">
          {signup
            ? "Start in the control plane."
            : "Sign in to your workspace."}
        </h1>
        <p className="auth-card__lede">
          {signup
            ? "Create a secure session, then bootstrap your organization and first project."
            : "Manage hosted connections, project keys, and audit history without exposing cloud credentials to the browser."}
        </p>
        <form className="auth-form" onSubmit={submit}>
          <Input
            autoComplete="email"
            label="Email"
            onChange={(event) => setEmail(event.currentTarget.value)}
            required
            type="email"
            value={email}
          />
          <Input
            autoComplete={signup ? "new-password" : "current-password"}
            {...(signup ? { hint: "Use at least 12 characters." } : {})}
            label="Password"
            minLength={12}
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
            type="password"
            value={password}
          />
          {error ? (
            <div className="inline-error" role="alert">
              <span className="taxonomy-badge taxonomy-badge--error">
                {error.code}
              </span>
              <p>{error.message}</p>
            </div>
          ) : null}
          <Button disabled={submitting} type="submit" variant="primary">
            {submitting
              ? signup
                ? "Creating account…"
                : "Signing in…"
              : signup
                ? "Create account"
                : "Sign in"}
          </Button>
        </form>
        <p className="auth-switch">
          {signup ? "Already have an account?" : "New to eyeball cloud?"}{" "}
          <Link href={signup ? "/login" : "/signup"}>
            {signup ? "Sign in" : "Create one"}
          </Link>
        </p>
      </section>
    </main>
  );
}
