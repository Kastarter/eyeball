"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { CopyButton } from "@/src/components/ui/copy-button";
import { Icon } from "@/src/components/ui/icon";
import { Skeleton } from "@/src/components/ui/skeleton";
import {
  dashboardExecutorClient,
  type ExecutionRecord,
  ExecutorApiError,
} from "@/src/lib/api";

type ActivityState =
  | { kind: "loading" }
  | { kind: "empty"; updatedAt: Date }
  | { executions: readonly ExecutionRecord[]; kind: "ready"; updatedAt: Date }
  | { code: string; kind: "offline" | "unconfigured"; message: string };

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function latencyLabel(execution: ExecutionRecord): string {
  if (!("latencyMs" in execution)) return "—";
  return execution.latencyMs >= 1000
    ? `${(execution.latencyMs / 1000).toFixed(1)}s`
    : `${execution.latencyMs}ms`;
}

export function OverviewActivity({ project }: { project: string }) {
  const [state, setState] = useState<ActivityState>({ kind: "loading" });
  const [live, setLive] = useState(true);
  const [announceUpdates, setAnnounceUpdates] = useState(false);
  const mounted = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const page = await dashboardExecutorClient().listExecutions(
        { limit: 6 },
        signal,
      );
      if (signal?.aborted || !mounted.current) return;
      const updatedAt = new Date();
      setState(
        page.executions.length === 0
          ? { kind: "empty", updatedAt }
          : { executions: page.executions, kind: "ready", updatedAt },
      );
    } catch (caught) {
      if (signal?.aborted || !mounted.current) return;
      const error = caught instanceof ExecutorApiError ? caught : undefined;
      setState({
        code: error?.code ?? "executor_unavailable",
        kind: error?.status === 401 ? "unconfigured" : "offline",
        message:
          error?.status === 401
            ? "Set a server-only EYEBALL_API_KEY to load project executions."
            : (error?.message ??
              "The configured executor could not be reached. Catalog data remains available."),
      });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    const interval = live
      ? window.setInterval(() => void load(controller.signal), 8_000)
      : undefined;
    return () => {
      mounted.current = false;
      controller.abort();
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [live, load]);

  return (
    <section className="activity-panel" aria-labelledby="recent-activity-title">
      <header className="activity-panel__header">
        <div>
          <span className="activity-panel__live">
            <span
              className={`status-dot ${
                live
                  ? "status-dot--accent status-dot--pulse"
                  : "status-dot--neutral"
              }`}
            />
            {live ? "Live" : "Paused"}
          </span>
          <h2 id="recent-activity-title">Recent executions</h2>
          <p>
            The latest project-scoped invocation records from the configured
            executor.
          </p>
        </div>
        <div className="activity-panel__actions">
          <Button
            onClick={() => {
              if (!live) setAnnounceUpdates(true);
              setLive(!live);
            }}
            size="small"
            variant="ghost"
          >
            {live ? "Pause updates" : "Resume updates"}
          </Button>
          <Button
            icon={<Icon name="activity" />}
            onClick={() => void load()}
            size="small"
            variant="secondary"
          >
            Refresh
          </Button>
        </div>
      </header>

      <div
        aria-live={live && announceUpdates ? "polite" : "off"}
        className="activity-panel__body"
      >
        {state.kind === "loading" ? (
          <div
            aria-label="Recent executions loading"
            className="activity-skeleton"
            role="status"
          >
            {["one", "two", "three", "four"].map((row) => (
              <div className="activity-skeleton__row" key={row}>
                <Skeleton
                  height={13}
                  label="Execution time loading"
                  width={72}
                />
                <Skeleton
                  height={13}
                  label="Execution tool loading"
                  width="34%"
                />
                <Skeleton
                  height={13}
                  label="Execution latency loading"
                  width={58}
                />
                <Skeleton
                  height={24}
                  label="Execution status loading"
                  width={92}
                />
              </div>
            ))}
          </div>
        ) : null}

        {state.kind === "empty" ? (
          <div className="activity-empty">
            <Icon name="executions" />
            <div>
              <strong>No executions recorded yet</strong>
              <p>
                Run the quickstart below; the resulting execution will appear
                here.
              </p>
            </div>
          </div>
        ) : null}

        {state.kind === "offline" || state.kind === "unconfigured" ? (
          <div className="activity-empty activity-empty--error">
            <Icon name="activity" />
            <div>
              <span className="taxonomy-badge taxonomy-badge--error">
                {state.code}
              </span>
              <strong>
                {state.kind === "unconfigured"
                  ? "Authenticated activity is not configured"
                  : "Executor activity is offline"}
              </strong>
              <p>{state.message}</p>
            </div>
          </div>
        ) : null}

        {state.kind === "ready" ? (
          <div className="activity-list">
            {state.executions.map((execution) => (
              <div className="activity-row" key={execution.executionId}>
                <time className="mono" dateTime={execution.createdAt}>
                  {timeLabel(execution.createdAt)}
                </time>
                <Link
                  className="activity-row__tool mono"
                  href={`/${encodeURIComponent(project)}/executions?execution=${encodeURIComponent(
                    execution.executionId,
                  )}`}
                >
                  {execution.tool}
                </Link>
                <span className="activity-row__latency mono">
                  {latencyLabel(execution)}
                </span>
                <Badge status={execution.status} />
                <Link
                  className="activity-row__id mono"
                  href={`/${encodeURIComponent(project)}/executions?execution=${encodeURIComponent(
                    execution.executionId,
                  )}`}
                >
                  {execution.executionId}
                </Link>
                <CopyButton
                  className="activity-row__copy"
                  label="Copy execution ID"
                  value={execution.executionId}
                />
                <Link
                  aria-label={`Inspect ${execution.executionId}`}
                  className="activity-row__arrow"
                  href={`/${encodeURIComponent(project)}/executions?execution=${encodeURIComponent(
                    execution.executionId,
                  )}`}
                >
                  <Icon name="arrowRight" />
                </Link>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {"updatedAt" in state ? (
        <footer className="activity-panel__footer">
          Last event check {timeLabel(state.updatedAt.toISOString())}
        </footer>
      ) : null}
    </section>
  );
}
