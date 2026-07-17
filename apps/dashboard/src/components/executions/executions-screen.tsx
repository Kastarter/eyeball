"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PageHeader } from "@/src/components/pages/page-header";
import {
  Badge,
  Button,
  CodeBlock,
  CopyButton,
  EmptyState,
  Icon,
  Input,
  Panel,
  Select,
  TableShell,
} from "@/src/components/ui";
import {
  dashboardExecutorClient,
  type ExecutionDetail,
  type ExecutionRecord,
  type ExecutionStatus,
  ExecutorApiError,
} from "@/src/lib/api";

const PAGE_SIZE = 30;
const LIVE_REFRESH_MS = 4_000;
const EXECUTION_COLUMNS = [
  { key: "status", label: "Status" },
  { key: "tool", label: "Tool" },
  { key: "user", label: "User ID" },
  { key: "latency", label: "Latency" },
  { key: "time", label: "When" },
  { key: "id", label: "Execution ID" },
] as const;

export interface ExecutionFilters {
  status?: ExecutionStatus;
  tool?: string;
  userId?: string;
}

export interface ExecutionsScreenProps {
  initialExecution?: string;
  initialExecutionDetail?: ExecutionDetail;
  initialExecutions?: readonly ExecutionRecord[];
  initialFilters?: ExecutionFilters;
  initialNextCursor?: string;
  project: string;
}

type RequestState = "error" | "loading" | "offline" | "ready" | "unconfigured";

function errorState(
  error: unknown,
): Exclude<RequestState, "loading" | "ready"> {
  if (error instanceof ExecutorApiError && error.status === 401) {
    return "unconfigured";
  }
  if (!(error instanceof ExecutorApiError) || error.status === 502) {
    return "offline";
  }
  return "error";
}

function relativeTime(createdAt: string): string {
  const delta = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(delta)) return "Unknown";
  const seconds = Math.max(0, Math.round(delta / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatTimestamp(value: string | undefined): string {
  if (value === undefined) return "Waiting";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function executionCurl(detail: ExecutionDetail): string {
  const continued = " \\";
  const body = {
    tool: detail.tool,
    userId: detail.userId,
    input: detail.input,
    mode: detail.mode,
    ...(detail.connectionId === undefined
      ? {}
      : { connectionId: detail.connectionId }),
  };
  return [
    `curl -X POST ${shellQuote("https://api.eyeball.dev/v1/execute")}${continued}`,
    `  -H ${shellQuote("Authorization: Bearer <REDACTED>")}${continued}`,
    `  -H ${shellQuote("Content-Type: application/json")}${continued}`,
    ...(detail.idempotencyKey === undefined
      ? []
      : [
          `  -H ${shellQuote(`Idempotency-Key: ${detail.idempotencyKey}`)}${continued}`,
        ]),
    `  --data ${shellQuote(JSON.stringify(body))}`,
  ].join("\n");
}

function urlWithState(filters: ExecutionFilters, executionId?: string): string {
  const url = new URL(window.location.href);
  for (const key of ["status", "tool", "userId", "execution"] as const) {
    url.searchParams.delete(key);
  }
  if (filters.status !== undefined)
    url.searchParams.set("status", filters.status);
  if (filters.tool !== undefined) url.searchParams.set("tool", filters.tool);
  if (filters.userId !== undefined)
    url.searchParams.set("userId", filters.userId);
  if (executionId !== undefined) url.searchParams.set("execution", executionId);
  return `${url.pathname}${url.search}${url.hash}`;
}

function statusMessage(state: RequestState): { title: string; body: string } {
  if (state === "unconfigured") {
    return {
      title: "Executor authentication is not configured",
      body: "Add EYEBALL_API_KEY to the dashboard server environment. The key stays behind the server proxy.",
    };
  }
  if (state === "offline") {
    return {
      title: "Executor is offline",
      body: "The execution log remains paused until the configured executor is reachable.",
    };
  }
  return {
    title: "Execution log could not be loaded",
    body: "The executor returned an unexpected response. Retry without changing your filters.",
  };
}

function ExecutionTimeline({ detail }: { detail: ExecutionDetail }) {
  const terminal = detail.status === "succeeded" || detail.status === "failed";
  const steps = [
    { label: "Created", timestamp: detail.createdAt, reached: true },
    {
      label: "Running",
      timestamp: detail.startedAt,
      reached: detail.startedAt !== undefined,
    },
    {
      label: terminal
        ? detail.status === "succeeded"
          ? "Succeeded"
          : "Failed"
        : "Terminal",
      timestamp: detail.completedAt,
      reached: terminal,
    },
  ];
  return (
    <ol aria-label="Execution status timeline" className="execution-timeline">
      {steps.map((step) => (
        <li
          className={step.reached ? "is-reached" : undefined}
          key={step.label}
        >
          <span aria-hidden="true" />
          <div>
            <strong>{step.label}</strong>
            <time dateTime={step.timestamp}>
              {formatTimestamp(step.timestamp)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ExecutionDrawer({
  detail,
  executionId,
  onClose,
  state,
}: {
  detail: ExecutionDetail | undefined;
  executionId: string;
  onClose: () => void;
  state: RequestState;
}) {
  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = drawerRef.current;
    node?.querySelector<HTMLButtonElement>(".panel__header button")?.focus();
    function keydown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || node === null) return;
      const focusable = [
        ...node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [onClose]);

  const message = statusMessage(state);
  return (
    <div className="drawer-overlay" ref={drawerRef} role="presentation">
      <button
        aria-label="Close execution detail"
        className="drawer-overlay__backdrop"
        onClick={onClose}
        type="button"
      />
      <Panel
        className="execution-panel"
        description={executionId}
        drawer
        onClose={onClose}
        onCloseLabel="Close execution detail"
        title="Execution detail"
      >
        {state === "loading" ? (
          <div aria-live="polite" className="execution-detail-state">
            <Icon name="activity" />
            <p>Loading the canonical request and terminal envelope…</p>
          </div>
        ) : detail === undefined ? (
          <div className="execution-detail-state execution-detail-state--error">
            <Icon name="activity" />
            <strong>{message.title}</strong>
            <p>{message.body}</p>
          </div>
        ) : (
          <div className="execution-detail">
            <div className="execution-detail__status">
              <Badge status={detail.status} />
              <span className="mono">
                {"latencyMs" in detail ? `${detail.latencyMs} ms` : "—"}
              </span>
            </div>
            <ExecutionTimeline detail={detail} />

            <section className="execution-detail__section">
              <div className="execution-detail__heading">
                <div>
                  <p className="eyebrow">Canonical request</p>
                  <h3>Input</h3>
                </div>
              </div>
              <CodeBlock
                code={json(detail.input)}
                label="Canonical input JSON"
                language="json"
              />
            </section>

            <section className="execution-detail__section">
              <div className="execution-detail__heading">
                <div>
                  <p className="eyebrow">Terminal envelope</p>
                  <h3>{detail.status === "failed" ? "Error" : "Response"}</h3>
                </div>
                {detail.status === "failed" ? (
                  <span className="taxonomy-badge taxonomy-badge--error">
                    {detail.error.code}
                  </span>
                ) : null}
              </div>
              {detail.status === "failed" ? (
                <div className="execution-error-envelope">
                  <p>{detail.error.message}</p>
                  <dl>
                    <div>
                      <dt>Retryable</dt>
                      <dd>{detail.error.retryable ? "yes" : "no"}</dd>
                    </div>
                    {detail.error.retryAfterSeconds === undefined ? null : (
                      <div>
                        <dt>Retry after</dt>
                        <dd>{detail.error.retryAfterSeconds}s</dd>
                      </div>
                    )}
                  </dl>
                  {detail.error.provider === undefined ? null : (
                    <details>
                      <summary>Provider detail</summary>
                      <CodeBlock
                        code={json(detail.error.provider)}
                        label="Provider error detail"
                        language="json"
                      />
                    </details>
                  )}
                </div>
              ) : detail.status === "succeeded" ? (
                <CodeBlock
                  code={json(detail.output)}
                  label="Execution output JSON"
                  language="json"
                />
              ) : (
                <p className="execution-detail__pending">
                  This execution has not produced a terminal envelope yet.
                </p>
              )}
            </section>

            <section className="execution-detail__section">
              <div className="execution-detail__heading">
                <div>
                  <p className="eyebrow">Pinned context</p>
                  <h3>Metadata</h3>
                </div>
              </div>
              <dl className="execution-metadata">
                {[
                  ["Project", detail.projectId],
                  ["User", detail.userId],
                  ["Connection", detail.connectionId ?? "default"],
                  ["Tool version", detail.toolVersion],
                  ["Catalog version", detail.catalogVersion],
                  ["Mode", detail.mode],
                  ["Idempotency key", detail.idempotencyKey ?? "—"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd className="mono">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="execution-detail__section">
              <div className="execution-detail__heading">
                <div>
                  <p className="eyebrow">Replay safely</p>
                  <h3>Copy as curl</h3>
                </div>
              </div>
              <CodeBlock
                code={executionCurl(detail)}
                label="Reconstructed execute request"
                language="shell"
              />
            </section>
          </div>
        )}
      </Panel>
    </div>
  );
}

export function ExecutionsScreen({
  initialExecution,
  initialExecutionDetail,
  initialExecutions,
  initialFilters = {},
  initialNextCursor,
  project,
}: ExecutionsScreenProps) {
  const [filters, setFilters] = useState<ExecutionFilters>(initialFilters);
  const [records, setRecords] = useState<readonly ExecutionRecord[]>(
    initialExecutions ?? [],
  );
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [requestState, setRequestState] = useState<RequestState>(
    initialExecutions === undefined ? "loading" : "ready",
  );
  const [requestMessage, setRequestMessage] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [live, setLive] = useState(false);
  const [selectedId, setSelectedId] = useState(initialExecution);
  const [detail, setDetail] = useState<ExecutionDetail | undefined>(
    initialExecutionDetail,
  );
  const [detailState, setDetailState] = useState<RequestState>(
    initialExecution === undefined || initialExecutionDetail !== undefined
      ? "ready"
      : "loading",
  );

  const refresh = useCallback(
    async (signal?: AbortSignal, silent = false) => {
      if (!silent) setRequestState("loading");
      try {
        const page = await dashboardExecutorClient().listExecutions(
          { ...filters, limit: PAGE_SIZE },
          signal,
        );
        setRecords(page.executions);
        setNextCursor(page.nextCursor);
        setRequestState("ready");
        setRequestMessage(undefined);
      } catch (error) {
        if (signal?.aborted) return;
        setRequestState(errorState(error));
        setRequestMessage(error instanceof Error ? error.message : undefined);
      }
    },
    [filters],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    window.history.replaceState(null, "", urlWithState(filters, selectedId));
    return () => controller.abort();
  }, [filters, refresh, selectedId]);

  useEffect(() => {
    if (!live) return;
    const interval = window.setInterval(
      () => void refresh(undefined, true),
      LIVE_REFRESH_MS,
    );
    return () => window.clearInterval(interval);
  }, [live, refresh]);

  useEffect(() => {
    function popstate() {
      const query = new URL(window.location.href).searchParams;
      const status = query.get("status");
      const tool = query.get("tool");
      const userId = query.get("userId");
      setFilters({
        ...(status === "pending" ||
        status === "running" ||
        status === "succeeded" ||
        status === "failed"
          ? { status }
          : {}),
        ...(tool === null ? {} : { tool }),
        ...(userId === null ? {} : { userId }),
      });
      setSelectedId(query.get("execution") ?? undefined);
    }
    window.addEventListener("popstate", popstate);
    return () => window.removeEventListener("popstate", popstate);
  }, []);

  useEffect(() => {
    if (selectedId === undefined) {
      setDetail(undefined);
      setDetailState("ready");
      return;
    }
    if (detail?.executionId === selectedId) return;
    const controller = new AbortController();
    setDetail(undefined);
    setDetailState("loading");
    void dashboardExecutorClient()
      .getExecution(selectedId, controller.signal)
      .then((value) => {
        setDetail(value);
        setDetailState("ready");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setDetailState(errorState(error));
      });
    return () => controller.abort();
  }, [detail?.executionId, selectedId]);

  async function loadMore() {
    if (nextCursor === undefined) return;
    setLoadingMore(true);
    try {
      const page = await dashboardExecutorClient().listExecutions({
        ...filters,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      setRecords((current) => {
        const ids = new Set(current.map(({ executionId }) => executionId));
        return [
          ...current,
          ...page.executions.filter(({ executionId }) => !ids.has(executionId)),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      setRequestState(errorState(error));
      setRequestMessage(error instanceof Error ? error.message : undefined);
    } finally {
      setLoadingMore(false);
    }
  }

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const status = String(form.get("status") ?? "");
    const tool = String(form.get("tool") ?? "").trim();
    const userId = String(form.get("userId") ?? "").trim();
    setFilters({
      ...(status === "" ? {} : { status: status as ExecutionStatus }),
      ...(tool === "" ? {} : { tool }),
      ...(userId === "" ? {} : { userId }),
    });
  }

  function openDetail(executionId: string) {
    setSelectedId(executionId);
    window.history.pushState(null, "", urlWithState(filters, executionId));
  }

  const closeDetail = useCallback(() => {
    setSelectedId(undefined);
    window.history.pushState(null, "", urlWithState(filters));
  }, [filters]);

  function rowKeydown(
    event: KeyboardEvent<HTMLTableRowElement>,
    executionId: string,
  ) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetail(executionId);
    }
  }

  const filterCount = useMemo(
    () => [filters.status, filters.tool, filters.userId].filter(Boolean).length,
    [filters],
  );
  const message = statusMessage(requestState);

  return (
    <main className="page-stack executions-page">
      <PageHeader
        actions={
          <div className="execution-live-actions">
            <button
              aria-pressed={live}
              className="live-toggle"
              onClick={() => setLive((value) => !value)}
              type="button"
            >
              <span
                aria-hidden="true"
                className={live ? "is-live" : undefined}
              />
              Live refresh {live ? "on" : "paused"}
            </button>
            <Button
              onClick={() => void refresh()}
              size="small"
              variant="secondary"
            >
              Refresh
            </Button>
          </div>
        }
        description="Inspect canonical requests, normalized responses, latency, and provider failures without leaving the project boundary."
        eyebrow={`Project / ${project}`}
        title="Executions"
      />

      <section className="executions-table-section">
        <form
          className="execution-filters"
          key={`${filters.status ?? ""}:${filters.tool ?? ""}:${filters.userId ?? ""}`}
          onSubmit={submitFilters}
        >
          <Select
            defaultValue={filters.status ?? ""}
            label="Status"
            name="status"
            options={[
              { label: "All statuses", value: "" },
              { label: "Pending", value: "pending" },
              { label: "Running", value: "running" },
              { label: "Succeeded", value: "succeeded" },
              { label: "Failed", value: "failed" },
            ]}
          />
          <Input
            defaultValue={filters.tool ?? ""}
            label="Tool"
            mono
            name="tool"
            placeholder="gmail.send_email"
          />
          <Input
            defaultValue={filters.userId ?? ""}
            label="User ID"
            mono
            name="userId"
            placeholder="user_123"
          />
          <Button size="small" type="submit" variant="primary">
            Apply filters
          </Button>
          {filterCount > 0 ? (
            <Button
              onClick={() => setFilters({})}
              size="small"
              type="button"
              variant="ghost"
            >
              Clear {filterCount}
            </Button>
          ) : null}
        </form>

        {requestState !== "ready" && requestState !== "loading" ? (
          <div
            className={
              requestState === "unconfigured"
                ? "offline-banner offline-banner--warning"
                : "offline-banner"
            }
          >
            <Icon name="activity" />
            <div>
              <strong>{message.title}</strong>
              <p>{requestMessage ?? message.body}</p>
            </div>
            <Button
              onClick={() => void refresh()}
              size="small"
              variant="secondary"
            >
              Retry
            </Button>
          </div>
        ) : null}

        {requestState === "loading" && records.length === 0 ? (
          <div aria-live="polite" className="executions-loading">
            <Icon name="activity" />
            Loading execution records…
          </div>
        ) : records.length === 0 && requestState === "ready" ? (
          filterCount > 0 ? (
            <div className="filtered-empty">
              <Icon name="search" />
              <h2>No executions match</h2>
              <p>
                Clear a filter or broaden the canonical tool and user ID values.
              </p>
              <Button
                onClick={() => setFilters({})}
                size="small"
                variant="secondary"
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <EmptyState
              code={`await eyeball.tools.execute("gmail.send_email", {\n  input: { to: ["sam@example.com"], subject: "Hello", body: "Hi" }\n});`}
              description="Every synchronous and asynchronous tool call will appear here with its canonical request and normalized terminal envelope."
              title="No executions yet"
            />
          )
        ) : (
          <>
            <TableShell
              caption="Project execution log"
              columns={EXECUTION_COLUMNS}
            >
              {records.map((record) => (
                <tr
                  aria-label={`Open execution ${record.executionId}`}
                  className="execution-row"
                  key={record.executionId}
                  onClick={(event) => {
                    if (
                      event.target instanceof HTMLElement &&
                      event.target.closest("button") !== null
                    ) {
                      return;
                    }
                    openDetail(record.executionId);
                  }}
                  onKeyDown={(event) => rowKeydown(event, record.executionId)}
                  tabIndex={0}
                >
                  <td>
                    <Badge status={record.status} />
                  </td>
                  <td>
                    <code className="execution-tool">{record.tool}</code>
                  </td>
                  <td>
                    <code>{record.userId}</code>
                  </td>
                  <td className="mono">
                    {"latencyMs" in record ? `${record.latencyMs} ms` : "—"}
                  </td>
                  <td>
                    <time dateTime={record.createdAt} suppressHydrationWarning>
                      {relativeTime(record.createdAt)}
                    </time>
                  </td>
                  <td>
                    <span className="execution-id">
                      <code>{record.executionId}</code>
                      <span>
                        <CopyButton
                          label="Copy execution ID"
                          value={record.executionId}
                        />
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </TableShell>
            <div className="executions-footer">
              <span>
                {records.length} execution{records.length === 1 ? "" : "s"}{" "}
                loaded
              </span>
              {nextCursor === undefined ? (
                <span>End of log</span>
              ) : (
                <Button
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  size="small"
                  variant="secondary"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              )}
            </div>
          </>
        )}
      </section>

      {selectedId === undefined ? null : (
        <ExecutionDrawer
          detail={detail}
          executionId={selectedId}
          onClose={closeDetail}
          state={detailState}
        />
      )}
    </main>
  );
}
