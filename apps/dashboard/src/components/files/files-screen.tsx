"use client";

import Link from "next/link";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PageHeader } from "@/src/components/pages/page-header";
import { Button } from "@/src/components/ui/button";
import { CopyButton } from "@/src/components/ui/copy-button";
import { EmptyState } from "@/src/components/ui/empty-state";
import { Icon } from "@/src/components/ui/icon";
import { Skeleton } from "@/src/components/ui/skeleton";
import { TableShell } from "@/src/components/ui/table";
import {
  dashboardExecutorClient,
  ExecutorApiError,
  type StagedFileMetadata,
} from "@/src/lib/api";
import { cn } from "@/src/lib/cn";
import { isCloudMode } from "@/src/lib/runtime-config";

const PAGE_SIZE = 25;

const fileStageSnippet = `import { Eyeball } from "@eyeball/sdk";
import { readFile } from "node:fs/promises";

const eyeball = new Eyeball({
  apiKey: process.env.EYEBALL_API_KEY!,
  baseUrl: process.env.EYEBALL_EXECUTOR_URL!,
});

const staged = await eyeball.files.upload({
  name: "quarterly-report.pdf",
  mimeType: "application/pdf",
  content: await readFile("quarterly-report.pdf"),
});

// Reference staged.fileId in attachment-capable tool inputs before it expires.`;

export type FileExecutorState =
  | "loading"
  | "online"
  | "unconfigured"
  | "forbidden"
  | "offline"
  | "not_configured"
  | "error";

interface FileScreenError {
  code: string;
  message: string;
}

export function classifyFileExecutorFailure(caught: unknown): {
  error: FileScreenError;
  state: FileExecutorState;
} {
  const error = caught instanceof ExecutorApiError ? caught : undefined;
  const state: FileExecutorState =
    error?.status === 401
      ? "unconfigured"
      : error?.status === 403 && error.code === "auth_insufficient_scope"
        ? "forbidden"
        : error?.status === 502
          ? "offline"
          : error?.status === 503 && error.code === "executor_not_configured"
            ? "not_configured"
            : "error";
  return {
    state,
    error: {
      code: error?.code ?? "executor_unavailable",
      message:
        error?.message ??
        "Staged file metadata could not be refreshed from the executor.",
    },
  };
}

export function FileLoadBanner({
  cloud,
  error,
  onRetry,
  project,
  state,
}: {
  cloud: boolean;
  error?: FileScreenError | undefined;
  onRetry: () => void;
  project: string;
  state: Exclude<FileExecutorState, "loading" | "online">;
}) {
  const settingsHref = `/${encodeURIComponent(project)}/settings`;
  const presentation =
    state === "unconfigured"
      ? {
          title: "Executor credential required",
          description: cloud
            ? "Save the selected project's unpinned executor key in Settings, then retry. File administration never moves to the cloud control plane."
            : "Set a server-only EYEBALL_API_KEY for the dashboard process, then retry. Never expose it through a NEXT_PUBLIC variable.",
          warning: true,
        }
      : state === "forbidden"
        ? {
            title: "Unpinned project key required",
            description:
              "The project files list is project-authority only. Save an unpinned key for the selected project in Settings.",
            warning: true,
          }
        : state === "offline"
          ? {
              title: "Executor offline",
              description:
                "The dashboard could not reach the configured executor. Check the process and executor URL, then retry.",
              warning: false,
            }
          : state === "not_configured"
            ? {
                title: "Executor URL not configured",
                description:
                  "Configure the dashboard's server-side EYEBALL_EXECUTOR_URL with HTTPS or an explicit loopback URL, then retry.",
                warning: true,
              }
            : {
                title: "File refresh failed",
                description:
                  error?.message ??
                  "The executor returned an unexpected response. Existing file rows remain visible.",
                warning: false,
              };

  return (
    <div
      className={cn(
        "offline-banner",
        presentation.warning && "offline-banner--warning",
      )}
      role="status"
    >
      <Icon name="activity" />
      <div>
        <strong>{presentation.title}</strong>
        <p>{presentation.description}</p>
        {error && state === "error" ? (
          <small className="mono">{error.code}</small>
        ) : null}
      </div>
      {cloud && (state === "unconfigured" || state === "forbidden") ? (
        <Link
          className="button button--secondary button--small"
          href={settingsHref}
        >
          Open Settings
        </Link>
      ) : null}
      <Button onClick={onRetry} size="small" variant="secondary">
        Retry
      </Button>
    </div>
  );
}

export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return String(size);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function utcLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

export function encodeFileBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export interface FilesScreenProps {
  initialFiles?: readonly StagedFileMetadata[];
  initialNextCursor?: string;
  project: string;
}

export function FilesScreen({
  initialFiles,
  initialNextCursor,
  project,
}: FilesScreenProps) {
  const client = useMemo(() => dashboardExecutorClient(project), [project]);
  const [files, setFiles] = useState<readonly StagedFileMetadata[]>(
    initialFiles ?? [],
  );
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [executorState, setExecutorState] = useState<FileExecutorState>(
    initialFiles === undefined ? "loading" : "online",
  );
  const [loadError, setLoadError] = useState<FileScreenError>();
  const [uploadError, setUploadError] = useState<FileScreenError>();
  const [uploading, setUploading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const listRequestRef = useRef<AbortController | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cloud = isCloudMode();

  const loadFiles = useCallback(
    async (
      cursor: string | undefined,
      signal: AbortSignal,
      append: boolean,
    ) => {
      try {
        const page = await client.listStagedFiles(
          { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
          signal,
        );
        if (signal.aborted) return;
        setFiles((current) =>
          append
            ? [
                ...current.filter(
                  (file) =>
                    !page.files.some(
                      (candidate) => candidate.fileId === file.fileId,
                    ),
                ),
                ...page.files,
              ]
            : page.files,
        );
        setNextCursor(page.nextCursor);
        setExecutorState("online");
        setLoadError(undefined);
      } catch (caught) {
        if (signal.aborted) return;
        const classified = classifyFileExecutorFailure(caught);
        setExecutorState(classified.state);
        setLoadError(classified.error);
      }
    },
    [client],
  );

  const refreshFiles = useCallback(() => {
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    setExecutorState((current) => (current === "online" ? current : "loading"));
    void loadFiles(undefined, controller.signal, false);
  }, [loadFiles]);

  useEffect(() => {
    if (initialFiles !== undefined) return;
    const controller = new AbortController();
    listRequestRef.current = controller;
    void loadFiles(undefined, controller.signal, false);
    return () => controller.abort();
  }, [initialFiles, loadFiles]);

  useEffect(() => () => listRequestRef.current?.abort(), []);

  async function stageLocalFile(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (picked === undefined) return;
    setUploading(true);
    setUploadError(undefined);
    try {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      const staged = await client.uploadStagedFile({
        name: picked.name,
        ...(picked.type.length === 0 ? {} : { mimeType: picked.type }),
        content: encodeFileBytesToBase64(bytes),
      });
      setFiles((current) => [
        staged,
        ...current.filter((file) => file.fileId !== staged.fileId),
      ]);
      setExecutorState("online");
    } catch (caught) {
      const classified = classifyFileExecutorFailure(caught);
      setUploadError(classified.error);
    } finally {
      setUploading(false);
    }
  }

  async function loadMore() {
    if (nextCursor === undefined || loadingMore) return;
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    setLoadingMore(true);
    await loadFiles(nextCursor, controller.signal, true);
    if (!controller.signal.aborted) setLoadingMore(false);
  }

  const visibleFiles = files.filter((file) => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return (
      normalizedQuery.length === 0 ||
      [file.fileId, file.name, file.mimeType]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    );
  });
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="page-stack webhooks-page files-page">
      <PageHeader
        actions={
          <>
            <input
              accept="*/*"
              hidden
              onChange={(event) => void stageLocalFile(event)}
              ref={fileInputRef}
              type="file"
            />
            <Button
              disabled={uploading}
              icon={<Icon name="plus" />}
              onClick={() => fileInputRef.current?.click()}
              variant="primary"
            >
              {uploading ? "Staging…" : "Stage file"}
            </Button>
          </>
        }
        description="Stage attachment bytes for tool execution. Files are project-scoped bearer capabilities that expire on their TTL; adapters read bytes only through execution-bound resolution."
        eyebrow="Attachments"
        title="Files"
      />

      <section className="webhook-summary" aria-label="File summary">
        <div>
          <strong className="mono">{files.length}</strong>
          <span>loaded files</span>
        </div>
        <div>
          <strong className="mono">{formatFileSize(totalBytes)}</strong>
          <span>staged bytes</span>
        </div>
        <div className="webhook-summary__executor">
          <span
            className={cn(
              "status-dot",
              executorState === "online"
                ? "status-dot--success"
                : executorState === "loading"
                  ? "status-dot--accent status-dot--pulse"
                  : executorState === "unconfigured" ||
                      executorState === "forbidden" ||
                      executorState === "not_configured"
                    ? "status-dot--warning"
                    : "status-dot--error",
            )}
          />
          {executorState === "online"
            ? "Executor connected"
            : executorState === "loading"
              ? "Loading files"
              : "Executor attention required"}
        </div>
      </section>

      {executorState !== "loading" && executorState !== "online" ? (
        <FileLoadBanner
          cloud={cloud}
          error={loadError}
          onRetry={refreshFiles}
          project={project}
          state={executorState}
        />
      ) : null}
      {uploadError ? (
        <div className="inline-error" role="alert">
          <span className="taxonomy-badge taxonomy-badge--error">
            {uploadError.code}
          </span>
          <p>{uploadError.message}</p>
        </div>
      ) : null}

      {executorState === "loading" && files.length === 0 ? (
        <section className="webhooks-loading" aria-label="Files loading">
          <div className="webhooks-loading__filters">
            <Skeleton
              height={38}
              label="File search loading"
              width="min(100%, 420px)"
            />
          </div>
          {["one", "two", "three", "four"].map((row) => (
            <div className="webhooks-loading__row" key={row}>
              <Skeleton height={14} label="File name loading" width="34%" />
              <Skeleton height={14} label="File size loading" width={90} />
              <Skeleton height={14} label="File expiry loading" width="18%" />
            </div>
          ))}
        </section>
      ) : files.length === 0 && executorState === "online" ? (
        <EmptyState
          actions={
            <Button
              disabled={uploading}
              icon={<Icon name="plus" />}
              onClick={() => fileInputRef.current?.click()}
              variant="primary"
            >
              Stage a file
            </Button>
          }
          code={fileStageSnippet}
          description="Stage a file to reference it from attachment-capable tools before its TTL expires. List responses carry metadata only — bytes never leave execution-bound resolution."
          title="No staged files"
        />
      ) : files.length > 0 ? (
        <section className="webhooks-table-section">
          <div className="table-filters webhook-filters">
            <label className="table-filters__search">
              <span>Search</span>
              <span className="table-search-control">
                <Icon name="search" />
                <input
                  className="field__control"
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="file ID, name, MIME type"
                  type="search"
                  value={query}
                />
              </span>
            </label>
          </div>
          {visibleFiles.length > 0 ? (
            <TableShell
              caption="Project staged files"
              columns={[
                { key: "file", label: "File" },
                { key: "type", label: "MIME type" },
                { key: "size", label: "Size" },
                { key: "expires", label: "Expires (UTC)" },
              ]}
            >
              {visibleFiles.map((file) => (
                <tr key={file.fileId}>
                  <td>
                    <span className="webhook-endpoint-identity">
                      <span>
                        <strong>{file.name}</strong>
                      </span>
                      <span>
                        <code>{file.fileId}</code>
                        <CopyButton label="Copy file ID" value={file.fileId} />
                      </span>
                    </span>
                  </td>
                  <td className="mono">{file.mimeType}</td>
                  <td className="mono">{formatFileSize(file.size)}</td>
                  <td className="mono">{utcLabel(file.expiresAt)}</td>
                </tr>
              ))}
            </TableShell>
          ) : (
            <div className="filtered-empty">
              <Icon name="copy" />
              <h2>No staged files match this search</h2>
              <p>Change the search to restore the file list.</p>
              <Button onClick={() => setQuery("")} variant="secondary">
                Clear search
              </Button>
            </div>
          )}
          <footer className="webhook-pagination">
            <span>
              {files.length} {files.length === 1 ? "file" : "files"} loaded
              {nextCursor === undefined ? " · End of list" : ""}
            </span>
            {nextCursor ? (
              <Button
                disabled={loadingMore}
                onClick={() => void loadMore()}
                size="small"
                variant="secondary"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            ) : null}
          </footer>
        </section>
      ) : null}
    </div>
  );
}
