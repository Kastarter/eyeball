"use client";

import {
  type FormEvent,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PageHeader } from "@/src/components/pages/page-header";
import { Button } from "@/src/components/ui/button";
import { CodeBlock } from "@/src/components/ui/code-block";
import { Input, Select } from "@/src/components/ui/form-controls";
import { Icon } from "@/src/components/ui/icon";
import { Panel } from "@/src/components/ui/panel";
import { Skeleton } from "@/src/components/ui/skeleton";
import {
  dashboardExecutorClient,
  type ExecuteToolResponse,
  ExecutorApiError,
  type JsonValue,
} from "@/src/lib/api";
import type {
  CatalogToolkitSummary,
  CatalogToolkitView,
  CatalogToolView,
} from "@/src/lib/catalog";
import {
  loadCatalogToolkit,
  searchCatalogTools,
} from "@/src/lib/catalog-search";
import { cn } from "@/src/lib/cn";
import {
  buildSchemaFormFields,
  coerceSchemaFormValues,
  initialSchemaFormValues,
} from "@/src/lib/schema-form";

export interface ToolkitCatalogBrowserProps {
  initialCapability?: string;
  initialQuery?: string;
  initialToolkit?: string;
  initialTool?: string;
  project: string;
  toolkits: readonly CatalogToolkitSummary[];
}

interface RouteState {
  capability: string;
  query: string;
  toolkit?: string;
  tool?: string;
}

type TryItState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "success"; execution: ExecuteToolResponse }
  | {
      code: string;
      kind: "error" | "offline";
      message: string;
      payload: unknown;
    };

type ToolkitDetailState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; toolkit: CatalogToolkitView };

function toolkitInitials(displayName: string): string {
  const words = displayName.split(/[\s-]+/u).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}

function annotationLabels(
  tool: CatalogToolView,
): readonly { label: string; tone: string }[] {
  const labels: { label: string; tone: string }[] = [];
  if (tool.annotations.readOnly) {
    labels.push({ label: "readOnly", tone: "neutral" });
  }
  if (tool.annotations.destructive) {
    labels.push({ label: "destructive", tone: "error" });
  }
  if (tool.annotations.async) {
    labels.push({ label: "async", tone: "accent" });
  }
  return labels;
}

function readRouteState(): RouteState {
  const parameters = new URL(window.location.href).searchParams;
  const toolkit = parameters.get("toolkit") ?? undefined;
  const tool = parameters.get("tool") ?? undefined;
  return {
    capability: parameters.get("capability") ?? "all",
    query: parameters.get("q") ?? "",
    ...(toolkit === undefined ? {} : { toolkit }),
    ...(tool === undefined ? {} : { tool }),
  };
}

function ToolkitCard({
  onOpen,
  toolkit,
}: {
  onOpen: () => void;
  toolkit: CatalogToolkitSummary;
}) {
  return (
    <button className="toolkit-card" onClick={onOpen} type="button">
      <span className="toolkit-card__heading">
        <span aria-hidden="true" className="toolkit-mark">
          {toolkitInitials(toolkit.displayName)}
        </span>
        <span>
          <strong>{toolkit.displayName}</strong>
          <code>{toolkit.slug}</code>
        </span>
        <Icon name="arrowRight" />
      </span>
      <span className="toolkit-card__capabilities">
        {toolkit.capabilities.map((capability) => (
          <span className="meta-chip meta-chip--accent" key={capability.slug}>
            {capability.label}
          </span>
        ))}
      </span>
      <span className="toolkit-card__metadata">
        <span className="meta-chip">
          {toolkit.toolCount} {toolkit.toolCount === 1 ? "tool" : "tools"}
        </span>
        <span className="meta-chip mono">{toolkit.authClass}</span>
        <span className="meta-chip">{toolkit.sourceLabel}</span>
        <span className="meta-chip mono">{toolkit.tier}</span>
      </span>
    </button>
  );
}

function AuthRequirements({ toolkit }: { toolkit: CatalogToolkitView }) {
  return (
    <section className="inspector-section">
      <div className="inspector-section__heading">
        <h3>Auth requirements</h3>
        <span className="meta-chip mono">{toolkit.auth.class}</span>
      </div>
      {toolkit.auth.fields.length > 0 ? (
        <div className="auth-requirement">
          <span>Credential fields</span>
          <div>
            {toolkit.auth.fields.map((field) => (
              <code key={field}>{field}</code>
            ))}
          </div>
        </div>
      ) : null}
      <div className="auth-requirement">
        <span>Required scopes</span>
        {toolkit.auth.requiredScopes.length > 0 ? (
          <div>
            {toolkit.auth.requiredScopes.map((scope) => (
              <code key={scope}>{scope}</code>
            ))}
          </div>
        ) : (
          <p>No provider scopes required.</p>
        )}
      </div>
      {toolkit.auth.optionalScopes.length > 0 ? (
        <div className="auth-requirement">
          <span>Optional scopes</span>
          <div>
            {toolkit.auth.optionalScopes.map((scope) => (
              <code key={scope}>{scope}</code>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SchemaFieldControl({
  error,
  field,
  onChange,
  value,
}: {
  error?: string;
  field: ReturnType<typeof buildSchemaFormFields>[number];
  onChange: (value: boolean | string) => void;
  value: boolean | string | undefined;
}) {
  const label = `${field.label}${field.required ? " *" : ""}`;
  if (field.kind === "boolean") {
    return (
      <label className="schema-boolean">
        <input
          checked={Boolean(value)}
          onChange={(event) => onChange(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>
          <strong>{label}</strong>
          {field.description ? <small>{field.description}</small> : null}
        </span>
      </label>
    );
  }
  if (field.kind === "enum") {
    return (
      <Select
        {...(error === undefined ? {} : { error })}
        {...(field.description === undefined
          ? {}
          : { hint: field.description })}
        label={label}
        onChange={(event) => onChange(event.currentTarget.value)}
        options={[
          { label: "Select a value", value: "" },
          ...(field.enumValues ?? []).map((option) => ({
            label: String(option),
            value: String(option),
          })),
        ]}
        value={String(value ?? "")}
      />
    );
  }
  if (field.kind === "json") {
    return (
      <label className="field">
        <span className="field__label">{label}</span>
        <textarea
          aria-invalid={Boolean(error)}
          className="field__control schema-form__textarea mono"
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder='{"key": "value"}'
          rows={5}
          value={String(value ?? "")}
        />
        <span
          className={cn("field__message", error && "field__message--error")}
        >
          {error ?? field.description ?? "Objects and arrays accept JSON."}
        </span>
      </label>
    );
  }
  return (
    <Input
      {...(error === undefined ? {} : { error })}
      {...(field.description === undefined ? {} : { hint: field.description })}
      label={label}
      onChange={(event) => onChange(event.currentTarget.value)}
      type={
        field.kind === "number"
          ? "number"
          : field.format === "email"
            ? "email"
            : "text"
      }
      value={String(value ?? "")}
    />
  );
}

function TryItPanel({
  onSelectTool,
  selectedTool,
  toolkit,
}: {
  onSelectTool: (name: string) => void;
  selectedTool: CatalogToolView;
  toolkit: CatalogToolkitView;
}) {
  const fields = useMemo(
    () => buildSchemaFormFields(selectedTool.inputSchema),
    [selectedTool.inputSchema],
  );
  const [userId, setUserId] = useState("user_123");
  const [values, setValues] = useState<Record<string, boolean | string>>(() =>
    initialSchemaFormValues(fields),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<TryItState>({ kind: "idle" });

  useEffect(() => {
    setValues(initialSchemaFormValues(fields));
    setErrors({});
    setState({ kind: "idle" });
  }, [fields]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = coerceSchemaFormValues(fields, values);
    const nextErrors = { ...result.errors };
    if (userId.trim().length === 0) {
      nextErrors.userId = "External user ID is required.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setState({ kind: "running" });
    try {
      const execution = await dashboardExecutorClient().execute({
        input: result.value as Readonly<Record<string, JsonValue>>,
        mode: selectedTool.annotations.async ? "async" : "sync",
        tool: selectedTool.name,
        userId: userId.trim(),
      });
      if (execution.status === "failed") {
        setState({
          code: execution.error.code,
          kind: "error",
          message: execution.error.message,
          payload: execution,
        });
      } else {
        setState({ execution, kind: "success" });
      }
    } catch (error) {
      const apiError = error instanceof ExecutorApiError ? error : undefined;
      const offline = apiError?.status === 502 || apiError === undefined;
      setState({
        code: apiError?.code ?? "executor_unavailable",
        kind: offline ? "offline" : "error",
        message:
          apiError?.message ??
          "The configured executor could not be reached. Catalog inspection remains available.",
        payload:
          apiError === undefined
            ? { error: "executor offline" }
            : {
                error: {
                  code: apiError.code,
                  message: apiError.message,
                  retryable: apiError.retryable,
                },
                requestId: apiError.requestId,
              },
      });
    }
  }

  return (
    <section className="inspector-section try-it-panel">
      <div className="inspector-section__heading">
        <div>
          <p className="eyebrow">Mock executor</p>
          <h3>Try it</h3>
        </div>
        <span className="meta-chip meta-chip--accent">Development</span>
      </div>
      <p className="try-it-panel__note">
        Runs against the separately configured executor and its fixture vault.
        No provider base URL is sent from this form.
      </p>
      <form className="schema-form" onSubmit={submit}>
        <Select
          label="Canonical tool"
          onChange={(event) => onSelectTool(event.currentTarget.value)}
          options={toolkit.tools.map((tool) => ({
            label: tool.name,
            value: tool.name,
          }))}
          value={selectedTool.name}
        />
        <Input
          {...(errors.userId === undefined ? {} : { error: errors.userId })}
          hint="Maps to external_user_id in the dev vault."
          label="External user ID"
          mono
          onChange={(event) => setUserId(event.currentTarget.value)}
          value={userId}
        />
        {fields.length === 0 ? (
          <p className="schema-form__empty">
            This tool takes an empty input object.
          </p>
        ) : (
          fields.map((field) => (
            <SchemaFieldControl
              {...(errors[field.name] === undefined
                ? {}
                : { error: errors[field.name] })}
              field={field}
              key={field.name}
              onChange={(value) =>
                setValues((current) => ({ ...current, [field.name]: value }))
              }
              value={values[field.name]}
            />
          ))
        )}
        <Button
          disabled={state.kind === "running"}
          icon={<Icon name="activity" />}
          type="submit"
          variant="primary"
        >
          {state.kind === "running" ? "Running…" : "Run mock execution"}
        </Button>
      </form>
      {state.kind === "success" ? (
        <div className="try-result try-result--success" aria-live="polite">
          <div>
            <span className="taxonomy-badge">{state.execution.status}</span>
            <strong>Execution accepted</strong>
          </div>
          <CodeBlock
            code={JSON.stringify(state.execution, null, 2)}
            label="Execution response"
            language="json"
          />
        </div>
      ) : null}
      {state.kind === "error" || state.kind === "offline" ? (
        <div
          className={cn(
            "try-result",
            state.kind === "offline" && "try-result--offline",
          )}
          aria-live="polite"
        >
          <div>
            <span className="taxonomy-badge taxonomy-badge--error">
              {state.code}
            </span>
            <strong>
              {state.kind === "offline"
                ? "Executor offline"
                : "Execution failed"}
            </strong>
          </div>
          <p>{state.message}</p>
          <CodeBlock
            code={JSON.stringify(state.payload, null, 2)}
            label="Normalized error envelope"
            language="json"
          />
        </div>
      ) : null}
    </section>
  );
}

function ToolkitDrawer({
  children,
  onClose,
  toolkit,
}: {
  children: ReactNode;
  onClose: () => void;
  toolkit: CatalogToolkitSummary;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current
      ?.querySelector<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input, select, textarea',
      )
      ?.focus();
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    };
  }, []);

  return (
    <div
      aria-label={`${toolkit.displayName} toolkit inspector`}
      aria-modal="true"
      className="drawer-overlay"
      ref={dialogRef}
      role="dialog"
    >
      <button
        aria-label="Close toolkit inspector"
        className="drawer-overlay__backdrop"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <Panel
        className="toolkit-inspector"
        description={`${toolkit.slug} / ${toolkit.toolCount} canonical tools`}
        drawer
        onClose={onClose}
        onCloseLabel="Close toolkit inspector"
        title={toolkit.displayName}
      >
        {children}
      </Panel>
    </div>
  );
}

function ToolkitInspector({
  onClose,
  onSelectTool,
  selectedToolName,
  summary,
  toolkit,
}: {
  onClose: () => void;
  onSelectTool: (tool: string) => void;
  selectedToolName?: string;
  summary: CatalogToolkitSummary;
  toolkit: CatalogToolkitView;
}) {
  const selectedTool =
    toolkit.tools.find((tool) => tool.name === selectedToolName) ??
    toolkit.tools[0];

  return (
    <ToolkitDrawer onClose={onClose} toolkit={summary}>
      <div className="inspector-summary">
        <span className="meta-chip mono">{toolkit.tier}</span>
        <span className="meta-chip">{toolkit.sourceLabel}</span>
        {toolkit.capabilities.map((capability) => (
          <span className="meta-chip meta-chip--accent" key={capability.slug}>
            {capability.label}
          </span>
        ))}
      </div>
      <AuthRequirements toolkit={toolkit} />
      {selectedTool ? (
        <TryItPanel
          key={selectedTool.name}
          onSelectTool={onSelectTool}
          selectedTool={selectedTool}
          toolkit={toolkit}
        />
      ) : null}
      <section className="inspector-section">
        <div className="inspector-section__heading">
          <h3>Canonical tools</h3>
          <span className="meta-chip mono">{toolkit.tools.length}</span>
        </div>
        <div className="tool-schema-list">
          {toolkit.tools.map((tool) => (
            <details
              className="tool-schema"
              key={tool.name}
              onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => {
                if (event.currentTarget.open) onSelectTool(tool.name);
              }}
              open={tool.name === selectedTool?.name}
            >
              <summary>
                <span>
                  <code>{tool.name}</code>
                  <small>v{tool.version}</small>
                </span>
                <span className="tool-schema__annotations">
                  {annotationLabels(tool).map((annotation) => (
                    <span
                      className={cn(
                        "annotation-badge",
                        `annotation-badge--${annotation.tone}`,
                      )}
                      key={annotation.label}
                    >
                      {annotation.label}
                    </span>
                  ))}
                </span>
              </summary>
              <div className="tool-schema__body">
                <p>{tool.description}</p>
                <CodeBlock
                  code={JSON.stringify(tool.inputSchema, null, 2)}
                  label={`${tool.name} input schema`}
                  language="json schema / input"
                />
                {tool.outputSchema ? (
                  <CodeBlock
                    code={JSON.stringify(tool.outputSchema, null, 2)}
                    label={`${tool.name} output schema`}
                    language="json schema / output"
                  />
                ) : null}
              </div>
            </details>
          ))}
        </div>
      </section>
    </ToolkitDrawer>
  );
}

function ToolkitInspectorState({
  detailState,
  onClose,
  onRetry,
  toolkit,
}: {
  detailState: Extract<ToolkitDetailState, { kind: "error" | "loading" }>;
  onClose: () => void;
  onRetry: () => void;
  toolkit: CatalogToolkitSummary;
}) {
  return (
    <ToolkitDrawer onClose={onClose} toolkit={toolkit}>
      <div aria-live="polite" className="toolkit-inspector-state">
        {detailState.kind === "loading" ? (
          <>
            <Skeleton
              height={24}
              label="Toolkit metadata loading"
              width="64%"
            />
            <Skeleton height={132} label="Toolkit auth loading" />
            <Skeleton height={280} label="Toolkit schemas loading" />
          </>
        ) : (
          <div className="filtered-empty">
            <Icon name="activity" />
            <h2>Toolkit detail could not be loaded</h2>
            <p>
              The catalog grid remains available. Retry the local schema request
              without losing this selection.
            </p>
            <Button onClick={onRetry} variant="secondary">
              Retry detail
            </Button>
          </div>
        )}
      </div>
    </ToolkitDrawer>
  );
}

export function ToolkitCatalogBrowser({
  initialCapability = "all",
  initialQuery = "",
  initialToolkit,
  initialTool,
  project: _project,
  toolkits,
}: ToolkitCatalogBrowserProps) {
  const initialToolkitRecord = toolkits.find(
    (toolkit) => toolkit.slug === initialToolkit,
  );
  const [query, setQuery] = useState(initialQuery);
  const deferredQuery = useDeferredValue(query);
  const [capability, setCapability] = useState(initialCapability);
  const [selectedToolkitSlug, setSelectedToolkitSlug] = useState(
    initialToolkitRecord?.slug,
  );
  const [selectedToolName, setSelectedToolName] = useState(initialTool);
  const [matchedToolkitSlugs, setMatchedToolkitSlugs] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [detailState, setDetailState] = useState<ToolkitDetailState>(
    initialToolkitRecord === undefined ? { kind: "idle" } : { kind: "loading" },
  );
  const [detailRequest, setDetailRequest] = useState(0);
  const [searchPending, setSearchPending] = useState(false);
  const detailCacheRef = useRef(new Map<string, CatalogToolkitView>());
  const inspectorTriggerRef = useRef<HTMLElement | null>(null);

  const capabilities = useMemo(() => {
    const values = new Map<string, string>();
    for (const toolkit of toolkits) {
      for (const item of toolkit.capabilities)
        values.set(item.slug, item.label);
    }
    return [...values.entries()]
      .map(([slug, label]) => ({ label, slug }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [toolkits]);

  useEffect(() => {
    const normalized = deferredQuery.trim();
    if (normalized.length === 0) {
      setMatchedToolkitSlugs(new Set());
      setSearchPending(false);
      return;
    }
    let active = true;
    setSearchPending(true);
    const controller = new AbortController();
    searchCatalogTools(normalized, controller.signal)
      .then((tools) => {
        if (active)
          setMatchedToolkitSlugs(new Set(tools.map((tool) => tool.toolkit)));
      })
      .catch(() => {
        if (active && !controller.signal.aborted)
          setMatchedToolkitSlugs(new Set());
      })
      .finally(() => {
        if (active) setSearchPending(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [deferredQuery]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: detailRequest is an explicit retry trigger after a failed detail fetch.
  useEffect(() => {
    if (selectedToolkitSlug === undefined) {
      setDetailState({ kind: "idle" });
      return;
    }
    const cached = detailCacheRef.current.get(selectedToolkitSlug);
    if (cached !== undefined) {
      setDetailState({ kind: "ready", toolkit: cached });
      return;
    }
    let active = true;
    const controller = new AbortController();
    setDetailState({ kind: "loading" });
    loadCatalogToolkit(selectedToolkitSlug, controller.signal)
      .then((toolkit) => {
        if (!active) return;
        detailCacheRef.current.set(toolkit.slug, toolkit);
        setDetailState({ kind: "ready", toolkit });
      })
      .catch(() => {
        if (active && !controller.signal.aborted)
          setDetailState({ kind: "error" });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [detailRequest, selectedToolkitSlug]);

  useEffect(() => {
    function restoreRouteState() {
      const routeState = readRouteState();
      const toolkit = toolkits.find(
        (candidate) => candidate.slug === routeState.toolkit,
      );
      setQuery(routeState.query);
      setCapability(routeState.capability);
      setSelectedToolkitSlug(toolkit?.slug);
      setSelectedToolName(routeState.tool);
    }
    window.addEventListener("popstate", restoreRouteState);
    return () => window.removeEventListener("popstate", restoreRouteState);
  }, [toolkits]);

  const writeRouteState = useCallback((state: RouteState, push: boolean) => {
    const url = new URL(window.location.href);
    const values = {
      capability: state.capability === "all" ? undefined : state.capability,
      q: state.query.length === 0 ? undefined : state.query,
      tool: state.tool,
      toolkit: state.toolkit,
    };
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    window.history[push ? "pushState" : "replaceState"]({}, "", url);
  }, []);

  function openInspector(toolkit: CatalogToolkitSummary) {
    inspectorTriggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSelectedToolkitSlug(toolkit.slug);
    setSelectedToolName(undefined);
    writeRouteState({ capability, query, toolkit: toolkit.slug }, true);
  }

  const closeInspector = useCallback(() => {
    setSelectedToolkitSlug(undefined);
    setSelectedToolName(undefined);
    writeRouteState({ capability, query }, true);
    window.requestAnimationFrame(() => inspectorTriggerRef.current?.focus());
  }, [capability, query, writeRouteState]);

  useEffect(() => {
    if (selectedToolkitSlug === undefined) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeInspector();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeInspector, selectedToolkitSlug]);

  function selectTool(tool: string) {
    setSelectedToolName(tool);
    writeRouteState(
      {
        capability,
        query,
        ...(selectedToolkitSlug === undefined
          ? {}
          : { toolkit: selectedToolkitSlug }),
        tool,
      },
      false,
    );
  }

  const visibleToolkits = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
    return toolkits.filter((toolkit) => {
      if (
        capability !== "all" &&
        !toolkit.capabilities.some((item) => item.slug === capability)
      ) {
        return false;
      }
      if (normalizedQuery.length === 0) return true;
      const directMatch = [
        toolkit.displayName,
        toolkit.slug,
        toolkit.authClass,
        toolkit.sourceLabel,
        ...toolkit.capabilities.flatMap((item) => [item.label, item.slug]),
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
      return directMatch || matchedToolkitSlugs.has(toolkit.slug);
    });
  }, [capability, deferredQuery, matchedToolkitSlugs, toolkits]);

  const selectedToolkit = toolkits.find(
    (toolkit) => toolkit.slug === selectedToolkitSlug,
  );

  return (
    <div className="page-stack catalog-page">
      <PageHeader
        description="Search the local registry, inspect canonical schemas and auth, then exercise deterministic development mocks through the configured executor."
        eyebrow="Capability catalog"
        title="Toolkits"
      />
      <section
        aria-label="Toolkit catalog controls"
        className="catalog-controls"
      >
        <label className="catalog-search">
          <Icon name="search" />
          <span className="visually-hidden">Search toolkits and tools</span>
          <input
            onChange={(event) => {
              const nextQuery = event.currentTarget.value;
              setQuery(nextQuery);
              writeRouteState(
                {
                  capability,
                  query: nextQuery,
                  ...(selectedToolkitSlug
                    ? { toolkit: selectedToolkitSlug }
                    : {}),
                  ...(selectedToolName ? { tool: selectedToolName } : {}),
                },
                false,
              );
            }}
            placeholder="Search toolkits, tools, or capabilities…"
            type="search"
            value={query}
          />
          {searchPending ? (
            <span className="catalog-search__status">Searching</span>
          ) : null}
        </label>
        <fieldset className="filter-pills">
          <legend className="visually-hidden">Filter by capability</legend>
          <button
            aria-pressed={capability === "all"}
            className="filter-pill"
            onClick={() => {
              setCapability("all");
              writeRouteState(
                {
                  capability: "all",
                  query,
                  ...(selectedToolkitSlug
                    ? { toolkit: selectedToolkitSlug }
                    : {}),
                  ...(selectedToolName ? { tool: selectedToolName } : {}),
                },
                true,
              );
            }}
            type="button"
          >
            All
          </button>
          {capabilities.map((item) => (
            <button
              aria-pressed={capability === item.slug}
              className="filter-pill"
              key={item.slug}
              onClick={() => {
                setCapability(item.slug);
                writeRouteState(
                  {
                    capability: item.slug,
                    query,
                    ...(selectedToolkitSlug
                      ? { toolkit: selectedToolkitSlug }
                      : {}),
                    ...(selectedToolName ? { tool: selectedToolName } : {}),
                  },
                  true,
                );
              }}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </fieldset>
      </section>
      <section aria-live="polite" className="catalog-results">
        <div className="catalog-results__heading">
          <div>
            <p className="eyebrow">Available toolkits</p>
            <h2>{visibleToolkits.length} local integrations</h2>
          </div>
          <span className="catalog-results__note">
            BM25 tool search / local catalog
          </span>
        </div>
        {visibleToolkits.length > 0 ? (
          <div className="toolkit-grid">
            {visibleToolkits.map((toolkit) => (
              <ToolkitCard
                key={toolkit.slug}
                onOpen={() => openInspector(toolkit)}
                toolkit={toolkit}
              />
            ))}
          </div>
        ) : (
          <div className="filtered-empty">
            <Icon name="search" />
            <h2>No toolkits match these filters</h2>
            <p>
              Clear the search and capability filter to restore the catalog.
            </p>
            <Button
              onClick={() => {
                setQuery("");
                setCapability("all");
                writeRouteState({ capability: "all", query: "" }, false);
              }}
              variant="secondary"
            >
              Clear filters
            </Button>
          </div>
        )}
      </section>
      {selectedToolkit ? (
        detailState.kind === "ready" ? (
          <ToolkitInspector
            onClose={closeInspector}
            onSelectTool={selectTool}
            {...(selectedToolName === undefined ? {} : { selectedToolName })}
            summary={selectedToolkit}
            toolkit={detailState.toolkit}
          />
        ) : (
          <ToolkitInspectorState
            detailState={
              detailState.kind === "error" ? detailState : { kind: "loading" }
            }
            onClose={closeInspector}
            onRetry={() => setDetailRequest((current) => current + 1)}
            toolkit={selectedToolkit}
          />
        )
      ) : null}
    </div>
  );
}
