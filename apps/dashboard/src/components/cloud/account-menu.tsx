"use client";

import { useState } from "react";
import { Button } from "@/src/components/ui/button";
import { CloudApiError, dashboardCloudClient } from "@/src/lib/cloud-api";
import { EXECUTOR_KEY_SETTINGS_HEADER } from "@/src/lib/executor-key-shared";

function emailInitials(email: string): string {
  const name = email.split("@", 1)[0] ?? "";
  return (
    name
      .split(/[._-]+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "U"
  );
}

export function AccountMenu({
  email,
  projectIds,
}: {
  email: string;
  projectIds: readonly string[];
}) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string>();

  async function logout() {
    setLoggingOut(true);
    setError(undefined);
    try {
      for (const projectId of projectIds) {
        const response = await fetch("/api/dashboard/executor-key", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            [EXECUTOR_KEY_SETTINGS_HEADER]: "1",
          },
          body: JSON.stringify({ projectId }),
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error("Executor session cleanup failed.");
        }
      }
      await dashboardCloudClient().logout();
      window.location.assign("/login");
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError(apiError?.message ?? "Sign out could not be completed.");
      setLoggingOut(false);
    }
  }

  return (
    <details className="account-menu">
      <summary aria-label="Open account menu" className="avatar">
        {emailInitials(email)}
      </summary>
      <div className="account-menu__popover">
        <span>Signed in as</span>
        <strong>{email}</strong>
        {error ? <p role="alert">{error}</p> : null}
        <Button
          disabled={loggingOut}
          onClick={() => void logout()}
          size="small"
          variant="ghost"
        >
          {loggingOut ? "Signing out…" : "Sign out"}
        </Button>
      </div>
    </details>
  );
}
