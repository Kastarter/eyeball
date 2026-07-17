"use client";

import { useEffect, useState } from "react";
import { StatusDot } from "@/src/components/ui/status-dot";
import { configuredExecutorBaseUrl, ExecutorClient } from "@/src/lib/api";

type HealthState = "checking" | "online" | "offline";

export function ExecutorHealthCard() {
  const [health, setHealth] = useState<HealthState>("checking");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2500);
    const client = new ExecutorClient({ baseUrl: configuredExecutorBaseUrl() });

    client
      .health(controller.signal)
      .then(() => {
        if (active) setHealth("online");
      })
      .catch(() => {
        if (active) setHealth("offline");
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const presentation = {
    checking: {
      detail: "Checking the public /health route",
      label: "Checking",
      pulse: true,
      tone: "accent" as const,
    },
    online: {
      detail: "Executor wire API is responding",
      label: "Online",
      pulse: false,
      tone: "success" as const,
    },
    offline: {
      detail: "Catalog stays available while executor is offline",
      label: "Offline",
      pulse: false,
      tone: "error" as const,
    },
  }[health];

  return (
    <div className="metric-card" data-health={health}>
      <span className="metric-card__label">Executor health</span>
      <span className="metric-card__value metric-card__value--status">
        <StatusDot pulse={presentation.pulse} tone={presentation.tone} />
        {presentation.label}
      </span>
      <span className="metric-card__detail">{presentation.detail}</span>
    </div>
  );
}
